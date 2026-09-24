// End-to-end cron runs against stubbed Steam and Slack and an in-memory Redis.
const test = require('node:test');
const assert = require('node:assert');

process.env.STEAM_API_KEY = 'test';
process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/x';
process.env.STORE_THROTTLE_MS = '0';

const RedisMock = require('ioredis-mock');
const store = require('../src/store');
const steam = require('../src/steam');
const slack = require('../src/slack');
const tracker = require('../src/tracker');
const { trackedRows } = require('../src/dashboard');

store.setClient(new RedisMock());

let appList = [{ appid: 10, name: 'Old Game' }];
const details = {};
const followers = {};
const pings = [];
const detailCalls = [];

steam.getAppList = async () => appList;
steam.getAppDetails = async (appid) => {
  detailCalls.push(appid);
  return details[appid] ? { ok: true, data: details[appid] } : { ok: false };
};
steam.getFollowerCount = async (appid) => followers[appid] ?? 0;
slack.post = async (payload) => pings.push(payload);

const game = (name, dev, pub, extra = {}) => ({
  type: 'game',
  name,
  developers: [dev],
  publishers: [pub],
  release_date: { coming_soon: true, date: 'Coming soon' },
  ...extra,
});

const app = (id) => store.getApp(id);
const makeDue = async (...ids) => {
  for (const id of ids) await store.schedule(store.K.followers, id, 0);
};

test('end to end: only the self-published, demo-less, fast-growing page pings', async () => {
  const first = await tracker.run();
  assert.strictEqual(first.newApps, 0); // bootstrap run

  appList = appList.concat([
    { appid: 20, name: 'Indie Hit' },
    { appid: 21, name: 'Published Hit' },
    { appid: 22, name: 'Demo Hit' },
    { appid: 23, name: 'Slow Indie' },
    { appid: 24, name: 'Some DLC' },
    { appid: 25, name: 'Hidden' },
  ]);
  details[20] = game('Indie Hit', 'Solo Dev', 'Solo Dev');
  details[21] = game('Published Hit', 'Solo Dev 2', 'Big Pub');
  details[22] = game('Demo Hit', 'Solo Dev 3', 'Solo Dev 3', { demos: [{ appid: 220 }] });
  details[220] = { type: 'demo', name: 'Demo', release_date: { coming_soon: false } };
  details[23] = game('Slow Indie', 'Solo Dev 4', 'Solo Dev 4');
  details[24] = { type: 'dlc', name: 'Some DLC' };
  Object.assign(followers, { 20: 40, 21: 40, 22: 40, 23: 40 });

  const second = await tracker.run();
  assert.strictEqual(second.newApps, 6);
  assert.strictEqual(second.classified, 5);
  assert.strictEqual(second.followersChecked, 2); // only 20 and 23 match criteria 2 and 3
  assert.deepStrictEqual(second.queues, { pending: 1, followers: 2, recheck: 2, tracked: 4 });
  assert.strictEqual((await app(24)).status, 'ignored');
  assert.strictEqual((await app(25)).status, 'pending');
  assert.ok((await app(22)).demos[0].released);
  assert.strictEqual(pings.length, 0);

  Object.assign(followers, { 20: 160, 21: 160, 22: 160, 23: 100 });
  await makeDue(20, 23);
  const third = await tracker.run();
  assert.strictEqual(third.pinged, 1);
  assert.strictEqual(pings.length, 1);
  assert.match(pings[0].text, /Indie Hit/);
  assert.ok((await app(20)).notifiedAt);

  // Never pings twice: a notified page leaves the follower queue.
  await tracker.run();
  assert.strictEqual(pings.length, 1);

  const rows = await trackedRows();
  assert.strictEqual(rows.games.length, 4);
  assert.strictEqual(rows.games.find((g) => g.appid === 20).notifiedAt, (await app(20)).notifiedAt);
});

test('a demo released since the page was found blocks the ping', async () => {
  appList = appList.concat([{ appid: 30, name: 'Late Demo' }]);
  details[30] = game('Late Demo', 'Dev', 'Dev');
  followers[30] = 10;
  await tracker.run();
  assert.ok((await app(30)).candidate);

  details[30] = game('Late Demo', 'Dev', 'Dev', { demos: [{ appid: 300 }] });
  details[300] = { type: 'demo', name: 'Late Demo Demo', release_date: { coming_soon: false } };
  followers[30] = 500;
  await makeDue(30);
  await tracker.run();

  assert.strictEqual(pings.length, 1);
  const a = await app(30);
  assert.ok(!a.notifiedAt);
  assert.strictEqual(a.candidate, false);
});

test('a page that drops its publisher starts being watched after a recheck', async () => {
  details[21] = game('Published Hit', 'Solo Dev 2', 'Solo Dev 2');
  await store.schedule(store.K.recheck, 21, 0);
  followers[21] = 400;
  await tracker.run();
  // Its first follower read (400, measured from 0 at appearance) qualifies.
  assert.strictEqual(pings.length, 2);
  assert.match(pings[1].text, /Published Hit/);
});

test('an overlapping run is skipped', async () => {
  await store.redis().set(store.K.lock, '1');
  assert.deepStrictEqual(await tracker.run(), { skipped: 'another run is in progress' });
  await store.redis().del(store.K.lock);
});

test('pages leave the queues once their 14 days are up', async () => {
  const old = await app(23);
  await store.schedule(store.K.tracked, 23, Date.now() - 15 * 24 * 3600 * 1000);
  await store.saveApp({ ...old, appearedAt: Date.now() - 15 * 24 * 3600 * 1000 });
  const result = await tracker.run();
  assert.strictEqual(result.expired, 1);
  assert.strictEqual(await store.redis().zscore(store.K.followers, 23), null);
});

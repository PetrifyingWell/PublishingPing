// End-to-end run of the tracker against a stubbed Steam and Slack, using a
// throwaway database.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'publishingping-test-'));
process.env.STEAM_API_KEY = 'test';
process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/x';

const steam = require('../src/steam');
const slack = require('../src/slack');
const db = require('../src/db');
const tracker = require('../src/tracker');

let appList = [{ appid: 10, name: 'Old Game' }];
const details = {};
const followers = {};
const pings = [];

steam.getAppList = async () => appList;
steam.getAppDetails = async (appid) => (details[appid] ? { ok: true, data: details[appid] } : { ok: false });
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

test('end to end: only the self-published, demo-less, fast-growing page pings', async () => {
  await tracker.syncAppList(); // bootstrap
  assert.strictEqual(db.counts().pending, undefined);

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

  await tracker.syncAppList();
  await tracker.classifyPending();

  const counts = db.counts();
  assert.strictEqual(counts.tracking, 4);
  assert.strictEqual(counts.ignored, 1);
  assert.strictEqual(counts.pending, 1); // 25 not public yet
  assert.ok(db.getApp(22).demos[0].released);

  Object.assign(followers, { 20: 40, 21: 40, 22: 40, 23: 40 });
  await tracker.pollFollowers();
  assert.strictEqual(pings.length, 0);

  Object.assign(followers, { 20: 160, 21: 160, 22: 160, 23: 100 });
  for (const id of [20, 21, 22, 23]) db.updateApp(id, { next_follower_check_at: 0 });
  await tracker.pollFollowers();

  assert.strictEqual(pings.length, 1);
  assert.match(pings[0].text, /Indie Hit/);
  assert.ok(db.getApp(20).notified_at);

  // Never pings twice.
  db.updateApp(20, { next_follower_check_at: 0 });
  await tracker.pollFollowers();
  assert.strictEqual(pings.length, 1);
});

test('a demo released since the last details check blocks the ping', async () => {
  appList = appList.concat([{ appid: 30, name: 'Late Demo' }]);
  details[30] = game('Late Demo', 'Dev', 'Dev');
  await tracker.syncAppList();
  await tracker.classifyPending();
  assert.ok(tracker.isCandidate(db.getApp(30)));

  details[30] = game('Late Demo', 'Dev', 'Dev', { demos: [{ appid: 300 }] });
  details[300] = { type: 'demo', name: 'Late Demo Demo', release_date: { coming_soon: false } };
  followers[30] = 500;
  db.updateApp(30, { next_follower_check_at: 0 });
  await tracker.pollFollowers();

  assert.strictEqual(pings.length, 1);
  assert.ok(!db.getApp(30).notified_at);
});

// Reddit check against a stubbed Reddit API, Slack and an in-memory Redis.
const test = require('node:test');
const assert = require('node:assert');

process.env.REDDIT_CLIENT_ID = 'id';
process.env.REDDIT_CLIENT_SECRET = 'secret';
process.env.REDDIT_SUBREDDITS = 'IndieGaming:500, r/indiegames:100';

const RedisMock = require('ioredis-mock');
const store = require('../src/store');
const slack = require('../src/slack');
const reddit = require('../src/reddit');

store.setClient(new RedisMock());
const pings = [];
slack.post = async (payload) => pings.push(payload);

const now = Date.now() / 1000;
const post = (id, score, extra = {}) => ({
  name: `t3_${id}`,
  title: `Post ${id}`,
  score,
  num_comments: 12,
  author: 'dev',
  created_utc: now - 3600,
  permalink: `/r/x/comments/${id}/post/`,
  thumbnail: 'self',
  ...extra,
});

// Listing contents per subreddit, sorted by score like Reddit's /top.
const listings = { IndieGaming: [], indiegames: [] };
const requests = [];

global.fetch = async (url, init) => {
  requests.push(String(url));
  const json = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  if (String(url).includes('/access_token')) {
    assert.match(init.headers.Authorization, /^Basic /);
    return json({ access_token: 'tok', expires_in: 3600 });
  }
  const sub = String(url).match(/\/r\/([^/]+)\/top/)[1];
  assert.strictEqual(init.headers.Authorization, 'Bearer tok');
  const children = [...listings[sub]].sort((a, b) => b.score - a.score).map((data) => ({ data }));
  return json({ data: { children, after: null } });
};

test('parses subreddit thresholds', () => {
  assert.deepStrictEqual(reddit.parseSubreddits('IndieGaming:500, r/indiegames:100'), [
    { name: 'IndieGaming', threshold: 500 },
    { name: 'indiegames', threshold: 100 },
  ]);
  assert.throws(() => reddit.parseSubreddits('IndieGaming'), /should look like/);
});

test('first check records posts already over the threshold without pinging', async () => {
  listings.IndieGaming = [post('a', 900), post('b', 200)];
  listings.indiegames = [post('c', 150)];
  const result = await reddit.run(() => {});
  assert.deepStrictEqual(result, { pinged: 0, errors: 0 });
  assert.strictEqual(pings.length, 0);
  assert.deepStrictEqual((await reddit.recentPosts()).map((p) => p.id).sort(), ['t3_a', 't3_c']);
});

test('pings each post once when it passes its subreddit threshold', async () => {
  listings.IndieGaming = [
    post('a', 1200),
    post('b', 520, { url_overridden_by_dest: 'https://store.steampowered.com/app/123/Game/' }),
    post('d', 499),
    post('e', 5000, { stickied: true }),
    post('f', 5000, { over_18: true }),
  ];
  listings.indiegames = [post('c', 160), post('g', 101)];

  const result = await reddit.run(() => {});
  assert.deepStrictEqual(result, { pinged: 2, errors: 0 });
  assert.deepStrictEqual(pings.map((p) => p.text), [
    'r/IndieGaming: "Post b" passed 500 upvotes',
    'r/indiegames: "Post g" passed 100 upvotes',
  ]);
  const buttons = pings[0].blocks[1].elements.map((e) => e.text.text);
  assert.deepStrictEqual(buttons, ['Reddit post', 'Steam page']);

  // Running again doesn't re-ping, but keeps scores current.
  listings.IndieGaming[1] = post('b', 800);
  await reddit.run(() => {});
  assert.strictEqual(pings.length, 2);
  assert.strictEqual((await reddit.recentPosts()).find((p) => p.id === 't3_b').score, 800);
});

test('one failing subreddit does not stop the others', async () => {
  listings.indiegames.push(post('h', 300));
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).includes('/r/IndieGaming/')) return { ok: false, status: 503, text: async () => 'down' };
    return realFetch(url, init);
  };
  const lines = [];
  const result = await reddit.run((l) => lines.push(l));
  global.fetch = realFetch;
  assert.deepStrictEqual(result, { pinged: 1, errors: 1 });
  assert.match(lines[0], /r\/IndieGaming.*HTTP 503/);
});

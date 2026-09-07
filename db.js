const { Redis } = require('@upstash/redis');

// Supports both the older Vercel KV env var names and the Upstash
// marketplace integration's names, since either could be what's wired up
// in the Vercel project depending on which storage integration was added.
const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

const GAMES_KEY = 'steam-publishing-list:games'; // hash: appid -> JSON game record
const KNOWN_APPIDS_KEY = 'steam-publishing-list:knownAppIds'; // set: appid
const PENDING_KEY = 'steam-publishing-list:pendingClassification'; // hash: appid -> discoveredAt ISO string

// --- App ID ledger: every appid we've ever observed in Steam's full app
// list, regardless of whether it turned out to be a game worth tracking.
// This is what lets us detect "just appeared on Steam" via diffing.

async function getKnownAppIdSet() {
  const members = await redis.smembers(KNOWN_APPIDS_KEY);
  return new Set(members);
}

async function isBootstrapped() {
  const count = await redis.scard(KNOWN_APPIDS_KEY);
  return count > 0;
}

async function addKnownAppIds(appids) {
  if (appids.length === 0) return;
  await redis.sadd(KNOWN_APPIDS_KEY, ...appids);
}

// --- Classification queue: newly-diffed appids waiting on an appdetails +
// tag lookup to determine whether they're a real, unreleased game. Each
// entry remembers when it was *discovered* (diffed as new), independent of
// how long it then waits in the queue for its Steam calls to run.

async function getPendingQueue() {
  const map = (await redis.hgetall(PENDING_KEY)) || {};
  return Object.entries(map).map(([appid, discoveredAt]) => ({ appid, discoveredAt }));
}

async function enqueuePending(appids) {
  const now = new Date().toISOString();
  // hsetnx so an appid already in the queue keeps its original discovery
  // time rather than getting bumped forward on a later diff.
  await Promise.all(appids.map((id) => redis.hsetnx(PENDING_KEY, id, now)));
}

async function dequeuePending(appid) {
  await redis.hdel(PENDING_KEY, appid);
}

// --- Tracked games: appids that classified as real, unreleased games.

async function createGame(appid, details, firstSeenAt) {
  const record = {
    appid,
    firstSeenAt: firstSeenAt || new Date().toISOString(),
    status: 'new',
    viewedAt: null,
    details,
  };
  await redis.hset(GAMES_KEY, { [appid]: JSON.stringify(record) });
  return record;
}

async function setStatus(appid, status) {
  const game = await getGame(appid);
  if (!game) return null;
  game.status = status;
  game.viewedAt = status === 'new' ? null : new Date().toISOString();
  await redis.hset(GAMES_KEY, { [appid]: JSON.stringify(game) });
  return game;
}

async function getGame(appid) {
  const raw = await redis.hget(GAMES_KEY, appid);
  if (!raw) return null;
  // The Upstash client sometimes auto-parses JSON values already; handle both.
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function all() {
  const map = (await redis.hgetall(GAMES_KEY)) || {};
  const games = [];
  for (const raw of Object.values(map)) {
    try {
      const game = typeof raw === 'string' ? JSON.parse(raw) : raw;
      // Filters out any record missing details - defends against stale/
      // incompatible entries left behind by an older version of this schema.
      if (game && game.details) games.push(game);
    } catch {
      // Skip anything that isn't valid JSON rather than failing the whole list.
    }
  }
  return games;
}

module.exports = {
  getKnownAppIdSet,
  isBootstrapped,
  addKnownAppIds,
  getPendingQueue,
  enqueuePending,
  dequeuePending,
  createGame,
  setStatus,
  getGame,
  all,
};

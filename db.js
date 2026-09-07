const { Redis } = require('@upstash/redis');

// Supports both the older Vercel KV env var names and the Upstash
// marketplace integration's names, since either could be what's wired up
// in the Vercel project depending on which storage integration was added.
// Built lazily (and with an explicit check) rather than at module load, so
// a missing/misscoped env var produces a clear, actionable error message
// instead of the Upstash SDK's cryptic "Failed to parse URL from /pipeline"
// when it tries to build a request against an empty base URL.
let redisClient = null;

function getRedisClient() {
  if (redisClient) return redisClient;

  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      'Redis is not configured: no KV_REST_API_URL/KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN ' +
        'environment variables found. Connect a Redis database to this Vercel project (Storage tab), confirm those ' +
        "variables are enabled for this deployment's environment (Production/Preview/Development), then redeploy."
    );
  }

  redisClient = new Redis({ url, token });
  return redisClient;
}

const GAMES_KEY = 'steam-publishing-list:games'; // hash: appid -> JSON game record
const KNOWN_APPIDS_KEY = 'steam-publishing-list:knownAppIds'; // set: appid
const PENDING_KEY = 'steam-publishing-list:pendingClassification'; // hash: appid -> discoveredAt ISO string

// --- App ID ledger: every appid we've ever observed in Steam's full app
// list, regardless of whether it turned out to be a game worth tracking.
// This is what lets us detect "just appeared on Steam" via diffing.

async function getKnownAppIdSet() {
  const members = await getRedisClient().smembers(KNOWN_APPIDS_KEY);
  return new Set(members);
}

async function isBootstrapped() {
  const count = await getRedisClient().scard(KNOWN_APPIDS_KEY);
  return count > 0;
}

async function addKnownAppIds(appids) {
  if (appids.length === 0) return;
  await getRedisClient().sadd(KNOWN_APPIDS_KEY, ...appids);
}

// --- Classification queue: newly-diffed appids waiting on an appdetails +
// tag lookup to determine whether they're a real, unreleased game. Each
// entry remembers when it was *discovered* (diffed as new), independent of
// how long it then waits in the queue for its Steam calls to run.

async function getPendingQueue() {
  const map = (await getRedisClient().hgetall(PENDING_KEY)) || {};
  return Object.entries(map).map(([appid, discoveredAt]) => ({ appid, discoveredAt }));
}

async function enqueuePending(appids) {
  const now = new Date().toISOString();
  // hsetnx so an appid already in the queue keeps its original discovery
  // time rather than getting bumped forward on a later diff.
  await Promise.all(appids.map((id) => getRedisClient().hsetnx(PENDING_KEY, id, now)));
}

async function dequeuePending(appid) {
  await getRedisClient().hdel(PENDING_KEY, appid);
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
  await getRedisClient().hset(GAMES_KEY, { [appid]: JSON.stringify(record) });
  return record;
}

async function setStatus(appid, status) {
  const game = await getGame(appid);
  if (!game) return null;
  game.status = status;
  game.viewedAt = status === 'new' ? null : new Date().toISOString();
  await getRedisClient().hset(GAMES_KEY, { [appid]: JSON.stringify(game) });
  return game;
}

async function getGame(appid) {
  const raw = await getRedisClient().hget(GAMES_KEY, appid);
  if (!raw) return null;
  // The Upstash client sometimes auto-parses JSON values already; handle both.
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function all() {
  const map = (await getRedisClient().hgetall(GAMES_KEY)) || {};
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

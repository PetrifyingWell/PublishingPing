const Redis = require('ioredis');
const config = require('./config');

// Created lazily and reused across invocations of a warm function.
let client = null;

function redis() {
  if (client) return client;
  if (!config.redisUrl) {
    // Names only, never values, so this is safe to show in logs.
    const seen = Object.keys(process.env).filter((k) => /REDIS|KV_|UPSTASH/.test(k));
    throw new Error(
      'No Redis connection URL found (looked for REDIS_URL, KV_URL, or any *_REDIS_URL / *_KV_URL holding a ' +
        `redis:// or rediss:// URL). Redis-related variables this deployment can see: ${seen.join(', ') || 'none'}. ` +
        `Environment: ${process.env.VERCEL_ENV || 'local'}. If REDIS_URL is listed, its value doesn't start with ` +
        'redis:// or rediss:// (an https:// REST URL won\'t work). Otherwise connect a Redis database in the Vercel Storage tab, ` +
        "enable it for this environment, then redeploy."
    );
  }
  client = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
  client.on('error', (err) => console.error('Redis error:', err.message));
  return client;
}

// Lets tests swap in ioredis-mock.
function setClient(c) {
  client = c;
}

const K = {
  known: 'pp:known', // set: every appid ever seen in Steam's app list
  meta: 'pp:meta', // hash
  lock: 'pp:lock', // held while a cron run is in progress
  app: (id) => `pp:app:${id}`, // JSON record per new page
  pending: 'pp:q:pending', // zset appid -> next attempt at (store data not fetched yet)
  followers: 'pp:q:followers', // zset appid -> next follower read at (candidates only)
  recheck: 'pp:q:recheck', // zset appid -> next details re-read at (non-candidates only)
  tracked: 'pp:tracked', // zset appid -> appearedAt (every tracked game, for the dashboard)
};

const CHUNK = 5000; // spreading ~200k appids in one command blows V8's argument limit

async function getMeta(field) {
  return redis().hget(K.meta, field);
}

async function setMeta(field, value) {
  await redis().hset(K.meta, field, String(value));
}

async function knownAppIds() {
  return new Set((await redis().smembers(K.known)).map(Number));
}

async function addKnown(appids) {
  for (let i = 0; i < appids.length; i += CHUNK) await redis().sadd(K.known, ...appids.slice(i, i + CHUNK));
}

async function getApp(appid) {
  const raw = await redis().get(K.app(appid));
  return raw ? JSON.parse(raw) : null;
}

async function getApps(appids) {
  if (appids.length === 0) return [];
  const raws = await redis().mget(...appids.map(K.app));
  return raws.filter(Boolean).map((r) => JSON.parse(r));
}

async function saveApp(app) {
  await redis().set(K.app(app.appid), JSON.stringify(app), 'PX', config.retentionMs);
}

async function due(queue, now, limit) {
  return (await redis().zrangebyscore(queue, '-inf', now, 'LIMIT', 0, limit)).map(Number);
}

async function schedule(queue, appid, at) {
  await redis().zadd(queue, at, appid);
}

async function unschedule(queue, appid) {
  await redis().zrem(queue, appid);
}

async function trackedSince(since) {
  return (await redis().zrangebyscore(K.tracked, since, '+inf')).map(Number);
}

// Drops pages whose tracking window has ended from every work queue.
async function expireTracked(before) {
  const ids = await redis().zrangebyscore(K.tracked, '-inf', `(${before}`);
  if (ids.length === 0) return 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    await redis().zrem(K.followers, ...chunk);
    await redis().zrem(K.recheck, ...chunk);
    await redis().zrem(K.tracked, ...chunk);
  }
  return ids.length;
}

async function queueSizes() {
  const [pending, followers, recheck, tracked] = await Promise.all(
    [K.pending, K.followers, K.recheck, K.tracked].map((k) => redis().zcard(k))
  );
  return { pending, followers, recheck, tracked };
}

module.exports = {
  K,
  redis,
  setClient,
  getMeta,
  setMeta,
  knownAppIds,
  addKnown,
  getApp,
  getApps,
  saveApp,
  due,
  schedule,
  unschedule,
  trackedSince,
  expireTracked,
  queueSizes,
};

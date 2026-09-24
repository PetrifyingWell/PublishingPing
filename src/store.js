const Redis = require('ioredis');
const config = require('./config');

// Created lazily and reused across invocations of a warm function.
let client = null;

function redis() {
  if (client) return client;
  if (!config.redisUrl) {
    throw new Error(
      'REDIS_URL is not set. Connect a Redis database to this Vercel project (Storage tab), make sure REDIS_URL ' +
        "is enabled for this deployment's environment, then redeploy."
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

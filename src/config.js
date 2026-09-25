const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function num(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

// Vercel's Redis integrations name this variable differently depending on
// the provider and on any custom prefix chosen when connecting the store
// (REDIS_URL, KV_URL, STORAGE_REDIS_URL, ...). Take the first that holds a
// redis:// or rediss:// URL.
function findRedisUrl() {
  const isRedis = (v) => /^rediss?:\/\//.test(v || '');
  for (const name of ['REDIS_URL', 'KV_URL']) if (isRedis(process.env[name])) return process.env[name];
  for (const [name, value] of Object.entries(process.env)) {
    if (/(REDIS|KV)_URL$/.test(name) && isRedis(value)) return value;
  }
  return '';
}

module.exports = {
  MINUTE,
  HOUR,
  DAY,

  steamApiKey: process.env.STEAM_API_KEY || '',
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
  redisUrl: findRedisUrl(),
  cronSecret: process.env.CRON_SECRET || '',

  // The criteria.
  trackingWindowMs: num('TRACKING_WINDOW_DAYS', 14) * DAY,
  gainWindowMs: num('GAIN_WINDOW_DAYS', 5) * DAY,
  followerGainThreshold: num('FOLLOWER_GAIN_THRESHOLD', 50),
  excludeNsfw: bool('EXCLUDE_NSFW', true),

  // Pages that match criteria 2 and 3 get their followers read this often.
  // Each cron run reads every page that is due, so this is effectively
  // "every cron run" unless set higher than the cron schedule.
  followerIntervalMs: num('FOLLOWER_INTERVAL_HOURS', 1) * HOUR,
  // Pages that don't match criteria 2 and 3 get their developer / publisher
  // / demo re-read this often, in case they change and start matching.
  nonCandidateRecheckMs: num('NON_CANDIDATE_RECHECK_HOURS', 72) * HOUR,

  // Each cron run stops starting new Steam requests after this long, leaving
  // any backlog for the next run. Keep below maxDuration in vercel.json.
  runBudgetMs: num('RUN_BUDGET_SECONDS', 240) * 1000,
  storeThrottleMs: num('STORE_THROTTLE_MS', 1500), // store.steampowered.com allows roughly 200 requests / 5 min
  // steamcommunity.com (follower counts) answers bursts with HTTP 429, so
  // follower reads go one at a time with this gap between them.
  communityThrottleMs: num('COMMUNITY_THROTTLE_MS', 1000),

  // Pages whose store data isn't public yet get retried for this long.
  pendingGiveUpMs: num('PENDING_GIVE_UP_DAYS', 14) * DAY,
  pendingRetryMs: 2 * HOUR,
  // Per-page records expire from Redis after this long.
  retentionMs: num('RETENTION_DAYS', 30) * DAY,
};

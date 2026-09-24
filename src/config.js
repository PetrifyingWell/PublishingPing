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

module.exports = {
  MINUTE,
  HOUR,
  DAY,

  steamApiKey: process.env.STEAM_API_KEY || '',
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  port: num('PORT', 3000),

  // The criteria.
  trackingWindowMs: num('TRACKING_WINDOW_DAYS', 14) * DAY,
  gainWindowMs: num('GAIN_WINDOW_DAYS', 5) * DAY,
  followerGainThreshold: num('FOLLOWER_GAIN_THRESHOLD', 150),
  excludeNsfw: bool('EXCLUDE_NSFW', true),

  // How often each job runs / how hard we lean on Steam.
  appListIntervalMs: num('APP_LIST_INTERVAL_MINUTES', 20) * MINUTE,
  detailsRefreshMs: num('DETAILS_REFRESH_HOURS', 12) * HOUR,
  storeThrottleMs: num('STORE_THROTTLE_MS', 1500), // store.steampowered.com allows roughly 200 req / 5 min
  communityThrottleMs: num('COMMUNITY_THROTTLE_MS', 1000),

  // Follower polling cadence. Candidates (self-published, no released demo)
  // get polled faster the closer they are to the threshold; everything else
  // is polled slowly so history exists if its dev/publisher/demo changes.
  followerIntervalMs: num('FOLLOWER_INTERVAL_MINUTES', 60) * MINUTE,
  followerIntervalNearMs: num('FOLLOWER_INTERVAL_NEAR_MINUTES', 15) * MINUTE,
  followerIntervalHotMs: num('FOLLOWER_INTERVAL_HOT_MINUTES', 5) * MINUTE,
  followerIntervalNonCandidateMs: num('FOLLOWER_INTERVAL_NON_CANDIDATE_MINUTES', 360) * MINUTE,

  // Pages whose appdetails aren't public yet get retried for this long.
  pendingGiveUpMs: num('PENDING_GIVE_UP_DAYS', 14) * DAY,
  // Rows older than this are pruned from the database.
  retentionMs: num('RETENTION_DAYS', 45) * DAY,
};

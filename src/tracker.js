const config = require('./config');
const db = require('./db');
const steam = require('./steam');
const slack = require('./slack');
const { isSelfPublished, findQualifyingGain, currentWindowGain, hasReleasedDemo } = require('./criteria');

const PENDING_RETRY_MS = 30 * config.MINUTE;
const ERROR_RETRY_MS = 30 * config.MINUTE;
const BATCH = 50;

const log = (...args) => console.log(new Date().toISOString(), ...args);

// --- 1. Discover new store pages by diffing Steam's app list.

async function syncAppList() {
  const list = await steam.getAppList();
  const now = Date.now();

  if (!db.getMeta('bootstrapped')) {
    // First run: nothing to diff against, so the whole current catalog
    // becomes the baseline. Pages that appear from now on get tracked.
    db.addKnown(list.map((a) => a.appid), now);
    db.setMeta('bootstrapped', now);
    log(`Bootstrapped with ${list.length.toLocaleString()} existing apps. New pages are tracked from now on.`);
    return;
  }

  const known = db.knownAppIdSet();
  const fresh = list.filter((a) => !known.has(a.appid));
  if (fresh.length) {
    db.addNewApps(fresh, now);
    log(`Found ${fresh.length} new app(s) in Steam's app list.`);
  }
  db.setMeta('lastAppListSync', now);
}

// --- 2. Classify new pages and keep their dev/publisher/demo info fresh.

// A demo counts as released once its own store entry is public and no
// longer "coming soon". A demo listed on the page but not yet out doesn't.
async function getDemoStatuses(data) {
  const demos = [];
  for (const d of data.demos || []) {
    if (d == null || d.appid == null) continue;
    const res = await steam.getAppDetails(d.appid);
    const released = res.ok && !(res.data.release_date && res.data.release_date.coming_soon);
    demos.push({ appid: Number(d.appid), released });
  }
  return demos;
}

function isCandidate(app) {
  return isSelfPublished(app.developers, app.publishers) && !hasReleasedDemo(app.demos);
}

async function applyDetails(app, data, now) {
  if (data.type !== 'game') {
    db.updateApp(app.appid, { status: 'ignored', ignore_reason: `type:${data.type}`, name: data.name });
    return null;
  }
  if (config.excludeNsfw && steam.isNsfw(data)) {
    db.updateApp(app.appid, { status: 'ignored', ignore_reason: 'nsfw', name: data.name });
    return null;
  }

  const fields = {
    status: 'tracking',
    name: data.name,
    developers: data.developers || [],
    publishers: data.publishers || [],
    demos: await getDemoStatuses(data),
    release_date: (data.release_date && data.release_date.date) || 'TBD',
    coming_soon: data.release_date && data.release_date.coming_soon ? 1 : 0,
    header_image: data.header_image || null,
    details_checked_at: now,
    last_error: null,
  };
  if (!app.appeared_at) {
    // If the page wasn't public when it first showed up in the app list,
    // it "appeared" when it went public, not when we first saw the appid.
    fields.appeared_at = app.was_hidden ? now : app.first_seen_at;
  }
  const wasCandidate = app.status === 'tracking' && isCandidate(app);
  if (app.next_follower_check_at == null || (!wasCandidate && isCandidate(fields))) {
    fields.next_follower_check_at = now; // look at followers right away
  }
  db.updateApp(app.appid, fields);
  return db.getApp(app.appid);
}

async function classifyPending() {
  const now = Date.now();
  for (const app of db.pendingDue(now, BATCH)) {
    if (now - app.first_seen_at > config.pendingGiveUpMs) {
      db.updateApp(app.appid, { status: 'ignored', ignore_reason: 'never_public' });
      continue;
    }
    try {
      const res = await steam.getAppDetails(app.appid);
      if (!res.ok) {
        db.updateApp(app.appid, { was_hidden: 1, retry_at: Date.now() + PENDING_RETRY_MS, last_error: 'not public yet' });
        continue;
      }
      const tracked = await applyDetails(app, res.data, Date.now());
      if (tracked) log(`Tracking ${tracked.appid} "${tracked.name}" (${tracked.developers} / ${tracked.publishers})`);
    } catch (err) {
      db.updateApp(app.appid, { retry_at: Date.now() + ERROR_RETRY_MS, last_error: err.message.slice(0, 500) });
      log(`appdetails failed for ${app.appid}: ${err.message}`);
    }
  }
}

async function refreshDetails() {
  const now = Date.now();
  for (const app of db.detailsDue(now - config.trackingWindowMs, now - config.detailsRefreshMs, BATCH)) {
    try {
      const res = await steam.getAppDetails(app.appid);
      if (res.ok) await applyDetails(app, res.data, Date.now());
      else db.updateApp(app.appid, { details_checked_at: Date.now() });
    } catch (err) {
      db.updateApp(app.appid, { details_checked_at: now - config.detailsRefreshMs + ERROR_RETRY_MS });
      log(`details refresh failed for ${app.appid}: ${err.message}`);
    }
  }
}

// --- 3. Poll followers and ping Slack when all three criteria hold.

function criteriaOptions() {
  return {
    threshold: config.followerGainThreshold,
    gainWindowMs: config.gainWindowMs,
    trackingWindowMs: config.trackingWindowMs,
  };
}

function nextInterval(app, snaps) {
  if (!isCandidate(app)) return config.followerIntervalNonCandidateMs;
  const remaining = config.followerGainThreshold - currentWindowGain(snaps, app.appeared_at, config.gainWindowMs);
  if (remaining <= config.followerGainThreshold * 0.2) return config.followerIntervalHotMs;
  if (remaining <= config.followerGainThreshold * 0.5) return config.followerIntervalNearMs;
  return config.followerIntervalMs;
}

async function evaluate(app) {
  const snaps = db.snapshots(app.appid);
  const hit = findQualifyingGain(snaps, app.appeared_at, criteriaOptions());
  if (hit && isCandidate(app)) {
    // Criteria 2 and 3 were last checked up to DETAILS_REFRESH_HOURS ago;
    // re-check them now so we never ping about a page that just announced
    // a publisher or released a demo.
    const res = await steam.getAppDetails(app.appid);
    const fresh = res.ok ? await applyDetails(app, res.data, Date.now()) : app;
    if (fresh && fresh.status === 'tracking' && isCandidate(fresh)) {
      try {
        await slack.post(slack.buildMessage(fresh, hit));
      } catch (err) {
        err.retryMs = config.followerIntervalHotMs; // don't sit on a qualifying page
        throw err;
      }
      db.updateApp(app.appid, { notified_at: Date.now() });
      log(`PINGED ${app.appid} "${fresh.name}": +${hit.gain} followers`);
      return;
    }
    app = fresh || app;
  }
  db.updateApp(app.appid, { next_follower_check_at: Date.now() + nextInterval(app, snaps) });
}

async function pollFollowers() {
  const now = Date.now();
  for (const app of db.followersDue(now - config.trackingWindowMs, now, BATCH)) {
    try {
      const followers = await steam.getFollowerCount(app.appid);
      const at = Date.now();
      // Only store readings inside the tracking window; later ones can't
      // count towards criterion 1.
      if (at <= app.appeared_at + config.trackingWindowMs) db.addSnapshot(app.appid, at, followers);
      db.updateApp(app.appid, { followers, last_error: null });
      await evaluate({ ...app, followers });
    } catch (err) {
      const retryAt = Date.now() + (err.retryMs || ERROR_RETRY_MS);
      db.updateApp(app.appid, { next_follower_check_at: retryAt, last_error: err.message.slice(0, 500) });
      log(`follower check failed for ${app.appid}: ${err.message}`);
    }
  }
}

function prune() {
  db.prune(Date.now() - config.retentionMs);
}

// --- Loop runner.

function every(name, intervalMs, fn) {
  let stopped = false;
  (async () => {
    while (!stopped) {
      const started = Date.now();
      try {
        await fn();
      } catch (err) {
        log(`[${name}] ${err.message}`);
      }
      const wait = Math.max(1000, intervalMs - (Date.now() - started));
      await new Promise((r) => setTimeout(r, wait));
    }
  })();
  return () => {
    stopped = true;
  };
}

function start() {
  if (!config.slackWebhookUrl) log('WARNING: SLACK_WEBHOOK_URL is not set, so pings will fail until it is.');
  const stops = [
    every('app-list', config.appListIntervalMs, syncAppList),
    every('classify', 30 * 1000, async () => {
      await classifyPending();
      await refreshDetails();
    }),
    every('followers', 15 * 1000, pollFollowers),
    every('prune', 6 * config.HOUR, prune),
  ];
  return () => stops.forEach((s) => s());
}

module.exports = { start, syncAppList, classifyPending, refreshDetails, pollFollowers, evaluate, isCandidate, nextInterval };

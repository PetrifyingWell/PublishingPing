// One cron run: find new pages, classify them, read followers, ping Slack.
// Every step works from a Redis queue ordered by due time and stops when the
// run's time budget is spent, so any backlog carries over to the next run.
const config = require('./config');
const store = require('./store');
const steam = require('./steam');
const slack = require('./slack');
const { isSelfPublished, findQualifyingGain, hasReleasedDemo } = require('./criteria');

const { K } = store;
const ERROR_RETRY_MS = config.HOUR;
// Due times are pulled slightly earlier so an hourly check isn't pushed to
// the following run by a few seconds of cron jitter.
const EARLY = 0.9;

function criteriaOptions() {
  return {
    threshold: config.followerGainThreshold,
    gainWindowMs: config.gainWindowMs,
    trackingWindowMs: config.trackingWindowMs,
  };
}

function isCandidate(app) {
  return isSelfPublished(app.developers, app.publishers) && !hasReleasedDemo(app.demos);
}

// --- 1. Discover new store pages by diffing Steam's app list.

async function syncAppList(log) {
  const list = await steam.getAppList();
  const now = Date.now();

  if (!(await store.getMeta('bootstrappedAt'))) {
    // First run: nothing to diff against, so the whole current catalog
    // becomes the baseline. Pages that appear from now on get tracked.
    await store.addKnown(list.map((a) => a.appid));
    await store.setMeta('bootstrappedAt', now);
    await store.setMeta('lastAppListSync', now);
    log(`Bootstrapped with ${list.length} existing apps; new pages are tracked from the next run.`);
    return 0;
  }

  const known = await store.knownAppIds();
  const fresh = list.filter((a) => !known.has(a.appid));
  for (const a of fresh) {
    await store.saveApp({ appid: a.appid, name: a.name, status: 'pending', firstSeenAt: now, snapshots: [] });
    await store.schedule(K.pending, a.appid, now);
  }
  await store.addKnown(fresh.map((a) => a.appid));
  await store.setMeta('lastAppListSync', now);
  if (fresh.length) log(`Found ${fresh.length} new app(s).`);
  return fresh.length;
}

// --- 2. Read store details (developer, publisher, demos).

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

// Applies fresh appdetails to a record, saves it and puts it on the right
// queue. Returns the updated record.
async function applyDetails(app, data) {
  const now = Date.now();
  if (data.type !== 'game' || (config.excludeNsfw && steam.isNsfw(data))) {
    const reason = data.type !== 'game' ? `type:${data.type}` : 'nsfw';
    const ignored = { ...app, name: data.name, status: 'ignored', ignoreReason: reason };
    await store.saveApp(ignored);
    await Promise.all([K.followers, K.recheck, K.tracked].map((q) => store.unschedule(q, app.appid)));
    return ignored;
  }

  const updated = {
    ...app,
    status: 'tracking',
    name: data.name,
    developers: data.developers || [],
    publishers: data.publishers || [],
    demos: await getDemoStatuses(data),
    releaseDate: (data.release_date && data.release_date.date) || 'TBD',
    headerImage: data.header_image || null,
    detailsCheckedAt: now,
    lastError: null,
  };
  // If the page wasn't public when its appid first showed up, it "appeared"
  // when it went public.
  if (!updated.appearedAt) updated.appearedAt = app.wasHidden ? now : app.firstSeenAt;
  updated.candidate = isCandidate(updated);
  await store.saveApp(updated);
  await store.schedule(K.tracked, app.appid, updated.appearedAt);

  if (updated.notifiedAt) return updated;
  if (updated.candidate) {
    await store.unschedule(K.recheck, app.appid);
    if (!app.candidate) await store.schedule(K.followers, app.appid, now); // read followers right away
  } else {
    await store.unschedule(K.followers, app.appid);
    await store.schedule(K.recheck, app.appid, now + config.nonCandidateRecheckMs * EARLY);
  }
  return updated;
}

// Works through a queue's due entries until it's empty, the deadline passes
// or `handle` returns false. Entries whose record has expired out of Redis
// are dropped.
async function drain(queue, deadline, batchSize, handle) {
  while (Date.now() < deadline) {
    const ids = await store.due(queue, Date.now(), batchSize);
    if (ids.length === 0) return;
    const apps = await store.getApps(ids);
    const found = new Set(apps.map((a) => a.appid));
    for (const id of ids) if (!found.has(id)) await store.unschedule(queue, id);
    if ((await handle(apps)) === false) return;
  }
}

// Steam answers "too many requests" with HTTP 429. Once that happens,
// further requests to the same host this run only make it worse, so the
// affected step stops and leaves its remaining pages due for the next run.
const isRateLimited = (err) => err && err.status === 429;

async function classifyPending(deadline, log, limits) {
  let done = 0;
  if (limits.store) return done;
  await drain(K.pending, deadline, 20, async (apps) => {
    for (const app of apps) {
      if (Date.now() >= deadline) return false;
      await store.unschedule(K.pending, app.appid);
      if (Date.now() - app.firstSeenAt > config.pendingGiveUpMs) {
        await store.saveApp({ ...app, status: 'ignored', ignoreReason: 'never_public' });
        continue;
      }
      try {
        const res = await steam.getAppDetails(app.appid);
        if (!res.ok) {
          await store.saveApp({ ...app, wasHidden: true, lastError: 'not public yet' });
          await store.schedule(K.pending, app.appid, Date.now() + config.pendingRetryMs);
          continue;
        }
        const updated = await applyDetails(app, res.data);
        if (updated.status === 'tracking') {
          log(`Tracking ${app.appid} "${updated.name}" (dev: ${updated.developers}; pub: ${updated.publishers})`);
        }
        done++;
      } catch (err) {
        await store.saveApp({ ...app, lastError: err.message.slice(0, 300) });
        if (isRateLimited(err)) {
          await store.schedule(K.pending, app.appid, Date.now());
          limits.store = true;
          log('Steam is rate-limiting store lookups (HTTP 429); pausing them until the next run.');
          return false;
        }
        await store.schedule(K.pending, app.appid, Date.now() + ERROR_RETRY_MS);
        log(`appdetails failed for ${app.appid}: ${err.message}`);
      }
    }
    return true;
  });
  return done;
}

async function recheckNonCandidates(deadline, log, limits) {
  let done = 0;
  if (limits.store) return done;
  await drain(K.recheck, deadline, 20, async (apps) => {
    for (const app of apps) {
      if (Date.now() >= deadline) return false;
      try {
        const res = await steam.getAppDetails(app.appid);
        if (res.ok) await applyDetails(app, res.data);
        else await store.schedule(K.recheck, app.appid, Date.now() + config.nonCandidateRecheckMs * EARLY);
        done++;
      } catch (err) {
        if (isRateLimited(err)) {
          limits.store = true;
          log('Steam is rate-limiting store lookups (HTTP 429); pausing them until the next run.');
          return false;
        }
        await store.schedule(K.recheck, app.appid, Date.now() + ERROR_RETRY_MS);
        log(`recheck failed for ${app.appid}: ${err.message}`);
      }
    }
    return true;
  });
  return done;
}

// --- 3. Read followers and ping Slack when all three criteria hold.

async function checkFollowers(app, log) {
  return recordFollowers(app, await steam.getFollowerCount(app.appid), log);
}

// Stores a follower reading, then pings if the page now meets all three
// criteria. Returns true when it pinged.
async function recordFollowers(app, followers, log) {
  const at = Date.now();
  app = { ...app, followers, lastError: null };
  // Readings after the tracking window can't count towards criterion 1.
  if (at <= app.appearedAt + config.trackingWindowMs) app.snapshots = [...(app.snapshots || []), { at, followers }];

  const hit = findQualifyingGain(app.snapshots, app.appearedAt, criteriaOptions());
  if (!hit) {
    await store.saveApp(app);
    await store.schedule(K.followers, app.appid, at + config.followerIntervalMs * EARLY);
    return false;
  }

  // Developer, publisher and demo were read when the page was found (or
  // last re-checked); re-read them now so we never ping about a page that
  // has since signed a publisher or released a demo.
  const res = await steam.getAppDetails(app.appid);
  const fresh = res.ok ? await applyDetails(app, res.data) : app;
  if (fresh.status !== 'tracking' || !fresh.candidate) {
    log(`${app.appid} "${app.name}" passed ${config.followerGainThreshold} followers but no longer matches.`);
    return false;
  }

  await slack.post(slack.buildMessage(fresh, hit));
  await store.saveApp({ ...fresh, notifiedAt: Date.now(), hit: { gain: hit.gain, from: hit.from.at, to: hit.to.at } });
  await store.unschedule(K.followers, app.appid);
  log(`PINGED ${app.appid} "${fresh.name}": +${hit.gain} followers`);
  return true;
}

// --- Follower readings delivered from outside Vercel.
//
// steamcommunity.com rate-limits Vercel's servers, so the GitHub Actions
// workflow in .github/workflows/followers.yml reads follower counts instead:
// it asks for the due pages (dueFollowerChecks), reads their counts from
// Steam and posts them back (recordExternalFollowers).

const EXTERNAL_FRESH_MS = 2 * config.HOUR;

async function dueFollowerChecks(limit = 200) {
  const ids = await store.due(K.followers, Date.now(), limit);
  const apps = await store.getApps(ids);
  const found = new Set(apps.map((a) => a.appid));
  for (const id of ids) if (!found.has(id)) await store.unschedule(K.followers, id);
  return apps.filter((a) => a.status === 'tracking' && !a.notifiedAt).map((a) => a.appid);
}

// `results` is [{ appid, followers }] or [{ appid, error }]. Pages the
// workflow didn't get to (e.g. it stopped on a 429) stay due.
async function recordExternalFollowers(results) {
  const lines = [];
  const log = (msg) => {
    console.log(msg);
    lines.push(msg);
  };
  await store.setMeta('lastExternalFollowers', Date.now());
  const summary = { recorded: 0, pinged: 0, errors: 0, ignored: 0 };

  for (const r of Array.isArray(results) ? results : []) {
    const appid = Number(r && r.appid);
    const app = Number.isInteger(appid) ? await store.getApp(appid) : null;
    if (!app || app.status !== 'tracking' || app.notifiedAt) {
      summary.ignored++;
      continue;
    }
    try {
      if (Number.isInteger(r.followers) && r.followers >= 0) {
        if (await recordFollowers(app, r.followers, log)) summary.pinged++;
        summary.recorded++;
      } else {
        const error = String(r.error || 'no follower count').slice(0, 300);
        await store.saveApp({ ...app, lastError: error });
        await store.schedule(K.followers, app.appid, Date.now() + ERROR_RETRY_MS);
        log(`follower check failed for ${app.appid}: ${error}`);
        summary.errors++;
      }
    } catch (err) {
      await store.saveApp({ ...app, lastError: err.message.slice(0, 300) });
      await store.schedule(K.followers, app.appid, Date.now() + ERROR_RETRY_MS);
      log(`recording followers failed for ${app.appid}: ${err.message}`);
      summary.errors++;
    }
  }
  log(`Follower report: ${JSON.stringify(summary)}`);
  return { ...summary, log: lines };
}

async function externalFollowersActive() {
  const last = Number(await store.getMeta('lastExternalFollowers')) || 0;
  return Date.now() - last < EXTERNAL_FRESH_MS;
}

async function pollFollowers(deadline, log, limits) {
  let checked = 0;
  let pinged = 0;
  if (limits.community || limits.external) return { checked, pinged };
  await drain(K.followers, deadline, 100, async (apps) => {
    for (const app of apps) {
      if (Date.now() >= deadline) return false;
      try {
        if (await checkFollowers(app, log)) pinged++;
        checked++;
      } catch (err) {
        await store.saveApp({ ...app, lastError: err.message.slice(0, 300) });
        if (isRateLimited(err)) {
          // Left due, so this page is first in line next run.
          limits.community = true;
          log(`Steam is rate-limiting follower checks (HTTP 429); pausing them until the next run.`);
          return false;
        }
        await store.schedule(K.followers, app.appid, Date.now() + ERROR_RETRY_MS);
        log(`follower check failed for ${app.appid}: ${err.message}`);
      }
    }
    return true;
  });
  return { checked, pinged };
}

// --- The cron entry point.

async function run({ budgetMs = config.runBudgetMs } = {}) {
  const started = Date.now();
  const deadline = started + budgetMs;
  const lines = [];
  const log = (msg) => {
    console.log(msg);
    lines.push(msg);
  };

  // Overlapping runs (a manual trigger during a scheduled one) would double
  // up Steam requests and could double-ping, so only one runs at a time.
  const lock = await store.redis().set(K.lock, String(started), 'PX', budgetMs + 5 * config.MINUTE, 'NX');
  if (!lock) return { skipped: 'another run is in progress' };
  try {
    return await runLocked(started, deadline, log, lines);
  } finally {
    await store.redis().del(K.lock);
  }
}

async function runLocked(started, deadline, log, lines) {
  if (!config.slackWebhookUrl) log('WARNING: SLACK_WEBHOOK_URL is not set, so pings will fail until it is.');

  const expired = await store.expireTracked(started - config.trackingWindowMs);
  const newApps = await syncAppList(log);
  // Followers first: that's the time-sensitive part. Then classify new
  // pages and re-check ones that didn't match, and finally give any page
  // that now matches its first follower read.
  // community/store: set when Steam rate-limits that host. external: follower
  // counts are arriving from the GitHub workflow, so Vercel doesn't read them.
  const limits = { community: false, store: false, external: await externalFollowersActive() };
  const f1 = await pollFollowers(deadline, log, limits);
  const classified = await classifyPending(deadline, log, limits);
  const rechecked = await recheckNonCandidates(deadline, log, limits);
  const f2 = await pollFollowers(deadline, log, limits);

  const result = {
    newApps,
    classified,
    followersChecked: f1.checked + f2.checked,
    pinged: f1.pinged + f2.pinged,
    rechecked,
    expired,
    rateLimited: { community: limits.community, store: limits.store },
    followersFrom: limits.external ? 'github' : 'vercel',
    queues: await store.queueSizes(),
    tookMs: Date.now() - started,
  };
  // One line per run in the Vercel logs, so it's easy to see what happened.
  log(`Run summary: ${JSON.stringify(result)}`);
  return { ...result, log: lines };
}

module.exports = { run, isCandidate, dueFollowerChecks, recordExternalFollowers };

const path = require('path');
// Load .env from this file's own directory, not the current working
// directory - the two can easily differ (e.g. running `npm start` from a
// parent folder), and dotenv fails silently if it looks in the wrong place.
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cheerio = require('cheerio');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const USER_AGENT = 'Mozilla/5.0 (compatible; SteamPublishingListTool/1.0)';
const NEW_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // "new" = first seen by this tool in the last 3 days
const APPLIST_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CLASSIFICATIONS_PER_BATCH = 25; // caps Steam calls per classification pass when there's a backlog
const CLASSIFY_TIME_BUDGET_MS = 8000; // stop starting new classifications once a pass has spent this long
const CLASSIFY_FETCH_TIMEOUT_MS = 8000; // per-call timeout for appdetails/tag lookups (best-effort, retried later)
const CLASSIFY_THROTTLE_MS = 600;
const BACKGROUND_CLASSIFY_INTERVAL_MS = 20000; // keeps draining the backlog even if nobody is refreshing

// A seed of well-known Steam tag names to prime the filter's autocomplete.
// Filtering itself matches against each game's own scraped tags (below),
// not this list, so an unlisted-but-real tag still works if typed in.
const SEED_TAGS = [
  'Action', 'Adventure', 'Indie', 'RPG', 'Strategy', 'Simulation', 'Casual',
  'Early Access', 'Free to Play', 'Singleplayer', 'Multiplayer', 'Co-op',
  'Online Co-Op', 'Local Co-Op', 'Open World', 'Roguelike', 'Roguelite',
  'Metroidvania', "Souls-like", 'Pixel Graphics', '2D', '3D Platformer',
  'Horror', 'Survival', 'Survival Horror', 'Puzzle', 'Platformer', 'Sandbox',
  'Story Rich', 'Atmospheric', 'Turn-Based Strategy', 'Turn-Based Tactics',
  'Real-Time Strategy', 'Real Time Tactics', 'FPS', 'Shooter',
  'Third Person Shooter', 'Stealth', 'Fighting', 'Racing', 'Sports', 'Music',
  'Rhythm', 'VR', 'Anime', 'Cute', 'Dark Fantasy', 'Sci-fi',
  'Post-apocalyptic', 'Crafting', 'Exploration', 'City Builder',
  'Base Building', 'Colony Sim', 'Farming Sim', 'Deckbuilder', 'Card Game',
  'Visual Novel', 'Point & Click', 'Tower Defense', 'Bullet Hell',
  'Management', 'Tactical RPG', 'Action RPG', 'JRPG', 'Dungeon Crawler',
  'Hack and Slash', 'Physics', 'Difficult', 'Relaxing', 'Comedy',
  'Narrative', 'Walking Simulator',
];

let appListCache = { data: null, fetchedAt: 0 };

// Fetches a URL and gives a specific, actionable error on anything other
// than a clean 2xx JSON response - a bare "status 403" or "Unexpected
// token <" doesn't say whether Steam rate-limited us, served an HTML
// block page, or something else entirely.
async function fetchJsonWithDiagnostics(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
    const causeMsg = err.cause ? ` (${err.cause.message || err.cause})` : '';
    throw new Error(`Request to ${url} failed: ${err.message}${causeMsg}`);
  } finally {
    clearTimeout(timeout);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${url} responded with HTTP ${res.status}. Body (first 300 chars): ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${url} did not return JSON. Body (first 300 chars): ${text.slice(0, 300)}`);
  }
}

// IStoreService/GetAppList needs a free Steam Web API key (get one at
// https://steamcommunity.com/dev/apikey, then set STEAM_API_KEY). It's the
// modern replacement for the classic keyless ISteamApps/GetAppList/v2,
// which is tried first below and appears to have been retired by Valve.
async function getAppListViaStoreService(apiKey) {
  const apps = [];
  let lastAppId = 0;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({
      key: apiKey,
      include_games: 'true',
      include_dlc: 'false',
      include_software: 'false',
      include_videos: 'false',
      include_hardware: 'false',
      max_results: '50000',
      last_appid: String(lastAppId),
    });
    const url = `https://api.steampowered.com/IStoreService/GetAppList/v1/?${params.toString()}`;
    const data = await fetchJsonWithDiagnostics(url, { headers: { 'User-Agent': USER_AGENT } });
    const response = data.response || {};
    const pageApps = response.apps || [];
    apps.push(...pageApps);
    hasMore = !!response.have_more_results && pageApps.length > 0;
    lastAppId = response.last_appid;
  }

  return apps.filter((a) => a && a.appid != null && a.name).map((a) => ({ appid: String(a.appid), name: a.name }));
}

async function getAppList() {
  if (appListCache.data && Date.now() - appListCache.fetchedAt < APPLIST_CACHE_TTL_MS) {
    return appListCache.data;
  }

  const apiKey = process.env.STEAM_API_KEY;
  let normalized;

  try {
    const data = await fetchJsonWithDiagnostics('https://api.steampowered.com/ISteamApps/GetAppList/v2/', {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    const apps = (data.applist && data.applist.apps) || [];
    normalized = apps
      .filter((a) => a && a.appid != null && a.name)
      .map((a) => ({ appid: String(a.appid), name: a.name }));
  } catch (legacyErr) {
    if (!apiKey) {
      throw new Error(
        `${legacyErr.message} | Steam's free app-list endpoint (ISteamApps/GetAppList) appears to be unavailable. ` +
          'Get a free Steam Web API key at https://steamcommunity.com/dev/apikey, set it as the STEAM_API_KEY ' +
          'environment variable, and restart the server to use IStoreService/GetAppList instead.'
      );
    }
    normalized = await getAppListViaStoreService(apiKey);
  }

  appListCache = { data: normalized, fetchedAt: Date.now() };
  return normalized;
}

async function fetchAppDetails(appid) {
  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=english`;
    const data = await fetchJsonWithDiagnostics(url, { headers: { 'User-Agent': USER_AGENT } }, CLASSIFY_FETCH_TIMEOUT_MS);
    const entry = data[appid];
    if (!entry || !entry.success || !entry.data) return null;
    return entry.data;
  } catch (err) {
    console.error(`Failed to fetch appdetails for ${appid}:`, err.message);
    return null;
  }
}

async function fetchStoreTags(appid) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLASSIFY_FETCH_TIMEOUT_MS);
  try {
    const url = `https://store.steampowered.com/app/${appid}/?l=english`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        // Bypasses Steam's age-gate interstitial so the real page (and its tags) loads.
        Cookie: 'birthtime=0; lastagecheckage=1-January-1990; wants_mature_content=1',
      },
    });
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);
    const tags = [];
    $('.glance_tags.popular_tags a.app_tag').each((_, el) => {
      const t = $(el).text().trim();
      if (t) tags.push(t);
    });
    return tags;
  } catch (err) {
    console.error(`Failed to fetch store tags for ${appid}:`, err.message);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

// Classifies a newly-diffed appid: is it a real, unreleased game, and if so
// what does its store page actually say. Returns null for anything else
// (DLC, software, demos, already-released games, unpublished/removed apps).
async function classifyAppId(appid) {
  const details = await fetchAppDetails(appid);
  if (!details) return null;
  if (details.type !== 'game') return null;
  if (!details.release_date || details.release_date.coming_soon !== true) return null;

  const tags = await fetchStoreTags(appid);

  return {
    name: details.name,
    headerImage: details.header_image || null,
    releaseDate: details.release_date.date || 'TBD',
    isFree: !!details.is_free,
    priceText: details.price_overview
      ? details.price_overview.final_formatted
      : details.is_free
        ? 'Free to Play'
        : 'TBD',
    developers: details.developers || [],
    publishers: details.publishers || [],
    shortDescription: details.short_description || '',
    screenshots: (details.screenshots || []).map((s) => ({ thumbnail: s.path_thumbnail, full: s.path_full })),
    movies: (details.movies || []).map((m) => ({
      name: m.name,
      thumbnail: m.thumbnail,
      mp4: (m.mp4 && (m.mp4.max || m.mp4['480'])) || null,
    })),
    genres: (details.genres || []).map((g) => g.description),
    tags,
  };
}

// Sequential queue: never fire classification requests (2 Steam calls each) concurrently.
let classifyQueue = Promise.resolve();
function classifyAppIdThrottled(appid) {
  const run = classifyQueue.then(() => classifyAppId(appid));
  classifyQueue = run.catch(() => null).then(() => new Promise((resolve) => setTimeout(resolve, CLASSIFY_THROTTLE_MS)));
  return run;
}

function formatGameRecord(record) {
  const d = record.details;
  return {
    appid: record.appid,
    name: d.name,
    url: `https://store.steampowered.com/app/${record.appid}/`,
    headerImage: d.headerImage,
    releaseDate: d.releaseDate,
    price: { isFree: d.isFree, priceText: d.priceText },
    developers: d.developers,
    publishers: d.publishers,
    shortDescription: d.shortDescription,
    screenshots: d.screenshots,
    movies: d.movies,
    genres: d.genres,
    tags: d.tags,
    status: record.status,
    firstSeenAt: record.firstSeenAt,
    viewedAt: record.viewedAt,
  };
}

// Drains the classification queue: for each pending appid, runs the
// appdetails + tag lookup and, if it's a real unreleased game, creates its
// game record stamped with its true discovery time (not now - a backlog
// item can otherwise wait so long that it gets born already stale, or
// worse, ages out of the 3-day window before ever being classified).
// Runs both on a timer (so the backlog drains even with nobody refreshing)
// and opportunistically from a request; the lock just prevents the two
// from overlapping, it's not a hard dependency of either caller.
let classifying = false;

async function processClassificationQueue() {
  if (classifying) return;
  classifying = true;
  try {
    const now = Date.now();

    // Anything already older than the "new" window will never qualify once
    // classified, so don't spend a Steam call finding that out.
    for (const { appid, discoveredAt } of db.getPendingQueue()) {
      if (now - new Date(discoveredAt).getTime() > NEW_WINDOW_MS) db.dequeuePending(appid);
    }

    const batch = db.getPendingQueue().slice(0, MAX_CLASSIFICATIONS_PER_BATCH);
    const classifyStart = Date.now();
    for (const { appid, discoveredAt } of batch) {
      if (Date.now() - classifyStart > CLASSIFY_TIME_BUDGET_MS) break; // leave the rest for the next pass
      try {
        const details = await classifyAppIdThrottled(appid);
        if (details) db.createGame(appid, details, discoveredAt);
      } catch (err) {
        console.error(`Failed to classify ${appid}:`, err.message);
      } finally {
        db.dequeuePending(appid);
      }
    }
  } finally {
    classifying = false;
  }
}

setInterval(() => {
  processClassificationQueue().catch((err) => console.error('Background classification pass failed:', err.message));
}, BACKGROUND_CLASSIFY_INTERVAL_MS);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/tags', (req, res) => {
  const observed = new Set();
  for (const g of db.all()) {
    for (const t of (g.details && g.details.tags) || []) observed.add(t);
  }
  const tags = [...new Set([...SEED_TAGS, ...observed])].sort((a, b) => a.localeCompare(b));
  res.json({ tags, count: tags.length });
});

app.get('/api/games', async (req, res) => {
  const { tags = '', term = '' } = req.query;

  try {
    const appList = await getAppList();

    if (!db.isBootstrapped()) {
      // First-ever run: we have nothing to diff against yet, so record the
      // current full app list as the baseline without classifying ~150k+
      // appids. New pages become visible starting from the next refresh.
      db.addKnownAppIds(appList.map((a) => a.appid));
      return res.json({
        bootstrap: true,
        message: `Seeded baseline with ${appList.length.toLocaleString()} known Steam app IDs. New pages will start appearing on your next refresh.`,
        count: 0,
        queueRemaining: 0,
        games: [],
      });
    }

    const knownSet = db.getKnownAppIdSet();
    const newAppIds = appList.filter((a) => !knownSet.has(a.appid)).map((a) => a.appid);
    if (newAppIds.length > 0) {
      db.addKnownAppIds(newAppIds);
      db.enqueuePending(newAppIds);
    }

    // Best-effort: if a background pass isn't already running, get a head
    // start on the queue so a manual refresh feels responsive. If one IS
    // already running (the 20s timer), this just no-ops and we serve
    // whatever's already classified - the response still reports how much
    // is left, and it'll be caught on the next pass regardless.
    await processClassificationQueue();

    const tagFilters = tags
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const termFilter = term.trim().toLowerCase();
    const now = Date.now();

    const candidates = db.all().filter((g) => {
      if (g.status !== 'new') return false;
      if (now - new Date(g.firstSeenAt).getTime() > NEW_WINDOW_MS) return false;
      if (tagFilters.length > 0) {
        const gameTags = (g.details.tags || []).map((t) => t.toLowerCase());
        if (!tagFilters.every((tf) => gameTags.includes(tf))) return false;
      }
      if (termFilter && !g.details.name.toLowerCase().includes(termFilter)) return false;
      return true;
    });

    candidates.sort((a, b) => new Date(b.firstSeenAt) - new Date(a.firstSeenAt));

    res.json({
      bootstrap: false,
      count: candidates.length,
      queueRemaining: db.getPendingQueue().length,
      games: candidates.map(formatGameRecord),
    });
  } catch (err) {
    console.error('Failed to build new-games list:', err);
    res.status(502).json({
      error: 'Failed to reach Steam or parse its response. Steam may have changed its API.',
      detail: err.message,
    });
  }
});

app.get('/api/history', (req, res) => {
  const games = db
    .all()
    .filter((g) => g.status !== 'new')
    .sort((a, b) => new Date(b.viewedAt) - new Date(a.viewedAt))
    .map(formatGameRecord);
  res.json({ games });
});

app.get('/api/shortlist', (req, res) => {
  const games = db
    .all()
    .filter((g) => g.status === 'shortlisted')
    .sort((a, b) => new Date(b.viewedAt) - new Date(a.viewedAt))
    .map(formatGameRecord);
  res.json({ games });
});

app.post('/api/games/:appid/status', (req, res) => {
  const { status } = req.body || {};
  if (!['new', 'shortlisted', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'status must be one of: new, shortlisted, dismissed' });
  }
  const record = db.setStatus(req.params.appid, status);
  if (!record) return res.status(404).json({ error: 'Unknown appid (has it been classified yet?)' });
  res.json({ game: formatGameRecord(record) });
});

app.listen(PORT, () => {
  console.log(`Steam Publishing List Tool running at http://localhost:${PORT}`);
  console.log(
    process.env.STEAM_API_KEY
      ? 'STEAM_API_KEY detected - will fall back to IStoreService/GetAppList if the classic endpoint is unavailable.'
      : `STEAM_API_KEY not set (looked for a .env file at ${path.join(__dirname, '.env')}) - only the classic ` +
          'ISteamApps/GetAppList endpoint will be used.'
  );
});

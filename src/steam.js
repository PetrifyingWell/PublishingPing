const config = require('./config');

const USER_AGENT = 'Mozilla/5.0 (compatible; PublishingPing/2.0)';

// Fetches a URL and gives a specific, actionable error on anything other
// than a clean 2xx response - a bare "status 403" or "Unexpected token <"
// doesn't say whether Steam rate-limited us, served an HTML block page, or
// something else entirely.
async function fetchText(url, { timeoutMs = 15000, headers = {} } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': USER_AGENT, ...headers } });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
    const causeMsg = err.cause ? ` (${err.cause.message || err.cause})` : '';
    throw new Error(`Request to ${url} failed: ${err.message}${causeMsg}`);
  } finally {
    clearTimeout(timeout);
  }
  const text = await res.text();
  if (!res.ok) {
    const e = new Error(`${url} responded with HTTP ${res.status}. Body (first 300 chars): ${text.slice(0, 300)}`);
    e.status = res.status;
    throw e;
  }
  return text;
}

async function fetchJson(url, opts) {
  const text = await fetchText(url, opts);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${url} did not return JSON. Body (first 300 chars): ${text.slice(0, 300)}`);
  }
}

// Serializes calls against the store with a gap between them, to stay under
// its rate limit.
function throttled(gapMs) {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(fn);
    chain = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, gapMs)));
    return run;
  };
}

const storeQueue = throttled(config.storeThrottleMs);
const communityQueue = throttled(config.communityThrottleMs);

// Every game currently listed on the store. Needs a free Steam Web API key
// (https://steamcommunity.com/dev/apikey) - the old keyless
// ISteamApps/GetAppList/v2 has been retired.
async function getAppList() {
  if (!config.steamApiKey) {
    throw new Error('STEAM_API_KEY is not set. Get a free key at https://steamcommunity.com/dev/apikey.');
  }
  const apps = [];
  let lastAppId = 0;
  for (;;) {
    const params = new URLSearchParams({
      key: config.steamApiKey,
      include_games: 'true',
      include_dlc: 'false',
      include_software: 'false',
      include_videos: 'false',
      include_hardware: 'false',
      max_results: '50000',
      last_appid: String(lastAppId),
    });
    const data = await fetchJson(`https://api.steampowered.com/IStoreService/GetAppList/v1/?${params}`, {
      timeoutMs: 60000,
    });
    const response = data.response || {};
    const page = response.apps || [];
    for (const a of page) if (a && a.appid != null) apps.push({ appid: Number(a.appid), name: a.name || '' });
    if (!response.have_more_results || page.length === 0) break;
    lastAppId = response.last_appid;
  }
  return apps;
}

// Store appdetails. Returns { ok: true, data } on success, { ok: false }
// when Steam says the app has no public store data (not visible yet, or
// removed), and throws on transport errors so callers can retry later.
async function getAppDetails(appid) {
  return storeQueue(async () => {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=english&cc=us`;
    const data = await fetchJson(url, { timeoutMs: 15000 });
    const entry = data && data[appid];
    if (!entry || !entry.success || !entry.data) return { ok: false };
    return { ok: true, data: entry.data };
  });
}

// Follower count, read from the app's community group. This is the same
// "Followers" number shown on the store / community hub.
async function getFollowerCount(appid) {
  return communityQueue(async () => {
    const url = `https://steamcommunity.com/games/${appid}/memberslistxml/?xml=1`;
    const xml = await fetchText(url, { timeoutMs: 15000 });
    const match = xml.match(/<memberCount>\s*(\d+)\s*<\/memberCount>/i);
    if (!match) throw new Error(`No <memberCount> in follower XML for ${appid}: ${xml.slice(0, 200)}`);
    return Number(match[1]);
  });
}

// Steam's content-descriptor ids for nudity/sexual content specifically
// (not violence/gore), backed up by keyword checks on the descriptive text.
const NSFW_CONTENT_DESCRIPTOR_IDS = new Set([1, 3, 4]);
const NSFW_KEYWORDS = ['nudity', 'sexual content', 'nsfw', 'hentai'];

function isNsfw(details) {
  const cd = details.content_descriptors || {};
  if ((cd.ids || []).some((id) => NSFW_CONTENT_DESCRIPTOR_IDS.has(id))) return true;
  const texts = [cd.notes || '', ...(details.genres || []).map((g) => g.description || '')];
  return texts.some((t) => NSFW_KEYWORDS.some((kw) => t.toLowerCase().includes(kw)));
}

module.exports = { getAppList, getAppDetails, getFollowerCount, isNsfw };

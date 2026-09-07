const express = require('express');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const USER_AGENT = 'Mozilla/5.0 (compatible; SteamPublishingListTool/1.0)';
const NEW_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // "new" = first seen by this tool in the last 3 days
const PAGE_SIZE = 100;
const MAX_PAGES = 5; // bounds how much of a filtered Coming Soon feed we scan per refresh
const MAX_DETAIL_FETCHES_PER_REQUEST = 30; // throttle Steam appdetails calls per refresh

const TAG_CACHE_FILE = path.join(__dirname, 'data', 'tag-cache.json');
const TAG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
let tagCache = { data: null, fetchedAt: 0 };

function parseReviewTooltip(tooltipHtml) {
  if (!tooltipHtml) return null;
  const text = tooltipHtml.replace(/<br\s*\/?>/gi, ' ').trim();
  const summaryMatch = text.match(/^([A-Za-z ]+?)\s+\d/);
  const percentMatch = text.match(/(\d+)%/);
  const countMatch = text.match(/([\d,]+)\s+user reviews/i);
  return {
    summary: summaryMatch ? summaryMatch[1].trim() : text.split(' ').slice(0, 2).join(' '),
    percent: percentMatch ? parseInt(percentMatch[1], 10) : null,
    count: countMatch ? parseInt(countMatch[1].replace(/,/g, ''), 10) : null,
  };
}

function parsePrice($, row) {
  const priceContainer = row.find('.search_price_discount_combined');
  const finalCents = priceContainer.attr('data-price-final');

  const discountPct = row.find('.discount_pct').first().text().trim() || null;
  const originalText = row.find('.discount_original_price').first().text().trim();
  const finalDiscountText = row.find('.discount_final_price').first().text().trim();

  let priceText = finalDiscountText || row.find('.search_price').first().text().trim();
  priceText = priceText.replace(/\s+/g, ' ').trim();

  const isFree = /free/i.test(priceText) && !/-\d+%/.test(priceText);

  return {
    isFree: isFree || priceText === '',
    priceText: priceText || (finalCents !== undefined ? null : 'N/A'),
    originalPriceText: originalText || null,
    discountPercent: discountPct,
    priceCents: finalCents !== undefined ? parseInt(finalCents, 10) : null,
  };
}

function parseTagIds(row) {
  const raw = row.attr('data-ds-tagids');
  if (!raw) return [];
  try {
    const ids = JSON.parse(raw);
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch {
    return [];
  }
}

function parseSearchResults(html) {
  const $ = cheerio.load(html);
  const games = [];

  $('a.search_result_row').each((_, el) => {
    const row = $(el);
    const appid = row.attr('data-ds-appid');
    if (!appid) return; // bundles/packages don't have a single appid

    const name = row.find('.search_name .title').first().text().trim();
    const releaseDate = row.find('.search_released').first().text().trim();
    const image = row.find('.search_capsule img').first().attr('src') || null;
    const url = row.attr('href') ? row.attr('href').split('?')[0] : null;

    const tooltipHtml = row.find('.search_review_summary').first().attr('data-tooltip-html');
    const review = parseReviewTooltip(tooltipHtml);
    const price = parsePrice($, row);
    const tagIds = parseTagIds(row);

    games.push({ appid, name, url, image, releaseDate, review, price, tagIds });
  });

  return games;
}

async function fetchComingSoonPages({ tags, term }) {
  let allRows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const start = page * PAGE_SIZE;
    const params = new URLSearchParams({
      query: term || '',
      start: String(start),
      count: String(PAGE_SIZE),
      dynamic_data: '',
      sort_by: 'Released_ASC',
      category1: '998', // Games only (excludes DLC, soundtracks, software, etc.)
      filter: 'comingsoon', // unreleased pages only
      supportedlang: 'english',
      ndl: '1',
      infinite: '1',
    });
    if (tags) params.set('tags', tags);

    const url = `https://store.steampowered.com/search/results/?${params.toString()}`;
    const steamRes = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    if (!steamRes.ok) throw new Error(`Steam search responded with status ${steamRes.status}`);

    const data = await steamRes.json();
    const rows = parseSearchResults(data.results_html || '');
    allRows = allRows.concat(rows);

    const totalCount = data.total_count ?? allRows.length;
    if (rows.length < PAGE_SIZE || allRows.length >= totalCount) break;
  }
  return allRows;
}

async function fetchAppDetails(appid) {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=english`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return null;
  const data = await res.json();
  const entry = data[appid];
  if (!entry || !entry.success || !entry.data) return null;
  const d = entry.data;
  return {
    developers: d.developers || [],
    publishers: d.publishers || [],
    shortDescription: d.short_description || '',
    screenshots: (d.screenshots || []).slice(0, 5).map((s) => s.path_thumbnail),
    genres: (d.genres || []).map((g) => g.description),
    releaseDate: d.release_date && d.release_date.date ? d.release_date.date : null,
  };
}

// Simple sequential queue so we never fire appdetails requests concurrently.
let detailQueue = Promise.resolve();
function fetchAppDetailsThrottled(appid) {
  const run = detailQueue.then(() => fetchAppDetails(appid));
  detailQueue = run.catch(() => null).then(() => new Promise((resolve) => setTimeout(resolve, 400)));
  return run;
}

async function getTagDictionary() {
  if (tagCache.data && Date.now() - tagCache.fetchedAt < TAG_CACHE_TTL_MS) {
    return tagCache.data;
  }

  try {
    const res = await fetch('https://store.steampowered.com/tagdata/populartags/english', {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const list = await res.json();
    const dict = {};
    for (const entry of list) {
      const id = entry.tagid ?? entry.id;
      const name = entry.name;
      if (id != null && name) dict[String(id)] = name;
    }
    if (Object.keys(dict).length === 0) throw new Error('empty tag list');

    tagCache = { data: dict, fetchedAt: Date.now() };
    fs.mkdirSync(path.dirname(TAG_CACHE_FILE), { recursive: true });
    fs.writeFileSync(TAG_CACHE_FILE, JSON.stringify(dict));
    return dict;
  } catch (err) {
    console.error('Failed to fetch Steam tag dictionary, falling back:', err.message);
    if (tagCache.data) return tagCache.data;
    try {
      const fallback = JSON.parse(fs.readFileSync(TAG_CACHE_FILE, 'utf8'));
      tagCache = { data: fallback, fetchedAt: Date.now() };
      return fallback;
    } catch {
      return {};
    }
  }
}

function resolveTagNames(tagIds, tagDict) {
  return (tagIds || []).map((id) => tagDict[id]).filter(Boolean);
}

function formatGameRecord(record, tagDict) {
  const snapshot = record.lastSearchSnapshot || {};
  const details = record.details;
  return {
    appid: record.appid,
    name: snapshot.name || (details && details.name) || 'Unknown',
    url: snapshot.url || `https://store.steampowered.com/app/${record.appid}/`,
    image: snapshot.image || null,
    releaseDate: (details && details.releaseDate) || snapshot.releaseDate || 'TBD',
    price: snapshot.price || { isFree: false, priceText: 'N/A' },
    review: snapshot.review || null,
    tags: resolveTagNames(snapshot.tagIds, tagDict),
    developers: details ? details.developers : [],
    publishers: details ? details.publishers : [],
    shortDescription: details ? details.shortDescription : '',
    screenshots: details ? details.screenshots : [],
    genres: details ? details.genres : [],
    detailsPending: !details,
    status: record.status,
    firstSeenAt: record.firstSeenAt,
    viewedAt: record.viewedAt,
  };
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/tags', async (req, res) => {
  const dict = await getTagDictionary();
  const tags = Object.entries(dict)
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ tags, count: tags.length, source: Object.keys(dict).length > 0 ? 'ok' : 'unavailable' });
});

app.get('/api/games', async (req, res) => {
  const { tags = '', term = '' } = req.query;

  try {
    const rows = await fetchComingSoonPages({ tags, term });
    const tagDict = await getTagDictionary();
    const now = Date.now();

    const candidates = [];
    for (const row of rows) {
      const record = db.upsertSeen(row.appid, row);
      if (record.status !== 'new') continue; // already shortlisted/dismissed - don't show again
      const age = now - new Date(record.firstSeenAt).getTime();
      if (age > NEW_WINDOW_MS) continue; // first seen more than 3 days ago
      candidates.push(record);
    }

    candidates.sort((a, b) => new Date(b.firstSeenAt) - new Date(a.firstSeenAt));

    let detailFetches = 0;
    for (const record of candidates) {
      if (record.details) continue;
      if (detailFetches >= MAX_DETAIL_FETCHES_PER_REQUEST) continue; // enrich the rest on a later refresh
      detailFetches += 1;
      try {
        const details = await fetchAppDetailsThrottled(record.appid);
        if (details) {
          db.setDetails(record.appid, details);
          record.details = details;
        }
      } catch (err) {
        console.error(`Failed to fetch appdetails for ${record.appid}:`, err.message);
      }
    }

    res.json({
      count: candidates.length,
      pendingDetailFetches: candidates.filter((r) => !r.details).length,
      games: candidates.map((r) => formatGameRecord(r, tagDict)),
    });
  } catch (err) {
    console.error('Failed to fetch/parse Steam search results:', err);
    res.status(502).json({
      error: 'Failed to reach Steam or parse its response. Steam may have changed its page layout.',
      detail: err.message,
    });
  }
});

app.get('/api/history', async (req, res) => {
  const tagDict = await getTagDictionary();
  const games = db
    .all()
    .filter((g) => g.status !== 'new')
    .sort((a, b) => new Date(b.viewedAt) - new Date(a.viewedAt))
    .map((g) => formatGameRecord(g, tagDict));
  res.json({ games });
});

app.get('/api/shortlist', async (req, res) => {
  const tagDict = await getTagDictionary();
  const games = db
    .all()
    .filter((g) => g.status === 'shortlisted')
    .sort((a, b) => new Date(b.viewedAt) - new Date(a.viewedAt))
    .map((g) => formatGameRecord(g, tagDict));
  res.json({ games });
});

app.post('/api/games/:appid/status', async (req, res) => {
  const { status } = req.body || {};
  if (!['new', 'shortlisted', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'status must be one of: new, shortlisted, dismissed' });
  }
  const record = db.setStatus(req.params.appid, status);
  if (!record) return res.status(404).json({ error: 'Unknown appid (has it been fetched yet?)' });
  const tagDict = await getTagDictionary();
  res.json({ game: formatGameRecord(record, tagDict) });
});

app.listen(PORT, () => {
  console.log(`Steam Publishing List Tool running at http://localhost:${PORT}`);
});

const express = require('express');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Maps the "list" filter chosen in the UI to the `filter` query param Steam's
// own store-search feed uses. These are the same tabs shown on the real
// store search page (New Releases / Upcoming Releases).
const LIST_FILTERS = {
  new: 'popularnew', // pages that just released
  comingsoon: 'comingsoon', // pages that appeared but haven't released yet
  all: '', // no tab filter, just sorted by release date
};

const SORT_OPTIONS = new Set([
  'Released_DESC',
  'Released_ASC',
  'Reviews_DESC',
  'Price_ASC',
  'Price_DESC',
  'Name_ASC',
]);

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

    games.push({
      appid,
      name,
      url,
      image,
      releaseDate,
      review,
      price,
    });
  });

  return games;
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/games', async (req, res) => {
  const {
    genre = '',
    list = 'new',
    sortBy = 'Released_DESC',
    term = '',
    count = '50',
    start = '0',
  } = req.query;

  const safeSort = SORT_OPTIONS.has(sortBy) ? sortBy : 'Released_DESC';
  const safeCount = Math.min(parseInt(count, 10) || 50, 100);
  const safeStart = Math.max(parseInt(start, 10) || 0, 0);
  const filterParam = Object.prototype.hasOwnProperty.call(LIST_FILTERS, list)
    ? LIST_FILTERS[list]
    : LIST_FILTERS.new;

  const params = new URLSearchParams({
    query: term,
    start: String(safeStart),
    count: String(safeCount),
    dynamic_data: '',
    sort_by: safeSort,
    category1: '998', // Games only (excludes DLC, soundtracks, software, etc.)
    supportedlang: 'english',
    ndl: '1',
    infinite: '1',
  });

  if (genre) params.set('genre', genre);
  if (filterParam) params.set('filter', filterParam);

  const steamUrl = `https://store.steampowered.com/search/results/?${params.toString()}`;

  try {
    const steamRes = await fetch(steamUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SteamPublishingListTool/1.0)',
        Accept: 'application/json, text/javascript, */*',
      },
    });

    if (!steamRes.ok) {
      throw new Error(`Steam responded with status ${steamRes.status}`);
    }

    const data = await steamRes.json();
    const games = parseSearchResults(data.results_html || '');

    res.json({
      totalCount: data.total_count ?? games.length,
      start: safeStart,
      count: games.length,
      games,
    });
  } catch (err) {
    console.error('Failed to fetch/parse Steam search results:', err);
    res.status(502).json({
      error: 'Failed to reach Steam or parse its response. Steam may have changed its page layout.',
      detail: err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Steam Publishing List Tool running at http://localhost:${PORT}`);
});

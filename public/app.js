const form = document.getElementById('filters');
const resultsEl = document.getElementById('results');
const statusEl = document.getElementById('status');
const refreshBtn = document.getElementById('refreshBtn');

function reviewClass(percent) {
  if (percent === null || percent === undefined) return 'unknown';
  if (percent >= 70) return 'positive';
  if (percent >= 40) return 'mixed';
  return 'negative';
}

function renderGames(games) {
  resultsEl.innerHTML = '';

  if (games.length === 0) {
    resultsEl.innerHTML = '<div class="empty-state">No games match these filters.</div>';
    return;
  }

  for (const game of games) {
    const card = document.createElement('a');
    card.className = 'game-card';
    card.href = game.url || '#';
    card.target = '_blank';
    card.rel = 'noopener noreferrer';

    const img = document.createElement('img');
    img.src = game.image || '';
    img.alt = game.name;
    img.loading = 'lazy';
    card.appendChild(img);

    const body = document.createElement('div');
    body.className = 'body';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = game.name;
    body.appendChild(name);

    const metaRow = document.createElement('div');
    metaRow.className = 'meta-row';
    const released = document.createElement('span');
    released.textContent = game.releaseDate || 'Unknown date';
    metaRow.appendChild(released);

    const priceEl = document.createElement('span');
    priceEl.className = 'price';
    if (game.price.isFree) {
      priceEl.textContent = 'Free to Play';
    } else if (game.price.originalPriceText && game.price.originalPriceText !== game.price.priceText) {
      priceEl.innerHTML = `<span class="original">${game.price.originalPriceText}</span>${game.price.priceText || 'N/A'}`;
    } else {
      priceEl.textContent = game.price.priceText || 'N/A';
    }
    metaRow.appendChild(priceEl);
    body.appendChild(metaRow);

    const badge = document.createElement('span');
    const cls = reviewClass(game.review?.percent);
    badge.className = `review-badge ${cls}`;
    if (game.review?.percent !== null && game.review?.percent !== undefined) {
      const countText = game.review.count ? ` (${game.review.count.toLocaleString()})` : '';
      badge.textContent = `${game.review.summary || ''} ${game.review.percent}%${countText}`.trim();
    } else {
      badge.textContent = 'No reviews yet';
    }
    body.appendChild(badge);

    card.appendChild(body);
    resultsEl.appendChild(card);
  }
}

function applyClientFilters(games, { minReview, maxPrice, freeOnly }) {
  return games.filter((game) => {
    if (freeOnly && !game.price.isFree) return false;

    if (minReview !== null) {
      const pct = game.review?.percent;
      if (pct === null || pct === undefined) return false;
      if (pct < minReview) return false;
    }

    if (maxPrice !== null && !game.price.isFree) {
      if (game.price.priceCents === null || game.price.priceCents === undefined) {
        // Unknown price - don't exclude, we simply can't verify it.
      } else if (game.price.priceCents / 100 > maxPrice) {
        return false;
      }
    }

    return true;
  });
}

async function loadGames() {
  const formData = new FormData(form);
  const params = new URLSearchParams({
    list: formData.get('list') || 'new',
    genre: formData.get('genre') || '',
    term: formData.get('term') || '',
    count: formData.get('count') || '50',
  });

  refreshBtn.disabled = true;
  statusEl.textContent = 'Loading...';
  resultsEl.innerHTML = '';

  try {
    const res = await fetch(`/api/games?${params.toString()}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Request failed');
    }

    const minReviewRaw = formData.get('minReview');
    const maxPriceRaw = formData.get('maxPrice');
    const filtered = applyClientFilters(data.games, {
      minReview: minReviewRaw ? parseInt(minReviewRaw, 10) : null,
      maxPrice: maxPriceRaw ? parseFloat(maxPriceRaw) : null,
      freeOnly: formData.get('freeOnly') === 'on',
    });

    renderGames(filtered);
    statusEl.textContent = `Showing ${filtered.length} of ${data.count} fetched (${data.totalCount.toLocaleString()} total matches on Steam). Last refreshed ${new Date().toLocaleTimeString()}.`;
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    resultsEl.innerHTML = '<div class="empty-state">Could not load results. Try refreshing.</div>';
  } finally {
    refreshBtn.disabled = false;
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  loadGames();
});

loadGames();

const form = document.getElementById('filters');
const resultsEl = document.getElementById('results');
const statusEl = document.getElementById('status');
const refreshBtn = document.getElementById('refreshBtn');
const tabButtons = document.querySelectorAll('.tab-btn');

const tagInput = document.getElementById('tagInput');
const tagSuggestions = document.getElementById('tagSuggestions');
const selectedTagsEl = document.getElementById('selectedTags');

let activeTab = 'new';
let allTags = []; // [{id, name}]
let selectedTags = new Map(); // id -> name

async function loadTagDictionary() {
  try {
    const res = await fetch('/api/tags');
    const data = await res.json();
    allTags = data.tags || [];
    if (data.source !== 'ok') {
      tagInput.placeholder = 'Tag list unavailable from Steam right now - try again later';
    }
  } catch {
    tagInput.placeholder = 'Tag list unavailable from Steam right now - try again later';
  }
}

function renderSelectedTags() {
  selectedTagsEl.innerHTML = '';
  for (const [id, name] of selectedTags) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.textContent = name;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      selectedTags.delete(id);
      renderSelectedTags();
    });
    chip.appendChild(removeBtn);
    selectedTagsEl.appendChild(chip);
  }
}

function renderTagSuggestions(query) {
  const q = query.trim().toLowerCase();
  if (!q) {
    tagSuggestions.hidden = true;
    tagSuggestions.innerHTML = '';
    return;
  }
  const matches = allTags
    .filter((t) => !selectedTags.has(t.id) && t.name.toLowerCase().includes(q))
    .slice(0, 20);

  if (matches.length === 0) {
    tagSuggestions.hidden = true;
    tagSuggestions.innerHTML = '';
    return;
  }

  tagSuggestions.innerHTML = '';
  for (const tag of matches) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = tag.name;
    btn.addEventListener('click', () => {
      selectedTags.set(tag.id, tag.name);
      renderSelectedTags();
      tagInput.value = '';
      tagSuggestions.hidden = true;
      tagSuggestions.innerHTML = '';
      tagInput.focus();
    });
    tagSuggestions.appendChild(btn);
  }
  tagSuggestions.hidden = false;
}

tagInput.addEventListener('input', () => renderTagSuggestions(tagInput.value));
tagInput.addEventListener('blur', () => {
  setTimeout(() => {
    tagSuggestions.hidden = true;
  }, 150);
});

function reviewClass(percent) {
  if (percent === null || percent === undefined) return 'unknown';
  if (percent >= 70) return 'positive';
  if (percent >= 40) return 'mixed';
  return 'negative';
}

function timeAgo(isoString) {
  if (!isoString) return '';
  const diffMs = Date.now() - new Date(isoString).getTime();
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function postStatus(appid, status) {
  const res = await fetch(`/api/games/${appid}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to update game status');
  }
}

function actionsForStatus(game) {
  const wrap = document.createElement('div');
  wrap.className = 'actions';

  if (game.status !== 'shortlisted') {
    const shortlistBtn = document.createElement('button');
    shortlistBtn.className = 'shortlist-btn';
    shortlistBtn.textContent = '★ Shortlist';
    shortlistBtn.addEventListener('click', async () => {
      shortlistBtn.disabled = true;
      try {
        await postStatus(game.appid, 'shortlisted');
        loadTab(activeTab);
      } catch (err) {
        alert(err.message);
        shortlistBtn.disabled = false;
      }
    });
    wrap.appendChild(shortlistBtn);
  }

  if (game.status !== 'dismissed') {
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'dismiss-btn';
    dismissBtn.textContent = '✕ Dismiss';
    dismissBtn.addEventListener('click', async () => {
      dismissBtn.disabled = true;
      try {
        await postStatus(game.appid, 'dismissed');
        loadTab(activeTab);
      } catch (err) {
        alert(err.message);
        dismissBtn.disabled = false;
      }
    });
    wrap.appendChild(dismissBtn);
  }

  if (game.status !== 'new') {
    const restoreBtn = document.createElement('button');
    restoreBtn.textContent = '↩ Move to New';
    restoreBtn.addEventListener('click', async () => {
      restoreBtn.disabled = true;
      try {
        await postStatus(game.appid, 'new');
        loadTab(activeTab);
      } catch (err) {
        alert(err.message);
        restoreBtn.disabled = false;
      }
    });
    wrap.appendChild(restoreBtn);
  }

  const steamLink = document.createElement('a');
  steamLink.href = game.url;
  steamLink.target = '_blank';
  steamLink.rel = 'noopener noreferrer';
  steamLink.textContent = 'View on Steam';
  wrap.appendChild(steamLink);

  return wrap;
}

function renderCard(game) {
  const card = document.createElement('div');
  card.className = 'game-card';

  const img = document.createElement('img');
  img.className = 'header-img';
  img.src = game.image || '';
  img.alt = game.name;
  img.loading = 'lazy';
  card.appendChild(img);

  if (game.screenshots && game.screenshots.length > 0) {
    const strip = document.createElement('div');
    strip.className = 'screenshot-strip';
    for (const src of game.screenshots) {
      const shot = document.createElement('img');
      shot.src = src;
      shot.loading = 'lazy';
      shot.alt = `${game.name} screenshot`;
      strip.appendChild(shot);
    }
    card.appendChild(strip);
  }

  const body = document.createElement('div');
  body.className = 'card-body';

  const titleRow = document.createElement('div');
  titleRow.className = 'title-row';
  const nameLink = document.createElement('a');
  nameLink.className = 'name';
  nameLink.href = game.url;
  nameLink.target = '_blank';
  nameLink.rel = 'noopener noreferrer';
  nameLink.textContent = game.name;
  titleRow.appendChild(nameLink);

  const seen = document.createElement('span');
  seen.className = 'first-seen';
  seen.textContent = game.viewedAt
    ? `${game.status} ${timeAgo(game.viewedAt)}`
    : `First seen ${timeAgo(game.firstSeenAt)}`;
  titleRow.appendChild(seen);
  body.appendChild(titleRow);

  const devpub = document.createElement('div');
  devpub.className = 'devpub';
  const devs = game.developers && game.developers.length ? game.developers.join(', ') : 'Unknown developer';
  const pubs = game.publishers && game.publishers.length ? game.publishers.join(', ') : 'Unknown publisher';
  devpub.textContent = `Developer: ${devs}  ·  Publisher: ${pubs}`;
  body.appendChild(devpub);

  if (game.shortDescription) {
    const desc = document.createElement('p');
    desc.className = 'description';
    desc.textContent = game.shortDescription;
    body.appendChild(desc);
  }

  if (game.detailsPending) {
    const pending = document.createElement('div');
    pending.className = 'pending-note';
    pending.textContent = 'Fetching more details from Steam - refresh again shortly for screenshots, developer & publisher.';
    body.appendChild(pending);
  }

  if (game.tags && game.tags.length > 0) {
    const chips = document.createElement('div');
    chips.className = 'tag-chips readonly';
    for (const tag of game.tags.slice(0, 8)) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.textContent = tag;
      chips.appendChild(chip);
    }
    body.appendChild(chips);
  }

  const metaRow = document.createElement('div');
  metaRow.className = 'meta-row';

  const released = document.createElement('span');
  released.textContent = `Release: ${game.releaseDate || 'TBD'}`;
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

  const badge = document.createElement('span');
  const cls = reviewClass(game.review && game.review.percent);
  badge.className = `review-badge ${cls}`;
  if (game.review && game.review.percent !== null && game.review.percent !== undefined) {
    const countText = game.review.count ? ` (${game.review.count.toLocaleString()})` : '';
    badge.textContent = `${game.review.summary || ''} ${game.review.percent}%${countText}`.trim();
  } else {
    badge.textContent = 'No reviews yet';
  }
  metaRow.appendChild(badge);

  if (game.status && game.status !== 'new') {
    const statusBadge = document.createElement('span');
    statusBadge.className = `status-badge ${game.status}`;
    statusBadge.textContent = game.status;
    metaRow.appendChild(statusBadge);
  }

  body.appendChild(metaRow);
  body.appendChild(actionsForStatus(game));

  card.appendChild(body);
  return card;
}

function renderGames(games, emptyMessage) {
  resultsEl.innerHTML = '';
  if (games.length === 0) {
    resultsEl.innerHTML = `<div class="empty-state">${emptyMessage}</div>`;
    return;
  }
  for (const game of games) {
    resultsEl.appendChild(renderCard(game));
  }
}

async function loadNew() {
  const params = new URLSearchParams({
    term: document.getElementById('term').value || '',
  });
  const tagIds = [...selectedTags.keys()];
  if (tagIds.length > 0) params.set('tags', tagIds.join(','));

  statusEl.textContent = 'Loading...';
  refreshBtn.disabled = true;
  resultsEl.innerHTML = '';

  try {
    const res = await fetch(`/api/games?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');

    renderGames(data.games, 'No new unreleased pages match these filters in the last 3 days.');
    const pendingNote = data.pendingDetailFetches > 0
      ? ` ${data.pendingDetailFetches} game(s) still need extra detail - refresh again shortly.`
      : '';
    statusEl.textContent = `${data.count} new page(s) found (first seen within 3 days, not yet actioned).${pendingNote} Last refreshed ${new Date().toLocaleTimeString()}.`;
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    resultsEl.innerHTML = '<div class="empty-state">Could not load results. Try refreshing.</div>';
  } finally {
    refreshBtn.disabled = false;
  }
}

async function loadListTab(endpoint, emptyMessage) {
  statusEl.textContent = 'Loading...';
  refreshBtn.disabled = true;
  resultsEl.innerHTML = '';

  try {
    const res = await fetch(endpoint);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    renderGames(data.games, emptyMessage);
    statusEl.textContent = `${data.games.length} game(s).`;
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    refreshBtn.disabled = false;
  }
}

function loadTab(tab) {
  if (tab === 'new') return loadNew();
  if (tab === 'shortlist') return loadListTab('/api/shortlist', 'No shortlisted games yet.');
  if (tab === 'history') return loadListTab('/api/history', 'No games have been reviewed yet.');
}

for (const btn of tabButtons) {
  btn.addEventListener('click', () => {
    for (const b of tabButtons) b.classList.remove('active');
    btn.classList.add('active');
    activeTab = btn.dataset.tab;
    form.hidden = activeTab !== 'new';
    loadTab(activeTab);
  });
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  loadTab('new');
});

loadTagDictionary();
renderSelectedTags();
loadTab(activeTab);

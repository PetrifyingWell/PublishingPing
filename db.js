const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDataDir();
  if (!fs.existsSync(DB_PATH)) return { games: {} };
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (err) {
    console.error('Failed to read db.json, starting fresh:', err.message);
    return { games: {} };
  }
}

const state = load();

function save() {
  ensureDataDir();
  fs.writeFileSync(DB_PATH, JSON.stringify(state, null, 2));
}

// Records that we've seen this appid in a live Steam search result. Creates
// a new "new" record on first sighting (this is what "first seen" tracking
// is based on), or refreshes the cached search snapshot on repeat sightings.
function upsertSeen(appid, searchSnapshot) {
  const now = new Date().toISOString();
  const existing = state.games[appid];
  if (existing) {
    existing.lastSeenAt = now;
    existing.lastSearchSnapshot = searchSnapshot;
  } else {
    state.games[appid] = {
      appid,
      firstSeenAt: now,
      lastSeenAt: now,
      status: 'new',
      viewedAt: null,
      details: null,
      lastSearchSnapshot: searchSnapshot,
    };
  }
  save();
  return state.games[appid];
}

function setDetails(appid, details) {
  if (!state.games[appid]) return;
  state.games[appid].details = details;
  save();
}

function setStatus(appid, status) {
  const game = state.games[appid];
  if (!game) return null;
  game.status = status;
  game.viewedAt = status === 'new' ? null : new Date().toISOString();
  save();
  return game;
}

function getGame(appid) {
  return state.games[appid];
}

function all() {
  return Object.values(state.games);
}

module.exports = { upsertSeen, setDetails, setStatus, getGame, all };

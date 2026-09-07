const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDataDir();
  if (!fs.existsSync(DB_PATH)) return { games: {}, knownAppIds: [], pendingClassification: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    return {
      games: parsed.games || {},
      knownAppIds: parsed.knownAppIds || [],
      pendingClassification: parsed.pendingClassification || [],
    };
  } catch (err) {
    console.error('Failed to read db.json, starting fresh:', err.message);
    return { games: {}, knownAppIds: [], pendingClassification: [] };
  }
}

const state = load();

function save() {
  ensureDataDir();
  fs.writeFileSync(DB_PATH, JSON.stringify(state, null, 2));
}

// --- App ID ledger: every appid we've ever observed in Steam's full app
// list, regardless of whether it turned out to be a game worth tracking.
// This is what lets us detect "just appeared on Steam" via diffing.

function getKnownAppIdSet() {
  return new Set(state.knownAppIds);
}

function isBootstrapped() {
  return state.knownAppIds.length > 0;
}

function addKnownAppIds(appids) {
  const set = getKnownAppIdSet();
  let changed = false;
  for (const id of appids) {
    if (!set.has(id)) {
      set.add(id);
      changed = true;
    }
  }
  if (changed) {
    state.knownAppIds = [...set];
    save();
  }
}

// --- Classification queue: newly-diffed appids waiting on an appdetails +
// tag lookup to determine whether they're a real, unreleased game.

function getPendingQueue() {
  return state.pendingClassification;
}

function enqueuePending(appids) {
  const queue = new Set(state.pendingClassification);
  for (const id of appids) queue.add(id);
  state.pendingClassification = [...queue];
  save();
}

function dequeuePending(appid) {
  state.pendingClassification = state.pendingClassification.filter((id) => id !== appid);
  save();
}

// --- Tracked games: appids that classified as real, unreleased games.

function createGame(appid, details) {
  const now = new Date().toISOString();
  state.games[appid] = {
    appid,
    firstSeenAt: now,
    status: 'new',
    viewedAt: null,
    details,
  };
  save();
  return state.games[appid];
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

module.exports = {
  getKnownAppIdSet,
  isBootstrapped,
  addKnownAppIds,
  getPendingQueue,
  enqueuePending,
  dequeuePending,
  createGame,
  setStatus,
  getGame,
  all,
};

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDataDir();
  if (!fs.existsSync(DB_PATH)) return { games: {}, knownAppIds: [], pendingClassification: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    return {
      games: parsed.games || {},
      knownAppIds: parsed.knownAppIds || [],
      // appid -> ISO timestamp of when it was first diffed as new (not when
      // it finishes classification, which can lag behind under a backlog).
      pendingClassification: parsed.pendingClassification || {},
    };
  } catch (err) {
    console.error('Failed to read db.json, starting fresh:', err.message);
    return { games: {}, knownAppIds: [], pendingClassification: {} };
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
// tag lookup to determine whether they're a real, unreleased game. Each
// entry remembers when it was *discovered* (diffed as new), independent of
// how long it then waits in the queue for its Steam calls to run.

function getPendingQueue() {
  return Object.entries(state.pendingClassification).map(([appid, discoveredAt]) => ({ appid, discoveredAt }));
}

function enqueuePending(appids) {
  const now = new Date().toISOString();
  let changed = false;
  for (const id of appids) {
    if (!(id in state.pendingClassification)) {
      state.pendingClassification[id] = now;
      changed = true;
    }
  }
  if (changed) save();
}

function dequeuePending(appid) {
  if (appid in state.pendingClassification) {
    delete state.pendingClassification[appid];
    save();
  }
}

// --- Tracked games: appids that classified as real, unreleased games.

function createGame(appid, details, firstSeenAt) {
  state.games[appid] = {
    appid,
    firstSeenAt: firstSeenAt || new Date().toISOString(),
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
  // Filters out any record missing details - defends against stale/
  // incompatible entries left behind by an older version of this schema.
  return Object.values(state.games).filter((g) => g.details);
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

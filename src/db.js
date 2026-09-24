const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new Database(path.join(config.dataDir, 'publishingping.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

  -- Every appid ever seen in Steam's app list. Diffing against this is how
  -- a brand new store page is detected.
  CREATE TABLE IF NOT EXISTS known_apps (appid INTEGER PRIMARY KEY, first_seen_at INTEGER NOT NULL);

  -- New pages. status: pending (waiting for public appdetails),
  -- tracking (a game we watch), ignored (DLC/software/NSFW/never went public).
  CREATE TABLE IF NOT EXISTS apps (
    appid INTEGER PRIMARY KEY,
    name TEXT,
    status TEXT NOT NULL,
    ignore_reason TEXT,
    first_seen_at INTEGER NOT NULL,
    appeared_at INTEGER,
    developers TEXT,
    publishers TEXT,
    demos TEXT,
    release_date TEXT,
    coming_soon INTEGER,
    header_image TEXT,
    details_checked_at INTEGER,
    next_follower_check_at INTEGER,
    followers INTEGER,
    notified_at INTEGER,
    retry_at INTEGER,
    was_hidden INTEGER DEFAULT 0,
    last_error TEXT
  );
  CREATE INDEX IF NOT EXISTS apps_status ON apps (status, next_follower_check_at);

  CREATE TABLE IF NOT EXISTS follower_snapshots (
    appid INTEGER NOT NULL,
    at INTEGER NOT NULL,
    followers INTEGER NOT NULL,
    PRIMARY KEY (appid, at)
  );
`);

const JSON_FIELDS = ['developers', 'publishers', 'demos'];

function hydrate(row) {
  if (!row) return row;
  for (const f of JSON_FIELDS) row[f] = row[f] ? JSON.parse(row[f]) : [];
  return row;
}

const stmts = {
  getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
  setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  allKnown: db.prepare('SELECT appid FROM known_apps'),
  insertKnown: db.prepare('INSERT OR IGNORE INTO known_apps (appid, first_seen_at) VALUES (?, ?)'),
  insertApp: db.prepare(
    "INSERT OR IGNORE INTO apps (appid, name, status, first_seen_at) VALUES (?, ?, 'pending', ?)"
  ),
  getApp: db.prepare('SELECT * FROM apps WHERE appid = ?'),
  pendingDue: db.prepare(
    "SELECT * FROM apps WHERE status = 'pending' AND (retry_at IS NULL OR retry_at <= ?) ORDER BY first_seen_at LIMIT ?"
  ),
  detailsDue: db.prepare(
    "SELECT * FROM apps WHERE status = 'tracking' AND notified_at IS NULL AND appeared_at >= ? AND details_checked_at < ? ORDER BY details_checked_at LIMIT ?"
  ),
  followersDue: db.prepare(
    "SELECT * FROM apps WHERE status = 'tracking' AND notified_at IS NULL AND appeared_at >= ? AND next_follower_check_at <= ? ORDER BY next_follower_check_at LIMIT ?"
  ),
  snapshots: db.prepare('SELECT at, followers FROM follower_snapshots WHERE appid = ? ORDER BY at'),
  insertSnapshot: db.prepare('INSERT OR REPLACE INTO follower_snapshots (appid, at, followers) VALUES (?, ?, ?)'),
  dashboard: db.prepare("SELECT * FROM apps WHERE status = 'tracking' AND appeared_at >= ? ORDER BY appeared_at DESC"),
  counts: db.prepare('SELECT status, COUNT(*) AS n FROM apps GROUP BY status'),
  pruneApps: db.prepare('DELETE FROM apps WHERE first_seen_at < ?'),
  pruneSnapshots: db.prepare('DELETE FROM follower_snapshots WHERE at < ?'),
};

function getMeta(key) {
  const row = stmts.getMeta.get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  stmts.setMeta.run(key, String(value));
}

function knownAppIdSet() {
  return new Set(stmts.allKnown.pluck().all());
}

const addKnown = db.transaction((appids, at) => {
  for (const id of appids) stmts.insertKnown.run(id, at);
});

const addNewApps = db.transaction((apps, at) => {
  for (const a of apps) {
    stmts.insertKnown.run(a.appid, at);
    stmts.insertApp.run(a.appid, a.name, at);
  }
});

function updateApp(appid, fields) {
  const cols = Object.keys(fields);
  if (cols.length === 0) return;
  const values = cols.map((c) => (JSON_FIELDS.includes(c) ? JSON.stringify(fields[c]) : fields[c]));
  db.prepare(`UPDATE apps SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE appid = ?`).run(...values, appid);
}

module.exports = {
  raw: db,
  getMeta,
  setMeta,
  knownAppIdSet,
  addKnown,
  addNewApps,
  updateApp,
  getApp: (appid) => hydrate(stmts.getApp.get(appid)),
  pendingDue: (now, limit) => stmts.pendingDue.all(now, limit).map(hydrate),
  detailsDue: (since, olderThan, limit) => stmts.detailsDue.all(since, olderThan, limit).map(hydrate),
  followersDue: (since, now, limit) => stmts.followersDue.all(since, now, limit).map(hydrate),
  snapshots: (appid) => stmts.snapshots.all(appid),
  addSnapshot: (appid, at, followers) => stmts.insertSnapshot.run(appid, at, followers),
  dashboard: (since) => stmts.dashboard.all(since).map(hydrate),
  counts: () => Object.fromEntries(stmts.counts.all().map((r) => [r.status, r.n])),
  prune: (before) => {
    stmts.pruneSnapshots.run(before);
    stmts.pruneApps.run(before);
  },
};

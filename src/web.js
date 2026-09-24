const express = require('express');
const config = require('./config');
const db = require('./db');
const { currentWindowGain, findQualifyingGain } = require('./criteria');
const { isCandidate } = require('./tracker');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function rows() {
  const now = Date.now();
  return db.dashboard(now - config.trackingWindowMs).map((app) => {
    const snaps = db.snapshots(app.appid);
    const hit = findQualifyingGain(snaps, app.appeared_at, {
      threshold: config.followerGainThreshold,
      gainWindowMs: config.gainWindowMs,
      trackingWindowMs: config.trackingWindowMs,
    });
    return {
      appid: app.appid,
      name: app.name,
      developers: app.developers,
      publishers: app.publishers,
      demoReleased: app.demos.some((d) => d.released),
      candidate: isCandidate(app),
      followers: app.followers,
      windowGain: currentWindowGain(snaps, app.appeared_at, config.gainWindowMs),
      crossed: !!hit,
      notifiedAt: app.notified_at,
      appearedAt: app.appeared_at,
      ageDays: +((now - app.appeared_at) / config.DAY).toFixed(1),
    };
  });
}

function page(list) {
  const sorted = [...list].sort((a, b) => b.windowGain - a.windowGain);
  const tr = sorted
    .map(
      (r) => `<tr class="${r.notifiedAt ? 'pinged' : r.candidate ? '' : 'muted'}">
        <td><a href="https://store.steampowered.com/app/${r.appid}/" target="_blank" rel="noopener">${esc(r.name)}</a></td>
        <td>${esc(r.developers.join(', '))}</td>
        <td>${esc(r.publishers.join(', '))}</td>
        <td>${r.demoReleased ? 'Yes' : 'No'}</td>
        <td class="n">${r.followers ?? '–'}</td>
        <td class="n">${r.windowGain}</td>
        <td class="n">${r.ageDays}</td>
        <td>${r.notifiedAt ? 'Pinged ' + new Date(r.notifiedAt).toISOString().slice(0, 16).replace('T', ' ') : r.candidate ? 'Watching' : 'Not a match'}</td>
      </tr>`
    )
    .join('');
  const counts = db.counts();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Publishing Ping</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--muted:#888;--line:#e5e5e5;--hl:#eaf6ea}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--muted:#777;--line:#2a2a2a;--hl:#1d321d}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,sans-serif}
h1{font-size:20px;margin:0 0 4px}p{color:var(--muted);margin:0 0 16px}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:760px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}th{font-weight:600}
td.n{text-align:right;font-variant-numeric:tabular-nums}a{color:inherit}
tr.muted td{color:var(--muted)}tr.pinged td{background:var(--hl)}
</style></head><body>
<h1>Publishing Ping</h1>
<p>New Steam pages from the last ${config.trackingWindowMs / config.DAY} days. A ping goes to Slack when a self-published page with no released demo gains
${config.followerGainThreshold}+ followers within ${config.gainWindowMs / config.DAY} days.
Tracking ${counts.tracking || 0} · pending ${counts.pending || 0} · ignored ${counts.ignored || 0}.</p>
<div class="wrap"><table><thead><tr><th>Game</th><th>Developer</th><th>Publisher</th><th>Demo</th><th>Followers</th><th>${config.gainWindowMs / config.DAY}-day gain</th><th>Age (days)</th><th>Status</th></tr></thead>
<tbody>${tr || '<tr><td colspan="8">Nothing tracked yet. New pages show up after the first app-list sync.</td></tr>'}</tbody></table></div>
</body></html>`;
}

function createServer() {
  const app = express();
  app.get('/', (req, res) => res.type('html').send(page(rows())));
  app.get('/api/tracked', (req, res) => res.json({ games: rows() }));
  app.get('/healthz', (req, res) =>
    res.json({
      ok: true,
      bootstrapped: !!db.getMeta('bootstrapped'),
      lastAppListSync: Number(db.getMeta('lastAppListSync')) || null,
      counts: db.counts(),
    })
  );
  return app;
}

module.exports = { createServer };

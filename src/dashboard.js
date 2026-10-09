const config = require('./config');
const store = require('./store');
const { currentWindowGain } = require('./criteria');
const reddit = require('./reddit');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function trackedRows() {
  const now = Date.now();
  const apps = await store.getApps(await store.trackedSince(now - config.trackingWindowMs));
  const games = apps
    .filter((a) => a.status === 'tracking')
    .map((a) => ({
      appid: a.appid,
      name: a.name,
      url: `https://store.steampowered.com/app/${a.appid}/`,
      developers: a.developers,
      publishers: a.publishers,
      demoReleased: (a.demos || []).some((d) => d.released),
      matches: !!a.candidate,
      followers: a.followers ?? null,
      checkedAt: (a.snapshots || []).length ? a.snapshots[a.snapshots.length - 1].at : null,
      gain: currentWindowGain(a.snapshots || [], a.appearedAt, config.gainWindowMs),
      appearedAt: a.appearedAt,
      notifiedAt: a.notifiedAt || null,
    }))
    .sort((x, y) => y.gain - x.gain);
  return {
    lastRun: Number(await store.getMeta('lastAppListSync')) || null,
    bootstrapped: !!(await store.getMeta('bootstrappedAt')),
    queues: await store.queueSizes(),
    games,
    reddit: await redditRows(),
  };
}

async function redditRows() {
  let subreddits = [];
  let error = null;
  try {
    subreddits = reddit.isConfigured() ? reddit.parseSubreddits(config.redditSubreddits) : [];
  } catch (err) {
    error = err.message; // a typo in REDDIT_SUBREDDITS shouldn't take the dashboard down
  }
  return { configured: reddit.isConfigured(), subreddits, error, posts: await reddit.recentPosts() };
}

function redditSection({ configured, subreddits, error, posts }) {
  if (error) return `<h2>Reddit</h2><p>${esc(error)}</p>`;
  if (!configured) {
    return '<h2>Reddit</h2><p>Not set up. Add REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET and REDDIT_SUBREDDITS in Vercel to turn it on.</p>';
  }
  const subs = subreddits.map((s) => `r/${esc(s.name)} (${s.threshold}+)`).join(', ');
  const rows = posts
    .map(
      (p) => `<tr class="${p.pingedAt ? 'pinged' : 'muted'}">
  <td><a href="${esc(p.permalink)}" target="_blank" rel="noopener">${esc(p.title)}</a></td>
  <td>r/${esc(p.subreddit)}</td>
  <td class="n">${p.score}</td>
  <td>${esc(ago(p.createdAt))}</td>
  <td>${p.pingedAt ? `Pinged ${esc(ago(p.pingedAt))}` : 'Already over on first check'}</td>
</tr>`
    )
    .join('');
  return `<h2>Reddit</h2><p>Posts from the last 7 days that passed their subreddit's threshold. Watching ${subs}.</p>
<div class="wrap"><table><thead><tr><th>Post</th><th>Subreddit</th><th>Upvotes</th><th>Posted</th><th>Status</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5">No posts over their threshold yet.</td></tr>'}</tbody></table></div>`;
}

const ago = (t) => {
  if (!t) return 'never';
  const h = (Date.now() - t) / config.HOUR;
  return h < 1 ? `${Math.round(h * 60)} min ago` : h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)} days ago`;
};

function renderPage({ lastRun, bootstrapped, games, reddit: redditData }) {
  const days = (ms) => ms / config.DAY;
  const rows = games
    .map(
      (g) => `<tr class="${g.notifiedAt ? 'pinged' : g.matches ? '' : 'muted'}">
  <td><a href="${esc(g.url)}" target="_blank" rel="noopener">${esc(g.name)}</a></td>
  <td>${esc(g.developers.join(', '))}</td>
  <td>${esc(g.publishers.join(', '))}</td>
  <td>${g.demoReleased ? 'Yes' : 'No'}</td>
  <td class="n">${g.followers ?? '–'}</td>
  <td>${g.matches && !g.notifiedAt ? esc(ago(g.checkedAt)) : '–'}</td>
  <td class="n">${g.matches ? g.gain : '–'}</td>
  <td>${esc(ago(g.appearedAt))}</td>
  <td>${g.notifiedAt ? `Pinged ${esc(ago(g.notifiedAt))}` : g.matches ? 'Watching' : 'Not a match'}</td>
</tr>`
    )
    .join('');
  const empty = bootstrapped
    ? 'No new pages yet. They show up after the next cron run.'
    : 'Waiting for the first cron run to record the current Steam catalog.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Publishing Ping</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--muted:#888;--line:#e5e5e5;--hl:#eaf6ea}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--muted:#777;--line:#2a2a2a;--hl:#1d321d}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,sans-serif}
h1{font-size:20px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 4px}p{color:var(--muted);margin:0 0 16px}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:760px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}th{font-weight:600}
td.n{text-align:right;font-variant-numeric:tabular-nums}a{color:inherit}
tr.muted td{color:var(--muted)}tr.pinged td{background:var(--hl)}
</style></head><body>
<h1>Publishing Ping</h1>
<h2 style="margin-top:8px">Steam</h2>
<p>New Steam pages from the last ${days(config.trackingWindowMs)} days. Slack gets a ping when a self-published page with no released demo
gains ${config.followerGainThreshold}+ followers within ${days(config.gainWindowMs)} days. Last run: ${esc(ago(lastRun))}.</p>
<div class="wrap"><table><thead><tr><th>Game</th><th>Developer</th><th>Publisher</th><th>Demo out</th><th>Followers</th><th>Checked</th>
<th>${days(config.gainWindowMs)}-day gain</th><th>Appeared</th><th>Status</th></tr></thead>
<tbody>${rows || `<tr><td colspan="9">${empty}</td></tr>`}</tbody></table></div>
${redditSection(redditData)}
</body></html>`;
}

module.exports = { trackedRows, renderPage };

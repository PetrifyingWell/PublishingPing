// Reddit check: each run reads every configured subreddit's top posts of the
// past week and pings Slack once for each post whose score has reached that
// subreddit's threshold. Reddit's listings already carry the live score, so
// no per-post history is needed - only which posts were already pinged.
const config = require('./config');
const store = require('./store');
const slack = require('./slack');

const K = {
  posts: 'pp:reddit:posts', // hash: post id -> JSON record of a post that passed its threshold
  bootstrapped: (sub) => `reddit:bootstrapped:${sub.toLowerCase()}`, // pp:meta field
};
const MAX_PAGES = 5; // 100 posts each; stops sooner once scores drop below the threshold

// "IndieGaming:500, indiegames:300" -> [{ name: 'IndieGaming', threshold: 500 }, ...]
function parseSubreddits(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, threshold] = entry.split(':').map((s) => s.trim());
      const n = Number(threshold);
      if (!name || !Number.isFinite(n) || n <= 0) {
        throw new Error(`REDDIT_SUBREDDITS entry "${entry}" should look like "IndieGaming:500".`);
      }
      return { name: name.replace(/^\/?r\//i, ''), threshold: n };
    });
}

function isConfigured() {
  return !!(config.redditClientId && config.redditClientSecret && config.redditSubreddits);
}

// --- Reddit API (application-only OAuth; needs a Reddit app's client id and secret).

let token = null; // { value, expiresAt }, reused while a function instance stays warm

async function redditFetch(url, init = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { 'User-Agent': config.redditUserAgent, ...(init.headers || {}) },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${url} responded with HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function getToken() {
  if (token && token.expiresAt > Date.now() + config.MINUTE) return token.value;
  const basic = Buffer.from(`${config.redditClientId}:${config.redditClientSecret}`).toString('base64');
  const data = await redditFetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!data.access_token) throw new Error(`Reddit didn't return an access token: ${JSON.stringify(data).slice(0, 300)}`);
  token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return token.value;
}

// Top posts of the past week, highest score first, down to `minScore`.
async function getTopPosts(subreddit, minScore) {
  const posts = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ t: 'week', limit: '100', raw_json: '1' });
    if (after) params.set('after', after);
    const data = await redditFetch(`https://oauth.reddit.com/r/${encodeURIComponent(subreddit)}/top?${params}`, {
      headers: { Authorization: `Bearer ${await getToken()}` },
    });
    const children = (data.data && data.data.children) || [];
    for (const c of children) posts.push(c.data);
    after = data.data && data.data.after;
    const last = children[children.length - 1];
    if (!after || !last || last.data.score < minScore) break;
  }
  return posts;
}

// --- Ping logic.

function toRecord(post, sub) {
  return {
    id: post.name, // "t3_abc123"
    subreddit: post.subreddit || sub.name,
    title: post.title,
    score: post.score,
    comments: post.num_comments,
    author: post.author,
    createdAt: Math.round(post.created_utc * 1000),
    permalink: `https://www.reddit.com${post.permalink}`,
    url: post.url_overridden_by_dest || null,
    thumbnail: /^https?:\/\//.test(post.thumbnail || '') ? post.thumbnail : null,
    threshold: sub.threshold,
  };
}

async function checkSubreddit(sub, log) {
  const posts = await getTopPosts(sub.name, sub.threshold);
  const seen = await store.redis().hgetall(K.posts);
  const firstRun = !(await store.getMeta(K.bootstrapped(sub.name)));
  let pinged = 0;
  let recorded = 0;

  for (const post of posts) {
    if (post.score < sub.threshold || post.stickied) continue;
    if (config.excludeNsfw && post.over_18) continue;
    const previous = seen[post.name] ? JSON.parse(seen[post.name]) : null;
    const record = { ...toRecord(post, sub), pingedAt: previous ? previous.pingedAt : null };

    if (!previous && !firstRun) {
      await slack.post(buildMessage(record));
      record.pingedAt = Date.now();
      pinged++;
      log(`PINGED r/${record.subreddit} "${record.title}" (${record.score} upvotes)`);
    }
    // Keeps the score current for the dashboard; first-run posts are stored
    // unpinged so they don't all ping at once.
    await store.redis().hset(K.posts, post.name, JSON.stringify(record));
    recorded++;
  }

  if (firstRun) {
    await store.setMeta(K.bootstrapped(sub.name), Date.now());
    log(`r/${sub.name}: first check, recorded ${recorded} post(s) already over ${sub.threshold} without pinging.`);
  }
  return pinged;
}

// Drops posts older than the retention period from the "already seen" hash.
async function prune() {
  const all = await store.redis().hgetall(K.posts);
  const cutoff = Date.now() - config.retentionMs;
  const old = Object.entries(all)
    .filter(([, raw]) => JSON.parse(raw).createdAt < cutoff)
    .map(([id]) => id);
  if (old.length) await store.redis().hdel(K.posts, ...old);
}

async function run(log) {
  if (!isConfigured()) return { skipped: 'REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET and REDDIT_SUBREDDITS are not all set' };
  const result = { pinged: 0, errors: 0 };
  for (const sub of parseSubreddits(config.redditSubreddits)) {
    try {
      result.pinged += await checkSubreddit(sub, log);
    } catch (err) {
      result.errors++;
      log(`Reddit check failed for r/${sub.name}: ${err.message}`);
    }
  }
  await prune();
  return result;
}

async function recentPosts() {
  const all = Object.values(await store.redis().hgetall(K.posts)).map((raw) => JSON.parse(raw));
  const since = Date.now() - 7 * config.DAY;
  return all.filter((p) => p.createdAt >= since).sort((a, b) => b.createdAt - a.createdAt);
}

// --- Slack message.

function age(ms) {
  const h = ms / config.HOUR;
  return h < 1 ? `${Math.max(1, Math.round(ms / config.MINUTE))} min` : h < 48 ? `${Math.round(h)}h` : `${(h / 24).toFixed(1)} days`;
}

function buildMessage(post, now = Date.now()) {
  const text = [
    `*<${post.permalink}|${post.title}>*`,
    `*${post.score.toLocaleString()} upvotes* in ${age(now - post.createdAt)} on r/${post.subreddit}  ·  ${post.comments.toLocaleString()} comments  ·  u/${post.author}`,
  ].join('\n');
  const section = { type: 'section', text: { type: 'mrkdwn', text } };
  if (post.thumbnail) section.accessory = { type: 'image', image_url: post.thumbnail, alt_text: post.title.slice(0, 100) };

  const buttons = [{ type: 'button', text: { type: 'plain_text', text: 'Reddit post' }, url: post.permalink }];
  if (post.url && !post.url.startsWith(post.permalink)) {
    const isSteam = /store\.steampowered\.com\/app\//.test(post.url);
    buttons.push({ type: 'button', text: { type: 'plain_text', text: isSteam ? 'Steam page' : 'Link' }, url: post.url });
  }
  return {
    text: `r/${post.subreddit}: "${post.title}" passed ${post.threshold} upvotes`,
    blocks: [section, { type: 'actions', elements: buttons }],
  };
}

module.exports = { run, recentPosts, parseSubreddits, buildMessage, isConfigured, K };

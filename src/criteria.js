// Pure functions for the three ping criteria. No I/O here so they can be
// unit tested directly (see test/criteria.test.js).

// Normalizes a studio name so trivial differences ("Foo Games" vs
// "foo games ", "Foo Games, LLC" vs "Foo Games") don't hide a match.
const COMPANY_SUFFIXES = /\b(inc|llc|ltd|limited|gmbh|s\.?r\.?o|s\.?a|oy|ab|co|corp|corporation|pty|plc|bv|kk)\b\.?/g;

function normalizeStudio(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(COMPANY_SUFFIXES, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

// Criterion 2: developer name(s) are the same as publisher name(s).
function isSelfPublished(developers, publishers) {
  const devs = new Set((developers || []).map(normalizeStudio).filter(Boolean));
  const pubs = new Set((publishers || []).map(normalizeStudio).filter(Boolean));
  if (devs.size === 0 || pubs.size === 0) return false;
  if (devs.size !== pubs.size) return false;
  for (const d of devs) if (!pubs.has(d)) return false;
  return true;
}

// Criterion 1: within the tracking window (first N days since the page
// appeared), is there any pair of observations no more than `gainWindowMs`
// apart where followers rose by at least `threshold`?
//
// `snapshots` is [{ at: epochMs, followers }]. The page's appearance is
// treated as an implicit 0-follower observation, so a page that is already
// on 180 followers the first time we look (a few minutes after it appeared)
// still counts. Returns the qualifying window { from, to, gain } with the
// earliest `to` (i.e. the moment it first crossed), or null.
function findQualifyingGain(snapshots, appearedAt, { threshold, gainWindowMs, trackingWindowMs }) {
  const end = appearedAt + trackingWindowMs;
  const points = [{ at: appearedAt, followers: 0, implicit: true }]
    .concat(snapshots.filter((s) => s.at >= appearedAt && s.at <= end))
    .sort((a, b) => a.at - b.at);

  // For each observation, compare against the lowest count seen in the
  // preceding window. Sliding-window minimum keeps this O(n).
  const deque = []; // indices into points, increasing followers
  let lo = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    while (lo < i && p.at - points[lo].at > gainWindowMs) lo++;
    while (deque.length && deque[0] < lo) deque.shift();
    if (deque.length) {
      const min = points[deque[0]];
      const gain = p.followers - min.followers;
      if (gain >= threshold) return { from: min, to: p, gain };
    }
    while (deque.length && points[deque[deque.length - 1]].followers >= p.followers) deque.pop();
    deque.push(i);
  }
  return null;
}

// The best gain ending at the latest observation, used to decide how soon to
// poll again (the closer to the threshold, the more often we look).
function currentWindowGain(snapshots, appearedAt, gainWindowMs) {
  if (snapshots.length === 0) return 0;
  const sorted = [...snapshots].sort((a, b) => a.at - b.at);
  const latest = sorted[sorted.length - 1];
  const since = latest.at - gainWindowMs;
  let min = since <= appearedAt ? 0 : Infinity;
  for (const s of sorted) if (s.at >= since && s.followers < min) min = s.followers;
  return latest.followers - min;
}

// Criterion 3: no demo released. `demos` is [{ appid, released }].
function hasReleasedDemo(demos) {
  return (demos || []).some((d) => d.released);
}

module.exports = { normalizeStudio, isSelfPublished, findQualifyingGain, currentWindowGain, hasReleasedDemo };

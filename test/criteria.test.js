const test = require('node:test');
const assert = require('node:assert');
const { isSelfPublished, findQualifyingGain, currentWindowGain, hasReleasedDemo } = require('../src/criteria');

const H = 3600 * 1000;
const D = 24 * H;
const opts = { threshold: 150, gainWindowMs: 5 * D, trackingWindowMs: 14 * D };
const T0 = Date.UTC(2026, 8, 1);
const snap = (days, followers) => ({ at: T0 + days * D, followers });

test('self-published: same names match, ignoring case, punctuation and company suffixes', () => {
  assert.ok(isSelfPublished(['Foo Games'], ['foo games']));
  assert.ok(isSelfPublished(['Foo Games, LLC'], ['Foo Games']));
  assert.ok(isSelfPublished(['Studio A', 'Studio B'], ['Studio B', 'Studio A']));
  assert.ok(!isSelfPublished(['Foo Games'], ['Big Publisher']));
  assert.ok(!isSelfPublished(['Foo Games'], ['Foo Games', 'Big Publisher']));
  assert.ok(!isSelfPublished([], []));
  assert.ok(!isSelfPublished(['Foo'], []));
});

test('demo: only a released demo counts', () => {
  assert.ok(!hasReleasedDemo([]));
  assert.ok(!hasReleasedDemo([{ appid: 1, released: false }]));
  assert.ok(hasReleasedDemo([{ appid: 1, released: true }]));
});

test('gain: 150 within 5 days triggers at the first crossing', () => {
  const hit = findQualifyingGain([snap(1, 10), snap(3, 100), snap(4, 170), snap(5, 400)], T0, opts);
  assert.ok(hit);
  assert.strictEqual(hit.to.at, T0 + 4 * D);
  assert.strictEqual(hit.gain, 170); // measured from the 0-follower appearance
});

test('gain: slow growth over more than 5 days does not trigger', () => {
  const snaps = [];
  for (let d = 0; d <= 13; d++) snaps.push(snap(d + 0.5, d * 25)); // 25/day = 125 per 5 days
  assert.strictEqual(findQualifyingGain(snaps, T0, opts), null);
});

test('gain: a burst later in the window triggers', () => {
  const hit = findQualifyingGain([snap(1, 50), snap(6, 60), snap(9, 100), snap(10.5, 260)], T0, opts);
  assert.ok(hit);
  assert.strictEqual(hit.from.followers, 60);
  assert.strictEqual(hit.gain, 200);
});

test('gain: 149 is not enough, 150 is', () => {
  assert.strictEqual(findQualifyingGain([snap(1, 149)], T0, opts), null);
  assert.ok(findQualifyingGain([snap(1, 150)], T0, opts));
});

test('gain: readings after 14 days are ignored', () => {
  assert.strictEqual(findQualifyingGain([snap(10, 50), snap(14.5, 500)], T0, opts), null);
});

test('gain: minimum is taken inside the window, not the whole history', () => {
  // By day 8 the day-0.1 reading is outside the 5-day window, so the gain is measured from 200.
  const hit = findQualifyingGain([snap(0.1, 140), snap(6, 200), snap(8, 360)], T0, opts);
  assert.ok(hit);
  assert.strictEqual(hit.from.followers, 200);
});

test('currentWindowGain uses appearance as 0 while still in the first 5 days', () => {
  assert.strictEqual(currentWindowGain([snap(1, 40), snap(2, 90)], T0, 5 * D), 90);
  assert.strictEqual(currentWindowGain([snap(3, 40), snap(7, 90)], T0, 5 * D), 50);
  assert.strictEqual(currentWindowGain([], T0, 5 * D), 0);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planChunks } from '../src/audio/chunker.js';

const FRAME_MS = 30;
const framesFor = (sec) => Math.round((sec * 1000) / FRAME_MS);

/** Builds an energy profile: loud everywhere except the given silent [from, to] second ranges. */
function profile(totalSec, silences = []) {
  const e = new Float32Array(framesFor(totalSec)).fill(0.3);
  for (const [a, b] of silences) e.fill(0, framesFor(a), framesFor(b));
  return e;
}

const opts = { frameMs: FRAME_MS, maxSec: 28, minSec: 18, silenceRms: 0.01, minSpeechMs: 250 };

test('short audio is a single chunk', () => {
  const chunks = planChunks(profile(12), opts);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].startSec, 0);
  assert.equal(chunks[0].silent, false);
});

test('cuts inside the pause, not at the hard limit', () => {
  const chunks = planChunks(profile(50, [[22, 23]]), opts);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].endSec >= 22 && chunks[0].endSec <= 23, `cut at ${chunks[0].endSec}`);
  assert.equal(chunks[1].startSec, chunks[0].endSec, 'chunks are contiguous, no overlap');
});

test('prefers the longest pause (sentence break) over a short one (comma), and cuts mid-pause', () => {
  const chunks = planChunks(profile(50, [[19, 19.3], [26, 26.3], [23, 24.5]]), opts);
  assert.ok(Math.abs(chunks[0].endSec - 23.75) < 0.1, `cut at ${chunks[0].endSec}`);
});

test('never exceeds max chunk length even without any pause', () => {
  const chunks = planChunks(profile(100), { ...opts, totalSec: 100 });
  for (const c of chunks) assert.ok(c.endSec - c.startSec <= 28 + 1e-9);
  assert.equal(chunks.at(-1).endSec, 100);
});

test('covers the whole timeline contiguously', () => {
  const chunks = planChunks(profile(300, [[40, 41], [95, 96.5], [150, 151]]), { ...opts, totalSec: 300 });
  assert.equal(chunks[0].startSec, 0);
  for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i].startSec, chunks[i - 1].endSec);
  assert.equal(chunks.at(-1).endSec, 300);
});

test('flags all-silent chunks so they can be skipped', () => {
  const chunks = planChunks(profile(60, [[0, 30]]), opts);
  assert.equal(chunks[0].silent, true);
  assert.equal(chunks.at(-1).silent, false);
});

test('clamps the final chunk to the real duration', () => {
  const chunks = planChunks(profile(10), { ...opts, totalSec: 9.995 });
  assert.equal(chunks.at(-1).endSec, 9.995);
});

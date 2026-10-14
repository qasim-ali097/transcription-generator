import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createMockEngine } from '../src/transcription/engines.js';
import { transcribeFile } from '../src/transcription/pipeline.js';
import { makeTmpDir, makeTone, testConfig } from './helpers.js';

let dir;
before(async () => (dir = await makeTmpDir()));
after(() => fs.rm(dir, { recursive: true, force: true }));

test('long file: silence-aligned chunks, timestamps on the global timeline, silence skipped', async () => {
  // 95 s: pauses at 20–21 s and 45–46 s, and a 30 s stretch of pure silence at the end.
  const input = await makeTone(path.join(dir, 'long.mp3'), {
    durationSec: 95,
    gaps: [[20, 21], [45, 46], [65, 95]],
  });
  const config = testConfig(dir);
  const progress = [];

  const result = await transcribeFile(input, {
    engine: createMockEngine(),
    config,
    onProgress: (p) => progress.push(p),
  });

  assert.ok(Math.abs(result.durationSec - 95) < 0.2);
  assert.ok(result.metadata.chunks >= 3);
  assert.ok(result.metadata.silentChunksSkipped >= 1, 'trailing silence is skipped');

  // The mock engine emits "+0s" at the start of every chunk it sees, which reveals the cut points:
  // they must land inside the pauses, and the offsets must be on the file's timeline.
  const chunkStarts = result.segments.filter((s) => s.text.endsWith('+0s')).map((s) => s.start);
  assert.equal(chunkStarts[0], 0);
  assert.ok(chunkStarts[1] >= 20 && chunkStarts[1] <= 21, `second chunk starts at ${chunkStarts[1]}`);
  assert.ok(chunkStarts[2] >= 45 && chunkStarts[2] <= 46, `third chunk starts at ${chunkStarts[2]}`);

  for (let i = 1; i < result.segments.length; i++) {
    assert.ok(result.segments[i].start >= result.segments[i - 1].end, 'monotonic timestamps');
  }
  assert.ok(result.segments.at(-1).end < 95, 'the all-silent final chunk was never sent to the engine');
  assert.equal(result.text, result.segments.map((s) => s.text).join(' '));

  assert.deepEqual(progress.at(-1), { chunksDone: result.metadata.chunks, chunksTotal: result.metadata.chunks });

  const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith('.f32'));
  assert.deepEqual(leftovers, [], 'temporary PCM is cleaned up');
});

test('enforces the maximum duration', async () => {
  const input = await makeTone(path.join(dir, 'too-long.wav'), { durationSec: 5 });
  await assert.rejects(
    transcribeFile(input, { engine: createMockEngine(), config: testConfig(dir, { maxDurationSec: 3 }) }),
    { code: 'AUDIO_TOO_LONG', status: 413 },
  );
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { normalizeAudio, readSamples, SAMPLE_RATE } from '../src/audio/decode.js';
import { probeAudio } from '../src/audio/probe.js';
import { makeSilentVideo, makeTmpDir, makeTone } from './helpers.js';

let dir;
before(async () => (dir = await makeTmpDir()));
after(() => fs.rm(dir, { recursive: true, force: true }));

for (const ext of ['wav', 'mp3', 'flac', 'ogg', 'm4a']) {
  test(`${ext}: probes and normalizes to 16 kHz mono float32`, async () => {
    const input = await makeTone(path.join(dir, `tone.${ext}`), { durationSec: 4, gaps: [[2, 3]] });

    const media = await probeAudio(input);
    assert.equal(media.channels, 2);
    assert.ok(Math.abs(media.durationSec - 4) < 0.1, `probe duration ${media.durationSec}`);

    const audio = await normalizeAudio(input, path.join(dir, `tone-${ext}.f32`));
    assert.equal(audio.sampleRate, SAMPLE_RATE);
    // Lossy codecs add encoder padding; allow a little slack.
    assert.ok(Math.abs(audio.durationSec - 4) < 0.1, `decoded duration ${audio.durationSec}`);

    const { size } = await fs.stat(audio.path);
    assert.equal(size, audio.totalSamples * 4);

    // The energy profile sees the silent gap at 2–3 s and the tone around it.
    const at = (sec) => audio.energies[Math.floor((sec * 1000) / audio.frameMs)];
    assert.ok(at(1) > 0.1, `tone energy ${at(1)}`);
    assert.ok(at(2.5) < 0.01, `gap energy ${at(2.5)}`);

    const samples = await readSamples(audio.path, SAMPLE_RATE, SAMPLE_RATE + 1600);
    assert.equal(samples.length, 1600);
  });
}

test('rejects a file that is not audio', async () => {
  const file = path.join(dir, 'notes.mp3'); // lying extension
  await fs.writeFile(file, 'definitely not audio');
  await assert.rejects(probeAudio(file), { code: 'UNSUPPORTED_MEDIA', status: 415 });
});

test('rejects a video with no audio track', async () => {
  const file = await makeSilentVideo(path.join(dir, 'video.mp4'));
  await assert.rejects(probeAudio(file), { code: 'NO_AUDIO_STREAM', status: 415 });
});

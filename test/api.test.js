import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import { JobQueue } from '../src/jobs/jobQueue.js';
import { createMockEngine } from '../src/transcription/engines.js';
import { makeTmpDir, makeTone, testConfig } from './helpers.js';

let dir;
let server;
let queue;
let base;
let shortWav;
let longMp3;

before(async () => {
  dir = await makeTmpDir();
  shortWav = await makeTone(path.join(dir, 'short.wav'), { durationSec: 8, gaps: [[4, 5]] });
  longMp3 = await makeTone(path.join(dir, 'long.mp3'), { durationSec: 70, gaps: [[25, 26]] });

  queue = new JobQueue({ concurrency: 1 });
  const app = createApp({ engine: createMockEngine(), queue, config: testConfig(dir) });
  await new Promise((resolve) => (server = app.listen(0, resolve)));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  queue.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(dir, { recursive: true, force: true });
});

async function upload(filePath, fields = {}, query = '') {
  const form = new FormData();
  form.append('file', new Blob([await fs.readFile(filePath)]), path.basename(filePath));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return fetch(`${base}/transcribe${query}`, { method: 'POST', body: form });
}

test('short file is transcribed synchronously with per-segment timestamps', async () => {
  const res = await upload(shortWav);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.segments.length > 0);
  for (const s of body.segments) {
    assert.equal(typeof s.start, 'number');
    assert.equal(typeof s.end, 'number');
    assert.ok(s.end >= s.start);
  }
  assert.equal(body.metadata.source.codec, 'pcm_s16le');
});

test('sync request can return SRT directly', async () => {
  const res = await upload(shortWav, {}, '?format=srt');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /subrip/);
  assert.match(await res.text(), /^1\n00:00:00,000 --> /);
});

test('long file becomes an async job; poll status then fetch the result', async () => {
  const res = await upload(longMp3);
  assert.equal(res.status, 202);
  const job = await res.json();
  assert.equal(res.headers.get('location'), `/jobs/${job.id}`);

  let status;
  for (let i = 0; i < 100; i++) {
    status = await (await fetch(`${base}/jobs/${job.id}`)).json();
    if (status.status === 'completed' || status.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(status.status, 'completed');
  assert.equal(status.progress.chunksDone, status.progress.chunksTotal);

  const result = await (await fetch(`${base}/jobs/${job.id}/result`)).json();
  assert.ok(result.durationSec > 69);
  assert.ok(result.metadata.chunks >= 3);

  const vtt = await (await fetch(`${base}/jobs/${job.id}/result?format=vtt`)).text();
  assert.match(vtt, /^WEBVTT/);
});

test('async=true forces a job even for short files', async () => {
  const res = await upload(shortWav, { async: 'true' });
  assert.equal(res.status, 202);
});

test('missing file -> 400', async () => {
  const res = await fetch(`${base}/transcribe`, { method: 'POST', body: new FormData() });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'NO_FILE');
});

test('non-audio upload -> 415 and the upload is not kept', async () => {
  const bogus = path.join(dir, 'bogus.wav');
  await fs.writeFile(bogus, 'hello');
  const res = await upload(bogus);
  assert.equal(res.status, 415);
  assert.equal((await res.json()).error.code, 'UNSUPPORTED_MEDIA');
});

test('unknown format -> 400; unknown job -> 404', async () => {
  assert.equal((await upload(shortWav, {}, '?format=docx')).status, 400);
  assert.equal((await fetch(`${base}/jobs/nope`)).status, 404);
});

test('uploaded files are deleted after processing', async () => {
  await new Promise((r) => setTimeout(r, 200)); // let the async job above finish
  const uploads = await fs.readdir(path.join(dir, 'uploads'));
  assert.deepEqual(uploads, []);
});

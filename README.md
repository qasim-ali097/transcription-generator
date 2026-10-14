# Transcription Service

A Node.js transcription pipeline: upload an audio file in any common format and get back the text with **per-segment timestamps**. It is exposed as an HTTP API and as a CLI.

Speech-to-text uses **open-source Whisper running locally** through [transformers.js](https://github.com/huggingface/transformers.js) (ONNX Runtime). There's no Python, no paid API, and audio never leaves the machine.

**Contents:** [Quick start](#quick-start) · [API](#api) · [Design decisions](#design-decisions) (formats, long audio) · [Verified results](#verified-results-cpu-whisper-base-q8) · [Tests](#tests) · [System design: scaling to production](#system-design-scaling-to-production) (concurrent uploads, storage, retries, API)

```
POST /transcribe  ──►  probe (ffprobe)  ──►  normalize (ffmpeg → 16 kHz mono PCM, streamed to disk)
                                                   │  + per-frame energy profile
                                                   ▼
                       silence-aligned chunk plan (≤ 28 s, cut in the longest pause, silent chunks skipped)
                                                   ▼
                       Whisper, one chunk at a time ──► shift timestamps onto file timeline
                                                   ▼
                       clean segments ──► JSON | TXT | SRT | VTT
```

## Quick start

Requirements: Node.js ≥ 22.9. ffmpeg comes bundled through `ffmpeg-static`/`ffprobe-static`. If that download fails, any ffmpeg on `PATH` is used instead.

```bash
npm install
npm start                      # http://localhost:3000; first run downloads the model (~80 MB, cached)
```

```bash
curl -F file=@samples/speech.mp3 http://localhost:3000/transcribe
```

No audio handy? On Windows, `npm run samples` generates speech files with the built-in TTS voice.

## API

| Method | Path | Description |
|---|---|---|
| `POST` | `/transcribe` | multipart field `file`. Optional: `language` (`en`, `fr`, …; auto-detected if omitted), `format` (`json`/`txt`/`srt`/`vtt`), `async=true` |
| `GET` | `/jobs/:id` | Job status, queue position, progress `{chunksDone, chunksTotal}` |
| `GET` | `/jobs/:id/result?format=…` | Finished result in any format (409 while still running) |
| `GET` | `/health` | Engine and queue stats |

**Sync vs async.** Files up to `SYNC_MAX_DURATION_SEC` (default 60 s) are answered in the same request with `200`. Longer files (or `async=true`) return `202 Accepted` with a `Location: /jobs/{id}` header to poll.

```jsonc
// 200 OK
{
  "text": "Welcome to the transcription pipeline demo. This service accepts audio files ...",
  "language": null,
  "durationSec": 12.9,
  "segments": [
    { "id": 0, "start": 0,    "end": 2.56,  "text": "Welcome to the transcription pipeline demo." },
    { "id": 1, "start": 3.32, "end": 8.66,  "text": "This service accepts audio files in many formats, converts them to a standard format," },
    { "id": 2, "start": 8.96, "end": 12.04, "text": "and returns the text with timestamps for every segment." }
  ],
  "metadata": {
    "engine": "whisper:Xenova/whisper-base",
    "source": { "container": "mp3", "codec": "mp3", "sampleRate": 22050, "channels": 1, "durationSec": 12.96 },
    "chunks": 1, "silentChunksSkipped": 0, "processingSec": 9.89
  }
}
```

Errors are JSON `{ "error": { "code", "message", "status" } }`. The main cases:

| Status | Code | Meaning |
|---|---|---|
| 400 | `NO_FILE`, `BAD_FORMAT` | Missing upload, or unknown output format |
| 413 | `LIMIT_FILE_SIZE`, `AUDIO_TOO_LONG` | Upload or duration over the configured limit |
| 415 | `UNSUPPORTED_MEDIA`, `NO_AUDIO_STREAM` | Not media, or media with no audio track |
| 422 | `DECODE_FAILED`, `EMPTY_AUDIO` | ffmpeg could not decode the audio |

## CLI

```bash
node bin/transcribe.js samples/long.mp3 --format srt --language en --out long.srt
node bin/transcribe.js meeting.m4a --model Xenova/whisper-small     # more accurate, slower
node bin/transcribe.js anything.wav --engine mock                    # no model, for wiring checks
```

## Design decisions

### Accepting files
- `multer` writes uploads to disk, not memory, under a random UUID name, so the client's filename is never used as a path. Size limits are enforced while the upload streams in.
- The file is **probed with ffprobe before it is queued**, so a bad upload gets a clear 4xx immediately instead of failing later in a background job. Uploads and temporary PCM files are always deleted in `finally` blocks.

### Different audio formats
- The detected format is trusted, **not the extension or Content-Type**: a text file renamed to `.mp3` is rejected with 415.
- Every input is converted with ffmpeg into one canonical format: **16 kHz, mono, float32 PCM**, which is what Whisper expects. WAV, MP3, M4A/AAC, FLAC, OGG/Opus, WebM, and even video files (the audio track is extracted with `-vn`) all follow the same path. The model code only ever sees one format.
- Tests generate stereo 44.1 kHz WAV, MP3, FLAC, OGG and M4A files and check they all normalize correctly.

### Long audio files
1. **Streaming decode.** ffmpeg's output is streamed to a raw file on disk and never held in memory (1 h of float32 audio is about 230 MB). In the same pass, a short **RMS energy value per 30 ms frame** is computed. That small array is all the chunker needs.
2. **Silence-aligned chunking.** Whisper sees 30 s at a time. Fixed 30 s cuts split words and cause errors at every boundary; the common workaround is overlapping windows plus de-duplication. Instead, the chunker cuts in the **middle of the longest pause** within an 18–28 s window, i.e. between sentences. Chunks are back-to-back with no overlap and nothing to de-duplicate. If there is no pause at all, it falls back to the quietest frame, so no chunk ever goes over the limit.
3. **Skip silence.** Chunks with less than 250 ms of voiced audio are never sent to the model. This saves compute, and Whisper tends to invent text ("Thank you.") on silence.
4. **One chunk in memory at a time.** Each chunk is read from the raw file by byte offset, transcribed, and its timestamps are shifted by the chunk's start time onto the file's timeline.
5. **Async jobs with progress.** Long files return 202 right away. The client polls `/jobs/:id` and sees chunk-level progress.
6. **Bounded concurrency.** *All* work, sync or async, goes through one FIFO queue (`JOB_CONCURRENCY`, default 1), so a burst of requests can't overload the CPU with parallel model inference.
7. **Limits.** Configurable maximum upload size and maximum duration. Duration is checked from the probe up front and again from the decoded length, because VBR MP3 headers can be wrong.

### Post-processing for downstream use
The pipeline normalizes whitespace and drops empty segments, non-speech tags (`[BLANK_AUDIO]`, `(music)`), zero-length artifacts and immediate repeats (Whisper's "stuck in a loop" failure). It guarantees monotonic timestamps rounded to 10 ms and stable segment ids. Results can be exported as JSON, plain text, SRT or WebVTT.

### Swappable engine
Everything above the engine layer works with any engine. An engine is just `transcribe(Float32Array, { language }) → [{ start, end, text }]`. Two are included:
- `whisper`: transformers.js, with any Whisper checkpoint from the Hugging Face Hub (`tiny.en` up to `large-v3`).
- `mock`: deterministic fake segments, so the HTTP layer, queue and chunking can be tested in seconds without a model.

A cloud engine (Deepgram, AssemblyAI, OpenAI) or a `whisper.cpp` binding would be one more function with the same signature.

## Verified results (CPU, `whisper-base` q8)

| Input | Audio | Chunks | Wall time | Outcome |
|---|---|---|---|---|
| `speech.mp3` | 12.9 s | 1 | ~9.9 s | Word-for-word correct, 3 timed segments |
| `long.mp3` (3× script + 20 s silence) | 152 s | 7 (1 silent, skipped) | ~55 s (≈2.8× real-time) | Word-for-word correct across all chunk boundaries; nothing transcribed in the silent tail |

The first version of the chunker cut at the *last* quiet frame, which landed on comma pauses right before the next word. That produced a hallucinated phrase at one boundary. Cutting in the middle of the *longest* pause fixed it, and there's a regression test for it in `test/chunker.test.js`.

## Tests

```bash
npm test
```

28 tests run against the mock engine and real ffmpeg, with fixtures generated at test time:
- **chunker:** cuts land inside pauses, the longest pause wins, the max length is never exceeded, chunks are contiguous, silent chunks are flagged.
- **audio:** 5 formats normalize to 16 kHz mono; fake media and audio-less video are rejected.
- **pipeline:** a 95 s file chunks at its pauses, timestamps land on the global timeline, the silent tail is skipped, temp files are cleaned up, the duration limit is enforced.
- **API:** sync JSON/SRT, async 202 → poll → result → VTT, 400/404/415 errors, uploads deleted afterwards.
- **post-processing and formats:** artifact removal, monotonic timestamps, SRT/VTT timecodes.

## Configuration

Settings are environment variables; `.env` is loaded automatically by the npm scripts. See [.env.example](.env.example). The main ones are `WHISPER_MODEL`, `WHISPER_DTYPE`, `SYNC_MAX_DURATION_SEC`, `MAX_UPLOAD_MB`, `MAX_DURATION_SEC`, `JOB_CONCURRENCY` and `SILENCE_RMS`.

## System design: scaling to production

This repo is a single process: an in-memory queue, local temp files, CPU inference. Below is how I'd turn it into a multi-tenant production service, and what each part builds on in the current code.

```
 Client ──► API (stateless, behind a load balancer) ──► Postgres (jobs, segments)
   │            │  auth, rate limits, validation           ▲
   │            └──► Queue (BullMQ/Redis or SQS) ──► Workers (GPU, autoscaled on queue depth)
   │                                                        │  probe → normalize → chunk → transcribe
   └── presigned upload ──► S3 (audio, exports) ◄───────────┘  checkpoint each chunk's result
                                                           └──► webhook to client when done
```

### Concurrent uploads

- **Separate accepting work from doing it.** This already holds in the repo: uploads stream to disk with size limits enforced during the upload, every file is checked with ffprobe before it's queued, and *all* transcription goes through one FIFO queue with a concurrency limit. A burst of 100 uploads is accepted quickly, but only `JOB_CONCURRENCY` transcriptions run on the CPU at once; the rest wait and report their queue position.
- **Upload straight to storage.** Clients upload to S3 through presigned URLs, so API servers never handle the audio bytes and stay light, stateless and horizontally scalable.
- **Durable queue and worker pool.** Jobs go on BullMQ/Redis or SQS. Separate workers (GPU, if available) scale with queue depth. Chunks are independent, so one long file can be spread across several workers.
- **Protection.** Per-client rate limits and quotas, `429` when the queue is too deep, an `Idempotency-Key` header so a retried upload doesn't create a duplicate job, and content-hash deduplication so identical files aren't transcribed twice.

### Storing audio and transcripts

- **Audio in object storage** (S3/GCS), stored under the job ID, encrypted at rest (SSE-KMS) and accessed through short-lived presigned URLs. A lifecycle rule deletes raw audio after a retention period (e.g. 30 days): audio is large and may contain personal data, while the transcript is the long-term record.
- **Job metadata in Postgres:** a `jobs` table (id, owner, status, progress, attempts, source format, duration, model, error, timestamps). Status polling reads from here.
- **Transcripts:** full text plus segments, either as a JSONB column or a `segments(job_id, idx, start, end, text)` table, which makes time-range queries easy. Full-text search uses Postgres `tsvector`, or OpenSearch at larger scale.
- **Per-chunk results** are saved as each chunk finishes, so a failed job can resume (see below).
- **Exports** (SRT, VTT, TXT) are generated on demand from the stored segments, as `src/transcription/formats.js` already does, and cached in S3 if they're requested often.

### Retrying and recovering failed transcriptions

- **Separate permanent failures from temporary ones.** This already exists: bad input (not audio, no audio track, too long, can't be decoded) raises a `PipelineError` with a 4xx code, so the job fails immediately with a clear message and is never retried, because a corrupt file won't get better.
- **Temporary failures** (worker crash, out of memory, timeout, model or network errors) are retried with exponential backoff and jitter, up to about 3 attempts. After that the job goes to a dead-letter queue, raises an alert, and can be re-run with `POST /jobs/:id/retry`.
- **Resume, don't restart.** Because each chunk's result is saved, a retry skips the chunks that already finished, which matters for hour-long files.
- **Crashed workers.** Heartbeats plus a visibility timeout (BullMQ stalled-job detection or SQS visibility) put a dead worker's job back on the queue automatically. Each chunk has its own timeout so one bad chunk can't stall the whole job.
- **Fallback.** A chunk that keeps failing can be retried on a different engine or model, which the engine interface makes easy to swap. Jobs are keyed by ID, so re-running one never creates a duplicate.

### Exposing it as an API

The core already exists (`POST /transcribe`, `GET /jobs/:id`, `GET /jobs/:id/result?format=`, `GET /health`, and one JSON error format). For production:

| Endpoint | Purpose |
|---|---|
| `POST /v1/uploads` | Returns a presigned S3 URL for large files |
| `POST /v1/transcriptions` | `{ upload_id \| audio_url, language?, callback_url? }`, or multipart for small files. Short files return `200` with the result; others return `202` plus a `Location` header |
| `GET /v1/transcriptions/:id` | Status, queue position, chunk progress |
| `GET /v1/transcriptions/:id/result?format=json\|txt\|srt\|vtt` | Result in any format |
| `GET /v1/transcriptions` | List, with cursor pagination |
| `POST /v1/transcriptions/:id/retry` | Manual re-run of a failed job |

- Versioned under `/v1` and documented with OpenAPI.
- Authenticated with API keys or OAuth, with per-key rate limits, `Idempotency-Key` support and request IDs for tracing.
- An HMAC-signed `callback_url` webhook as an alternative to polling.
- Later: a WebSocket endpoint that streams live audio and returns partial transcripts in real time.

### Other improvements

- **GPU inference** (whisper.cpp with CUDA, or faster-whisper behind a small service) for about 10–50× throughput, and a larger model.
- **A neural VAD** (Silero) instead of energy-based silence detection, for noisy recordings where an energy threshold isn't reliable.
- **Optional extras:** speaker diarization, word-level timestamps (`return_timestamps: 'word'`), and reporting the detected language.
- **Observability:** structured logs, metrics (real-time factor, queue depth, failure rate, time per chunk), and tracing across the API, queue and workers.

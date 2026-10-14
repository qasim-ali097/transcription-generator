import os from 'node:os';
import path from 'node:path';

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const float = (value, fallback) => {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
};

const env = process.env;

export const config = Object.freeze({
  port: int(env.PORT, 3000),

  // 'whisper' runs a local open-source Whisper model; 'mock' returns fake segments (tests / demos without a model).
  engine: env.ENGINE ?? 'whisper',
  whisperModel: env.WHISPER_MODEL ?? 'Xenova/whisper-base',
  // q8 = 8-bit quantized weights: ~4x smaller download, fast on CPU, negligible accuracy loss for base/small.
  whisperDtype: env.WHISPER_DTYPE ?? 'q8',

  tmpDir: env.TMP_DIR ?? path.join(os.tmpdir(), 'transcription-service'),
  maxUploadBytes: int(env.MAX_UPLOAD_MB, 500) * 1024 * 1024,
  maxDurationSec: int(env.MAX_DURATION_SEC, 4 * 60 * 60),
  // Files at or below this duration are answered in the same HTTP request; longer ones become async jobs.
  syncMaxDurationSec: int(env.SYNC_MAX_DURATION_SEC, 60),

  chunk: Object.freeze({
    // Whisper's receptive field is 30 s; stay just under it.
    maxSec: float(env.CHUNK_MAX_SEC, 28),
    // Never cut earlier than this, so we look for a pause in the [minSec, maxSec] window.
    minSec: float(env.CHUNK_MIN_SEC, 18),
    frameMs: 30,
    // RMS below this counts as silence (~ -40 dBFS).
    silenceRms: float(env.SILENCE_RMS, 0.01),
    // A chunk with less voiced audio than this is skipped (Whisper hallucinates on silence).
    minSpeechMs: 250,
  }),

  jobConcurrency: int(env.JOB_CONCURRENCY, 1),
  jobTtlMs: int(env.JOB_TTL_MIN, 60) * 60 * 1000,
});

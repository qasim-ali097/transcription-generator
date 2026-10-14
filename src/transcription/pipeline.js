import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { planChunks } from '../audio/chunker.js';
import { normalizeAudio, readSamples, SAMPLE_RATE } from '../audio/decode.js';
import { probeAudio } from '../audio/probe.js';
import { PipelineError } from '../errors.js';
import { cleanSegments, joinText } from './postprocess.js';

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * End-to-end transcription of one file:
 *
 *   probe (validate) -> normalize to 16 kHz mono PCM (streamed to disk)
 *   -> plan silence-aligned chunks -> transcribe chunk by chunk (only one chunk in memory)
 *   -> shift timestamps onto the file timeline -> clean -> result
 *
 * @param {string} inputPath
 * @param {object} opts
 * @param {object} opts.engine         see engines.js
 * @param {object} opts.config         app config (chunking, limits, tmpDir)
 * @param {string} [opts.language]     ISO code / name; omit to let the model detect it
 * @param {object} [opts.media]        probe result, if the caller already probed
 * @param {(p: {chunksDone: number, chunksTotal: number}) => void} [opts.onProgress]
 */
export async function transcribeFile(inputPath, { engine, config, language, media, onProgress }) {
  const startedAt = performance.now();
  media ??= await probeAudio(inputPath);
  assertDuration(media.durationSec, config.maxDurationSec);

  await fs.mkdir(config.tmpDir, { recursive: true });
  const rawPath = path.join(config.tmpDir, `${randomUUID()}.f32`);

  try {
    const audio = await normalizeAudio(inputPath, rawPath, { frameMs: config.chunk.frameMs });
    // Probe duration can be missing or wrong (e.g. VBR MP3 without header); the decoded length is authoritative.
    assertDuration(audio.durationSec, config.maxDurationSec);

    const chunks = planChunks(audio.energies, { ...config.chunk, totalSec: audio.durationSec });
    onProgress?.({ chunksDone: 0, chunksTotal: chunks.length });

    const raw = [];
    let done = 0;
    for (const chunk of chunks) {
      if (!chunk.silent) {
        const samples = await readSamples(
          rawPath,
          Math.round(chunk.startSec * SAMPLE_RATE),
          Math.round(chunk.endSec * SAMPLE_RATE),
        );
        const segments = await engine.transcribe(samples, { language });
        for (const s of segments) {
          raw.push({
            start: chunk.startSec + s.start,
            end: Math.min(chunk.startSec + s.end, chunk.endSec),
            text: s.text,
          });
        }
      }
      onProgress?.({ chunksDone: ++done, chunksTotal: chunks.length });
    }

    const segments = cleanSegments(raw);
    return {
      text: joinText(segments),
      language: language ?? null,
      durationSec: round2(audio.durationSec),
      segments,
      metadata: {
        engine: engine.name,
        source: media,
        chunks: chunks.length,
        silentChunksSkipped: chunks.filter((c) => c.silent).length,
        processingSec: round2((performance.now() - startedAt) / 1000),
      },
    };
  } finally {
    await fs.rm(rawPath, { force: true });
  }
}

function assertDuration(durationSec, maxDurationSec) {
  if (durationSec != null && durationSec > maxDurationSec) {
    throw new PipelineError(
      'AUDIO_TOO_LONG',
      `Audio is ${Math.round(durationSec)} s; the limit is ${maxDurationSec} s`,
      413,
    );
  }
}

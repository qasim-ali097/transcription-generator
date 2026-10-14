import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { PipelineError } from '../errors.js';
import { ffmpegPath } from './ffmpeg.js';

export const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 4; // float32

/**
 * Converts any ffmpeg-readable input (WAV, MP3, M4A, FLAC, OGG, video, ...) into the one
 * format the model expects: 16 kHz, mono, float32 PCM, written as a raw file on disk.
 *
 * The decode is streamed: the full decoded audio is never held in memory (an hour of audio
 * is ~230 MB of float32). While streaming we compute the RMS energy of each short frame;
 * that tiny array is all the chunker needs to find pauses.
 */
export async function normalizeAudio(inputPath, outputPath, { frameMs = 30 } = {}) {
  const frameSamples = Math.round((SAMPLE_RATE * frameMs) / 1000);

  const ff = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-i', inputPath,
    '-vn', // ignore video streams
    '-ac', '1', // downmix to mono
    '-ar', String(SAMPLE_RATE), // resample
    '-f', 'f32le', '-acodec', 'pcm_f32le',
    'pipe:1',
  ]);

  let stderr = '';
  ff.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', resolve);
  });

  const out = fs.createWriteStream(outputPath);
  const energies = [];
  let frameSumSq = 0;
  let frameFill = 0;
  let totalSamples = 0;
  let leftover = Buffer.alloc(0);

  try {
    for await (const data of ff.stdout) {
      const buf = leftover.length ? Buffer.concat([leftover, data]) : data;
      const usable = buf.length - (buf.length % BYTES_PER_SAMPLE);

      for (let i = 0; i < usable; i += BYTES_PER_SAMPLE) {
        const s = buf.readFloatLE(i);
        frameSumSq += s * s;
        if (++frameFill === frameSamples) {
          energies.push(Math.sqrt(frameSumSq / frameSamples));
          frameSumSq = 0;
          frameFill = 0;
        }
      }

      totalSamples += usable / BYTES_PER_SAMPLE;
      leftover = Buffer.from(buf.subarray(usable));
      if (!out.write(buf.subarray(0, usable))) await once(out, 'drain');
    }
    if (frameFill > 0) energies.push(Math.sqrt(frameSumSq / frameFill));
  } finally {
    out.end();
    await once(out, 'close');
  }

  const exitCode = await exited.catch((err) => {
    if (err.code === 'ENOENT') throw new Error(`ffmpeg not found at "${ffmpegPath}"`);
    throw err;
  });
  if (exitCode !== 0) {
    const detail = stderr.trim().split('\n').at(-1) || `ffmpeg exited with ${exitCode}`;
    throw new PipelineError('DECODE_FAILED', `Could not decode audio (${detail})`, 422);
  }
  if (totalSamples === 0) {
    throw new PipelineError('EMPTY_AUDIO', 'Audio stream contains no samples', 422);
  }

  return {
    path: outputPath,
    sampleRate: SAMPLE_RATE,
    totalSamples,
    durationSec: totalSamples / SAMPLE_RATE,
    frameMs,
    energies: Float32Array.from(energies),
  };
}

/** Reads samples [start, end) from a raw float32 file produced by normalizeAudio. */
export async function readSamples(rawPath, startSample, endSample) {
  const count = Math.max(0, endSample - startSample);
  // Buffer.alloc (not allocUnsafe) guarantees byteOffset 0, which Float32Array needs for alignment.
  const buf = Buffer.alloc(count * BYTES_PER_SAMPLE);
  const fh = await fs.promises.open(rawPath, 'r');
  try {
    const { bytesRead } = await fh.read(buf, 0, buf.length, startSample * BYTES_PER_SAMPLE);
    return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(bytesRead / BYTES_PER_SAMPLE));
  } finally {
    await fh.close();
  }
}

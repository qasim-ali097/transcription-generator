import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ffmpegPath } from '../src/audio/ffmpeg.js';
import { config as baseConfig } from '../src/config.js';

const execFileAsync = promisify(execFile);

export async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'transcription-test-'));
}

export function testConfig(tmpDir, overrides = {}) {
  return { ...baseConfig, engine: 'mock', tmpDir, ...overrides };
}

/**
 * Generates a synthetic "speech-like" file: 440 Hz tone with silent gaps.
 * `gaps` are [fromSec, toSec] ranges of silence. Extension picks the container/codec.
 */
export async function makeTone(filePath, { durationSec, gaps = [] }) {
  const silent = gaps.map(([a, b]) => `between(t,${a},${b})`).join('+') || '0';
  await execFileAsync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi',
    '-i', `aevalsrc='if(${silent},0,0.5*sin(2*PI*440*t))':s=44100:d=${durationSec}`,
    '-ac', '2', // stereo, so the pipeline has to downmix
    filePath,
  ]);
  return filePath;
}

/** A video file with no audio track. */
export async function makeSilentVideo(filePath) {
  await execFileAsync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=1',
    '-c:v', 'mpeg4', filePath,
  ]);
  return filePath;
}

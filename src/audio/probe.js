import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PipelineError } from '../errors.js';
import { ffprobePath } from './ffmpeg.js';

const execFileAsync = promisify(execFile);

/**
 * Inspects a media file with ffprobe. We trust the container/codec ffprobe detects,
 * not the file extension or the client's Content-Type.
 */
export async function probeAudio(filePath) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { maxBuffer: 10 * 1024 * 1024 },
    ));
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`ffprobe not found at "${ffprobePath}"`);
    const detail = String(err.stderr ?? '').trim().split('\n').at(-1) || 'unrecognized format';
    throw new PipelineError('UNSUPPORTED_MEDIA', `Not a readable audio file (${detail})`, 415);
  }

  const info = JSON.parse(stdout);
  const audio = info.streams?.find((s) => s.codec_type === 'audio');
  if (!audio) {
    throw new PipelineError('NO_AUDIO_STREAM', 'File does not contain an audio stream', 415);
  }

  const duration = Number(info.format?.duration ?? audio.duration);
  return {
    container: info.format?.format_name ?? null,
    codec: audio.codec_name ?? null,
    sampleRate: Number(audio.sample_rate) || null,
    channels: audio.channels ?? null,
    // Some streams (raw MP3 without a Xing header, live captures) don't report duration up front.
    durationSec: Number.isFinite(duration) ? duration : null,
  };
}

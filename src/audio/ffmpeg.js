import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function fromPackage(name, pick) {
  try {
    return pick(require(name)) || null;
  } catch {
    return null;
  }
}

// Resolution order: explicit env var -> bundled static binary (optional dependency) -> system PATH.
export const ffmpegPath =
  process.env.FFMPEG_PATH || fromPackage('ffmpeg-static', (m) => m) || 'ffmpeg';

export const ffprobePath =
  process.env.FFPROBE_PATH || fromPackage('ffprobe-static', (m) => m.path) || 'ffprobe';

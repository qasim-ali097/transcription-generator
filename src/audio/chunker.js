/**
 * Plans where to split long audio before sending it to the model.
 *
 * Whisper only sees 30 s at a time. Cutting blindly every 30 s splits words in half and
 * produces garbage at every boundary (the usual fix is overlapping windows + de-duplication).
 * Instead we cut in the middle of the longest pause inside a [minSec, maxSec] window, i.e.
 * between sentences, so chunks can be back-to-back with no overlap and no de-duplication.
 *
 * Chunks with (almost) no voiced audio are flagged `silent` so the pipeline can skip them:
 * it saves compute, and Whisper is known to hallucinate text ("Thank you.") on silence.
 *
 * Pure function over the per-frame RMS energies, so it is cheap and easy to unit-test.
 *
 * @param {ArrayLike<number>} energies RMS energy per analysis frame
 * @returns {{ startSec: number, endSec: number, silent: boolean }[]}
 */
export function planChunks(
  energies,
  { frameMs = 30, maxSec = 28, minSec = 18, silenceRms = 0.01, minSpeechMs = 250, totalSec } = {},
) {
  const totalFrames = energies.length;
  const maxFrames = Math.max(1, Math.floor((maxSec * 1000) / frameMs));
  const minFrames = Math.min(maxFrames, Math.max(1, Math.floor((minSec * 1000) / frameMs)));
  const minSpeechFrames = Math.ceil(minSpeechMs / frameMs);
  const smoothed = movingAverage(energies, 5); // ~150 ms: find real pauses, not one quiet frame
  const endSec = totalSec ?? (totalFrames * frameMs) / 1000;

  const chunks = [];
  let start = 0;
  while (start < totalFrames) {
    const end =
      totalFrames - start <= maxFrames
        ? totalFrames
        : bestCut(smoothed, start + minFrames, start + maxFrames, silenceRms);

    let voiced = 0;
    for (let i = start; i < end; i++) if (energies[i] >= silenceRms) voiced++;

    chunks.push({
      startSec: (start * frameMs) / 1000,
      // The last frame may be partial, so the final chunk ends at the true duration.
      endSec: end === totalFrames ? endSec : (end * frameMs) / 1000,
      silent: voiced < minSpeechFrames,
    });
    start = end;
  }
  return chunks;
}

/**
 * Cut point in [from, to]: the middle of the longest pause, so we split between sentences
 * rather than at a comma, with silence on both sides of the cut. If there is no pause at all
 * (music, noise, non-stop talking), fall back to the quietest frame.
 */
function bestCut(energies, from, to, silenceRms) {
  let bestLen = 0;
  let bestMid = -1;
  let runStart = -1;
  for (let i = from; i <= to + 1; i++) {
    const quiet = i <= to && energies[i] < silenceRms;
    if (quiet && runStart < 0) runStart = i;
    if (!quiet && runStart >= 0) {
      const len = i - runStart;
      if (len >= bestLen) {
        bestLen = len;
        bestMid = runStart + Math.floor(len / 2);
      }
      runStart = -1;
    }
  }
  return bestMid >= 0 ? bestMid : quietestFrame(energies, from, to);
}

/** Index in [from, to] with the lowest energy; ties go to the later frame (fewer, longer chunks). */
function quietestFrame(energies, from, to) {
  let best = to;
  for (let i = to; i >= from; i--) {
    if (energies[i] < energies[best]) best = i;
  }
  return best;
}

function movingAverage(values, width) {
  const half = Math.floor(width / 2);
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j++) {
      sum += values[j];
      n++;
    }
    out[i] = sum / n;
  }
  return out;
}

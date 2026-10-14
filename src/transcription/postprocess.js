// Non-speech annotations Whisper emits instead of words, e.g. "[BLANK_AUDIO]", "(music)", "[Applause]".
const NON_SPEECH = /^[[(][^\])]*[\])]$/;

const MIN_SEGMENT_SEC = 0.05;

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Turns raw engine output into clean, downstream-friendly segments:
 *  - normalizes whitespace, drops empty, zero-length and non-speech-tag segments
 *  - drops immediate repeats (Whisper's classic "stuck in a loop" hallucination)
 *  - guarantees monotonic, non-negative, non-inverted timestamps rounded to 10 ms
 *  - assigns stable ids
 */
export function cleanSegments(segments) {
  const out = [];
  let lastEnd = 0;
  for (const seg of segments) {
    const text = String(seg.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text || NON_SPEECH.test(text)) continue;
    // Zero-length segments are decoder artifacts (typically a lone "you" on trailing silence).
    // Inverted ones (end < start) are kept and clamped below: bad timestamp, but possibly real words.
    const length = seg.end - seg.start;
    if (length >= 0 && length < MIN_SEGMENT_SEC) continue;

    const prev = out.at(-1);
    if (prev && normalizeForCompare(prev.text) === normalizeForCompare(text)) continue;

    const start = round2(Math.max(seg.start, lastEnd, 0));
    const end = round2(Math.max(seg.end, start));
    out.push({ id: out.length, start, end, text });
    lastEnd = end;
  }
  return out;
}

export function joinText(segments) {
  return segments.map((s) => s.text).join(' ');
}

function normalizeForCompare(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

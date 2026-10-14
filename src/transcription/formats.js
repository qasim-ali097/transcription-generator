/** Export a transcription result to formats other systems consume directly. */

export const FORMATS = ['json', 'txt', 'srt', 'vtt'];

export function render(result, format = 'json') {
  switch (format) {
    case 'json':
      return { contentType: 'application/json', body: JSON.stringify(result, null, 2) };
    case 'txt':
      return { contentType: 'text/plain; charset=utf-8', body: `${result.text}\n` };
    case 'srt':
      return { contentType: 'application/x-subrip; charset=utf-8', body: toSrt(result.segments) };
    case 'vtt':
      return { contentType: 'text/vtt; charset=utf-8', body: toVtt(result.segments) };
    default:
      throw new Error(`Unknown format "${format}"`);
  }
}

export function toSrt(segments) {
  return segments
    .map((s, i) => `${i + 1}\n${timecode(s.start, ',')} --> ${timecode(s.end, ',')}\n${s.text}\n`)
    .join('\n');
}

export function toVtt(segments) {
  const cues = segments.map((s) => `${timecode(s.start, '.')} --> ${timecode(s.end, '.')}\n${s.text}\n`);
  return `WEBVTT\n\n${cues.join('\n')}`;
}

/** 3725.5 -> "01:02:05,500" */
export function timecode(seconds, msSeparator) {
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const s = Math.floor(totalMs / 1000) % 60;
  const m = Math.floor(totalMs / 60_000) % 60;
  const h = Math.floor(totalMs / 3_600_000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${msSeparator}${pad(ms, 3)}`;
}

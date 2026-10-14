import assert from 'node:assert/strict';
import { test } from 'node:test';
import { timecode, toSrt, toVtt } from '../src/transcription/formats.js';
import { cleanSegments, joinText } from '../src/transcription/postprocess.js';

test('cleanSegments trims, drops empty / non-speech / repeated segments', () => {
  const out = cleanSegments([
    { start: 0, end: 2, text: '  Hello   world ' },
    { start: 2, end: 3, text: '   ' },
    { start: 3, end: 5, text: '[BLANK_AUDIO]' },
    { start: 5, end: 7, text: 'Thank you.' },
    { start: 7, end: 9, text: 'thank you' },
    { start: 9, end: 9, text: 'you' },
    { start: 9, end: 10.004, text: 'Bye.' },
  ]);
  assert.deepEqual(out, [
    { id: 0, start: 0, end: 2, text: 'Hello world' },
    { id: 1, start: 5, end: 7, text: 'Thank you.' },
    { id: 2, start: 9, end: 10, text: 'Bye.' },
  ]);
  assert.equal(joinText(out), 'Hello world Thank you. Bye.');
});

test('cleanSegments keeps timestamps monotonic and non-inverted', () => {
  const out = cleanSegments([
    { start: 0, end: 5, text: 'a' },
    { start: 4, end: 3, text: 'b' },
  ]);
  assert.deepEqual(
    out.map(({ start, end }) => [start, end]),
    [[0, 5], [5, 5]],
  );
});

test('timecode formats hours, minutes, seconds, millis', () => {
  assert.equal(timecode(3725.5, ','), '01:02:05,500');
  assert.equal(timecode(0.0004, '.'), '00:00:00.000');
});

test('SRT and VTT output', () => {
  const segments = [
    { id: 0, start: 0, end: 1.5, text: 'One' },
    { id: 1, start: 1.5, end: 3, text: 'Two' },
  ];
  assert.equal(
    toSrt(segments),
    '1\n00:00:00,000 --> 00:00:01,500\nOne\n\n2\n00:00:01,500 --> 00:00:03,000\nTwo\n',
  );
  assert.match(toVtt(segments), /^WEBVTT\n\n00:00:00\.000 --> 00:00:01\.500\nOne\n/);
});

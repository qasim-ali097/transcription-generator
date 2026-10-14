#!/usr/bin/env node
// CLI: same pipeline as the HTTP service, no server needed.
//   node bin/transcribe.js <audio-file> [--format json|txt|srt|vtt] [--language en] [--out file] [--engine mock]

import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { config as baseConfig } from '../src/config.js';
import { createEngine } from '../src/transcription/engines.js';
import { FORMATS, render } from '../src/transcription/formats.js';
import { transcribeFile } from '../src/transcription/pipeline.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    format: { type: 'string', short: 'f', default: 'json' },
    language: { type: 'string', short: 'l' },
    out: { type: 'string', short: 'o' },
    engine: { type: 'string' },
    model: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help || positionals.length !== 1 || !FORMATS.includes(values.format)) {
  console.error(
    `Usage: transcribe <audio-file> [--format ${FORMATS.join('|')}] [--language en] [--out file] [--engine whisper|mock] [--model Xenova/whisper-small]`,
  );
  process.exit(values.help ? 0 : 1);
}

const config = {
  ...baseConfig,
  ...(values.engine && { engine: values.engine }),
  ...(values.model && { whisperModel: values.model }),
};

try {
  const engine = createEngine(config);
  process.stderr.write(`Loading ${engine.name}...\n`);
  await engine.load();

  const result = await transcribeFile(positionals[0], {
    engine,
    config,
    language: values.language,
    onProgress: ({ chunksDone, chunksTotal }) =>
      process.stderr.write(`\rTranscribing: chunk ${chunksDone}/${chunksTotal}`),
  });
  process.stderr.write(
    `\nDone: ${result.durationSec}s of audio in ${result.metadata.processingSec}s, ${result.segments.length} segments\n`,
  );

  const { body } = render(result, values.format);
  if (values.out) await fs.writeFile(values.out, body);
  else process.stdout.write(body.endsWith('\n') ? body : `${body}\n`);
} catch (err) {
  process.stderr.write(`\nError: ${err.message}\n`);
  process.exit(1);
}

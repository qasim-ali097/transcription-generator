import { SAMPLE_RATE } from '../audio/decode.js';

/**
 * Engine contract — everything above this layer is engine-agnostic:
 *
 *   name: string
 *   load(): Promise<void>                        warm up / download the model
 *   transcribe(samples: Float32Array, { language }) => Promise<Segment[]>
 *
 * `samples` is 16 kHz mono float32, at most ~30 s long. Segment timestamps are relative
 * to the start of `samples`; the pipeline shifts them onto the file's timeline.
 *
 * @typedef {{ start: number, end: number, text: string }} Segment
 */

export function createEngine(config) {
  switch (config.engine) {
    case 'whisper':
      return createWhisperEngine({ model: config.whisperModel, dtype: config.whisperDtype });
    case 'mock':
      return createMockEngine();
    default:
      throw new Error(`Unknown ENGINE "${config.engine}" (expected "whisper" or "mock")`);
  }
}

/**
 * Open-source Whisper running locally through transformers.js (ONNX Runtime).
 * No Python, no external API, no audio leaves the machine.
 * Weights are downloaded from the Hugging Face Hub on first use and cached.
 */
export function createWhisperEngine({ model, dtype }) {
  let asrPromise;
  const englishOnly = model.endsWith('.en');

  const load = () => {
    asrPromise ??= import('@huggingface/transformers').then(({ pipeline }) =>
      pipeline('automatic-speech-recognition', model, { dtype }),
    );
    // Allow a retry if the download/initialisation failed.
    asrPromise.catch(() => (asrPromise = undefined));
    return asrPromise;
  };

  return {
    name: `whisper:${model}`,
    load: async () => void (await load()),
    async transcribe(samples, { language } = {}) {
      const asr = await load();
      const output = await asr(samples, {
        return_timestamps: true,
        // English-only checkpoints reject language/task tokens.
        ...(!englishOnly && language ? { language, task: 'transcribe' } : {}),
      });
      const duration = samples.length / SAMPLE_RATE;
      const chunks = output.chunks ?? [{ timestamp: [0, duration], text: output.text }];
      return chunks.map(({ timestamp: [start, end], text }) => ({
        start: start ?? 0,
        // Whisper leaves the final end timestamp null when speech runs to the edge of the window.
        end: end ?? duration,
        text,
      }));
    },
  };
}

/** Deterministic fake engine: one segment every 5 s. Lets the whole pipeline run without a model. */
export function createMockEngine() {
  return {
    name: 'mock',
    load: async () => {},
    async transcribe(samples) {
      const duration = samples.length / SAMPLE_RATE;
      const segments = [];
      for (let t = 0; t < duration; t += 5) {
        segments.push({ start: t, end: Math.min(t + 5, duration), text: ` mock speech at +${t}s` });
      }
      return segments;
    },
  };
}

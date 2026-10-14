import { createApp } from './app.js';
import { config } from './config.js';
import { JobQueue } from './jobs/jobQueue.js';
import { createEngine } from './transcription/engines.js';

const engine = createEngine(config);
const queue = new JobQueue({ concurrency: config.jobConcurrency, ttlMs: config.jobTtlMs });
const app = createApp({ engine, queue, config });

const server = app.listen(config.port, () => {
  console.log(`Transcription service on http://localhost:${config.port} (engine: ${engine.name})`);
});

// Load the model at startup rather than on the first request (first run downloads weights).
const t0 = performance.now();
engine
  .load()
  .then(() => console.log(`Model ready in ${((performance.now() - t0) / 1000).toFixed(1)} s`))
  .catch((err) => console.error('Model failed to load; it will be retried on the first request.', err));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    queue.close();
    server.close(() => process.exit(0));
  });
}

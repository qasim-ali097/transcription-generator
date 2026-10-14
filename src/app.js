import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { probeAudio } from './audio/probe.js';
import { PipelineError, serializeError } from './errors.js';
import { FORMATS, render } from './transcription/formats.js';
import { transcribeFile } from './transcription/pipeline.js';

/**
 * HTTP API. Dependencies are injected so tests can run it with the mock engine.
 *
 *   POST /transcribe            multipart "file" (+ optional language, async, format)
 *   GET  /jobs/:id              job status + progress
 *   GET  /jobs/:id/result       result as json | txt | srt | vtt
 *   GET  /health
 */
export function createApp({ engine, queue, config }) {
  const uploadDir = path.join(config.tmpDir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      // Never use the client's filename on disk (path traversal, collisions).
      filename: (_req, _file, cb) => cb(null, randomUUID()),
    }),
    limits: { fileSize: config.maxUploadBytes, files: 1 },
  });

  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', engine: engine.name, queue: queue.stats() });
  });

  app.post('/transcribe', upload.single('file'), async (req, res) => {
    if (!req.file) {
      throw new PipelineError('NO_FILE', 'Send the audio as multipart/form-data field "file"', 400);
    }
    const uploadPath = req.file.path;
    const params = { ...req.query, ...req.body };
    const language = params.language?.trim() || undefined;

    let format;
    let media;
    try {
      format = parseFormat(params.format);
      // Validate before queueing so bad files fail fast with a clear 4xx.
      media = await probeAudio(uploadPath);
    } catch (err) {
      fs.rm(uploadPath, { force: true }, () => {});
      throw err;
    }

    const job = queue.enqueue(
      (report) =>
        transcribeFile(uploadPath, { engine, config, language, media, onProgress: report }).finally(
          () => fs.promises.rm(uploadPath, { force: true }),
        ),
      { filename: req.file.originalname, sizeBytes: req.file.size, durationSec: media.durationSec },
    );

    const runSync =
      params.async !== 'true' &&
      media.durationSec != null &&
      media.durationSec <= config.syncMaxDurationSec;

    if (!runSync) {
      res.status(202).location(`/jobs/${job.id}`).json(queue.view(job));
      return;
    }

    await queue.wait(job.id);
    if (job.status === 'failed') {
      res.status(job.error.status).json({ error: job.error });
      return;
    }
    send(res, job.result, format);
  });

  app.get('/jobs/:id', (req, res) => {
    const job = queue.get(req.params.id);
    if (!job) throw new PipelineError('JOB_NOT_FOUND', 'Unknown or expired job id', 404);
    res.json(queue.view(job));
  });

  app.get('/jobs/:id/result', (req, res) => {
    const job = queue.get(req.params.id);
    if (!job) throw new PipelineError('JOB_NOT_FOUND', 'Unknown or expired job id', 404);
    if (job.status === 'failed') {
      res.status(job.error.status).json({ error: job.error });
      return;
    }
    if (job.status !== 'completed') {
      throw new PipelineError('JOB_NOT_READY', `Job is ${job.status}`, 409);
    }
    send(res, job.result, parseFormat(req.query.format));
  });

  // Express 5 forwards rejected promises from async handlers here.
  app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      res.status(status).json({ error: { code: err.code, message: err.message, status } });
      return;
    }
    if (!(err instanceof PipelineError)) console.error(err);
    const error = serializeError(err);
    res.status(error.status).json({ error });
  });

  return app;
}

function parseFormat(format = 'json') {
  if (!FORMATS.includes(format)) {
    throw new PipelineError('BAD_FORMAT', `format must be one of: ${FORMATS.join(', ')}`, 400);
  }
  return format;
}

function send(res, result, format) {
  const { contentType, body } = render(result, format);
  res.type(contentType).send(body);
}

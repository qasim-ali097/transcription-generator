import { randomUUID } from 'node:crypto';
import { serializeError } from '../errors.js';

/**
 * In-process FIFO job queue with bounded concurrency.
 *
 * Every transcription — sync or async — goes through here, so CPU-heavy model inference
 * is capped at `concurrency` no matter how many requests arrive. A sync request is just a
 * job whose HTTP response waits for `job.done`.
 *
 * Production swap: the same interface maps onto BullMQ/Redis (or SQS) with separate worker
 * processes, giving persistence across restarts and horizontal scaling.
 */
export class JobQueue {
  #jobs = new Map();
  #pending = [];
  #running = 0;

  constructor({ concurrency = 1, ttlMs = 60 * 60 * 1000 } = {}) {
    this.concurrency = concurrency;
    this.ttlMs = ttlMs;
    // Evict finished jobs so memory doesn't grow forever.
    this.sweeper = setInterval(() => this.#evict(), Math.min(ttlMs, 60_000));
    this.sweeper.unref();
  }

  /**
   * @param {(report: (progress: object) => void) => Promise<any>} task
   * @param {object} meta  public info shown in job status (filename, duration, ...)
   */
  enqueue(task, meta = {}) {
    const job = {
      id: randomUUID(),
      status: 'queued',
      meta,
      progress: null,
      result: null,
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    let resolveDone;
    // Resolves (never rejects) with the job once it reaches completed/failed.
    const done = new Promise((resolve) => (resolveDone = resolve));
    this.#jobs.set(job.id, { job, task, done, resolveDone });
    this.#pending.push(job.id);
    this.#drain();
    return job;
  }

  get(id) {
    return this.#jobs.get(id)?.job ?? null;
  }

  wait(id) {
    return this.#jobs.get(id)?.done ?? Promise.resolve(null);
  }

  /** Public status view (result is served separately so status polls stay small). */
  view(job) {
    const position = this.#pending.indexOf(job.id);
    return {
      id: job.id,
      status: job.status,
      ...(position >= 0 && { queuePosition: position + 1 }),
      progress: job.progress,
      meta: job.meta,
      error: job.error,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    };
  }

  stats() {
    let completed = 0;
    let failed = 0;
    for (const { job } of this.#jobs.values()) {
      if (job.status === 'completed') completed++;
      if (job.status === 'failed') failed++;
    }
    return { queued: this.#pending.length, running: this.#running, completed, failed };
  }

  close() {
    clearInterval(this.sweeper);
  }

  #drain() {
    while (this.#running < this.concurrency && this.#pending.length) {
      const entry = this.#jobs.get(this.#pending.shift());
      if (entry) this.#run(entry);
    }
  }

  async #run({ job, task, resolveDone }) {
    this.#running++;
    job.status = 'processing';
    job.startedAt = new Date().toISOString();
    try {
      job.result = await task((progress) => (job.progress = progress));
      job.status = 'completed';
    } catch (err) {
      job.status = 'failed';
      job.error = serializeError(err);
      if (job.error.status >= 500) console.error(`[job ${job.id}]`, err);
    } finally {
      job.finishedAt = new Date().toISOString();
      this.#running--;
      resolveDone(job);
      this.#drain();
    }
  }

  #evict() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, { job }] of this.#jobs) {
      if (job.finishedAt && Date.parse(job.finishedAt) < cutoff) this.#jobs.delete(id);
    }
  }
}

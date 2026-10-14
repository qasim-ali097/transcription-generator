/**
 * An expected, client-facing failure (bad input, limits exceeded, ...).
 * Anything that is not a PipelineError is treated as an internal 500.
 */
export class PipelineError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'PipelineError';
    this.code = code;
    this.status = status;
  }
}

export function serializeError(err) {
  if (err instanceof PipelineError) {
    return { code: err.code, message: err.message, status: err.status };
  }
  return { code: 'INTERNAL_ERROR', message: 'Transcription failed unexpectedly', status: 500 };
}

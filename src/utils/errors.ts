/** Base class for every error this package throws intentionally. */
export class MssqlDumperError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MssqlDumperError';
    this.code = code;
  }
}

/** Thrown by API surfaces whose implementation is deferred to a later phase. */
export class NotImplementedError extends MssqlDumperError {
  constructor(feature: string) {
    super('not-implemented', `${feature} is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}

/** Thrown when an operation stops because its `AbortSignal` was triggered. */
export class OperationCancelledError extends MssqlDumperError {
  constructor(message = 'The operation was cancelled') {
    super('operation-cancelled', message);
    this.name = 'OperationCancelledError';
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new OperationCancelledError();
  }
}

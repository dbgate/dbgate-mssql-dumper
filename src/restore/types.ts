import type { Readable } from 'node:stream';
import type { MssqlConnectionInput } from '../connection/types.js';
import type { RestoreProgressCallback } from '../utils/progress.js';

export interface RestoreOptions {
  /** Stop at the first failing batch. Defaults to `true`. */
  readonly stopOnError?: boolean;
}

export type SqlDumpSource = string | Readable | AsyncIterable<string | Buffer>;

export interface SqlDumpRestoreRequest {
  readonly connection: MssqlConnectionInput;
  readonly sql: SqlDumpSource;
  readonly options?: RestoreOptions;
  readonly signal?: AbortSignal;
  readonly onProgress?: RestoreProgressCallback;
}

export interface RestoreStatementError {
  readonly batchIndex: number;
  /** Truncated preview of the failing batch; see {@link safeSqlPreview}. */
  readonly sqlPreview: string;
  readonly message: string;
}

export interface SqlDumpRestoreResult {
  readonly statementsExecuted: number;
  readonly statementsFailed: number;
  readonly errors: readonly RestoreStatementError[];
  readonly cancelled: boolean;
}

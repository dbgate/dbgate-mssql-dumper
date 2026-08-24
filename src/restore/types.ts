import type { MssqlConnectionInput } from '../connection/types.js';
import type { RestoreProgressCallback } from '../utils/progress.js';
import type { SqlBatchParserOptions } from './batchParser.js';
import type { BatchSourceLocation } from './location.js';
import type { SqlDumpSource } from './source.js';

export interface RestoreOptions extends SqlBatchParserOptions {
  /** Stop at the first batch that fails execution. Defaults to `true`. */
  readonly stopOnError?: boolean;
  /**
   * `auto` (default) converts canonical `INSERT ... VALUES` batches produced
   * by this package to the adapter's native bulk-load operation when
   * available. Any batch that cannot be recognized losslessly falls back to
   * normal SQL batch execution. `off` always uses SQL batch execution.
   */
  readonly bulkInsertMode?: 'auto' | 'off';
}

export interface SqlDumpRestoreRequest {
  readonly connection: MssqlConnectionInput;
  readonly source: SqlDumpSource;
  readonly options?: RestoreOptions;
  readonly signal?: AbortSignal;
  readonly progress?: RestoreProgressCallback;
}

/** One batch that parsed successfully but failed when executed; see {@link RestoreExecutionError}. */
export interface RestoreBatchError {
  readonly batchIndex: number;
  readonly location: BatchSourceLocation;
  /** Truncated, secret-redacted preview of the failing batch; see {@link safeSqlPreview}. */
  readonly sqlPreview: string;
  readonly message: string;
}

export interface SqlDumpRestoreResult {
  readonly batchesExecuted: number;
  readonly batchesFailed: number;
  /**
   * Sum of `rowsAffected` reported by the connection across every
   * successfully executed batch (repeated `GO <n>` executions each count
   * separately). In practice this reflects rows inserted by data batches,
   * since ordinary DDL (`CREATE TABLE`, `ALTER TABLE ADD CONSTRAINT`, ...)
   * reports 0 — but it is a straightforward sum, not a data-batch-specific
   * heuristic, so a script containing its own `UPDATE`/`DELETE` statements
   * would contribute those rows too.
   */
  readonly rowsRestored: number;
  readonly errors: readonly RestoreBatchError[];
  readonly cancelled: boolean;
}

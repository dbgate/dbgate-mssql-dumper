export type DumpProgressPhase =
  | 'connecting'
  | 'detecting-version'
  | 'introspecting'
  | 'planning-archive'
  | 'rendering-schema'
  | 'exporting-data'
  | 'finalizing';

export interface DumpProgressEvent {
  readonly phase: DumpProgressPhase;
  readonly message?: string;
  readonly objectsProcessed?: number;
  readonly objectsTotal?: number;
  /** Bytes written to the output so far, when practical to report (e.g. during `exporting-data`). */
  readonly bytesWritten?: number;
  /** Lifecycle of a table data export. */
  readonly exportState?: 'started' | 'progress' | 'finished' | 'failed' | 'cancelled';
  readonly schemaName?: string;
  readonly tableName?: string;
  /** Rows exported from the current table. */
  readonly rowsExported?: number;
}

export type DumpProgressCallback = (event: DumpProgressEvent) => void;

export type RestoreProgressPhase =
  'connecting' | 'preflight' | 'parsing' | 'executing' | 'finalizing';

export interface RestoreProgressEvent {
  readonly phase: RestoreProgressPhase;
  readonly message?: string;
  readonly statementsProcessed?: number;
  readonly statementsTotal?: number;
  /** The batch currently being parsed/executed, 0-based in source order. */
  readonly batchIndex?: number;
  /** Running total of rows affected across every batch executed so far; see `SqlDumpRestoreResult.rowsRestored`. */
  readonly rowsRestored?: number;
  /** Data path used by a recognized generated INSERT batch. */
  readonly executionMode?: 'bulk-insert' | 'sql-fallback';
  /** Lifecycle of the current execution attempt. */
  readonly executionState?: 'started' | 'finished' | 'failed';
  readonly schemaName?: string;
  readonly tableName?: string;
}

export type RestoreProgressCallback = (event: RestoreProgressEvent) => void;

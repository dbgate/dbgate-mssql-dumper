/**
 * Client-agnostic SQL Server connection abstraction.
 *
 * The core package never imports a Node.js driver directly. Callers provide
 * an {@link MssqlConnection} (or an {@link MssqlConnectionSource} that can
 * acquire one) implemented by an adapter such as `dbgate-mssql-dumper/tedious`.
 */

/** Scalar values accepted as bound query parameters. */
export type MssqlParameterValue = string | number | bigint | boolean | Buffer | Date | null;

/** One bound parameter for a parameterized query. */
export interface MssqlQueryParameter {
  readonly name: string;
  readonly value: MssqlParameterValue;
  /**
   * Optional explicit driver-level SQL type name (for example `VarChar`,
   * `Int`, `NVarChar`). Adapters may use this to avoid implicit type
   * inference when it would be ambiguous or lossy.
   */
  readonly sqlType?: string;
}

/** A single SQL statement plus its bound parameters. */
export interface MssqlQuery {
  readonly sql: string;
  readonly parameters?: readonly MssqlQueryParameter[];
  /** Statement-level timeout in milliseconds. Adapters that cannot honor it per-statement may ignore it. */
  readonly timeoutMs?: number;
}

/** Scalar values that can appear in a returned row. */
export type MssqlColumnValue = string | number | bigint | boolean | Buffer | Date | null;

/** A single result row, keyed by column name. */
export interface MssqlRow {
  readonly [column: string]: MssqlColumnValue;
}

/** Metadata for one column of a query result. */
export interface MssqlResultColumn {
  readonly name: string;
  /** Driver-reported SQL Server type name, when available (e.g. `varchar`). */
  readonly sqlType?: string;
  readonly nullable?: boolean;
  readonly length?: number;
  readonly precision?: number;
  readonly scale?: number;
}

/** Buffered result of a non-streaming query. */
export interface MssqlQueryResult<Row extends MssqlRow = MssqlRow> {
  readonly rows: readonly Row[];
  readonly columns: readonly MssqlResultColumn[];
  readonly rowsAffected: number;
}

export interface MssqlStreamOptions {
  readonly signal?: AbortSignal;
  /**
   * Backpressure high-water mark: adapters that support it suspend the
   * underlying result-set flow once this many rows are buffered ahead of
   * the consumer, and resume it once the buffer drains. Adapters that
   * cannot support backpressure may ignore this.
   */
  readonly batchSize?: number;
}

/** Metadata needed by an adapter to encode one column for a TDS bulk load. */
export interface MssqlBulkColumn {
  readonly name: string;
  /** Base SQL Server type name, for example `int`, `nvarchar`, or `datetime2`. */
  readonly dataType: string;
  /** `sys.columns.max_length`; `-1` denotes a MAX large-object type. */
  readonly maxLength: number;
  readonly precision: number;
  readonly scale: number;
  readonly nullable: boolean;
}

export interface MssqlBulkInsertRequest {
  readonly schemaName: string;
  readonly tableName: string;
  readonly columns: readonly MssqlBulkColumn[];
  /** Values are in the same ordinal order as {@link columns}. */
  readonly rows: readonly (readonly MssqlColumnValue[])[];
}

export interface MssqlBulkInsertResult {
  readonly rowsAffected: number;
}

/**
 * Transaction state of a connection, analogous to `pg`'s
 * `PostgresTransactionStatus` but reported through
 * `SELECT @@TRANCOUNT` / `XACT_STATE()`.
 *
 * - `idle`: no open transaction (`@@TRANCOUNT = 0`).
 * - `in-transaction`: an open, usable transaction (`XACT_STATE() = 1`).
 * - `failed`: an open transaction that can only be rolled back
 *   (`XACT_STATE() = -1`).
 * - `unknown`: state could not be determined (e.g. adapter does not support
 *   reporting it).
 */
export type MssqlTransactionStatus = 'idle' | 'in-transaction' | 'failed' | 'unknown';

/**
 * One physical SQL Server session.
 *
 * Implementations must serialize statements sent through the same
 * connection: SQL Server (via TDS) does not support concurrently
 * interleaved batches on a single connection.
 */
export interface MssqlConnection {
  query<Row extends MssqlRow = MssqlRow>(
    query: MssqlQuery,
    signal?: AbortSignal,
  ): Promise<MssqlQueryResult<Row>>;

  /** Streams rows without buffering the full result set in memory. */
  stream<Row extends MssqlRow = MssqlRow>(
    query: MssqlQuery,
    options?: MssqlStreamOptions,
  ): AsyncIterable<Row>;

  /** Best-effort transaction status; adapters that cannot report it return `unknown`. */
  getTransactionStatus?(signal?: AbortSignal): Promise<MssqlTransactionStatus>;

  /**
   * Executes `sql` as one T-SQL batch, using genuine "batch" semantics —
   * equivalent to Tedious's `execSqlBatch`, not `execSql` (which routes
   * through `sp_executesql`). This distinction matters for restoring plain
   * SQL scripts: `CREATE PROCEDURE`/`CREATE VIEW`/`CREATE FUNCTION`/
   * `CREATE TRIGGER` must be the only statement in their batch and can
   * behave differently (or be rejected outright) inside an `sp_executesql`
   * wrapper, and batch-scoped constructs (local temp tables, `GOTO` labels,
   * `SET` options meant to persist for later batches on the same
   * connection) rely on not being sandboxed inside a nested execution
   * context. No parameter binding is supported, matching `execSqlBatch`.
   * Adapters that cannot distinguish batch execution from `query()` may
   * omit this; callers fall back to `query()`.
   */
  execBatch?(sql: string, signal?: AbortSignal): Promise<MssqlExecBatchResult>;

  /**
   * Inserts already-typed rows using the driver's native TDS bulk-load path.
   * Optional because not every client adapter exposes bulk loading. Restore
   * falls back to {@link execBatch} when this capability is absent.
   */
  bulkInsert?(
    request: MssqlBulkInsertRequest,
    signal?: AbortSignal,
  ): Promise<MssqlBulkInsertResult>;

  /** Requests cancellation of the currently executing statement, if any. */
  cancel(): Promise<void>;
}

/** Result of a batch execution via {@link MssqlConnection.execBatch}. */
export interface MssqlExecBatchResult {
  readonly rowsAffected: number;
}

/** A connection acquired from a pool-like source, plus its release callback. */
export interface AcquiredMssqlConnection {
  readonly connection: MssqlConnection;
  /** Idempotent; safe to call more than once. */
  release(): Promise<void>;
}

/**
 * Represents a resource that must be acquired to obtain one physical
 * connection, such as a connection pool. Direct {@link MssqlConnection}
 * instances are borrowed by the library and are never closed by it.
 */
export interface MssqlConnectionSource {
  acquire(signal?: AbortSignal): Promise<AcquiredMssqlConnection>;
}

/** Anything the public API accepts in place of a physical connection. */
export type MssqlConnectionInput = MssqlConnection | MssqlConnectionSource;

export function isMssqlConnectionSource(
  input: MssqlConnectionInput,
): input is MssqlConnectionSource {
  return typeof (input as MssqlConnectionSource).acquire === 'function';
}

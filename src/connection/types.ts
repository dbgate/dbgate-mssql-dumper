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

  /** Requests cancellation of the currently executing statement, if any. */
  cancel(): Promise<void>;
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

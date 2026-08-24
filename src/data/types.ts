import type { MssqlConnection } from '../connection/types.js';
import type { MssqlDiagnostic } from '../model/diagnostics.js';
import type { MssqlTable } from '../model/table.js';
import type { DumpProgressCallback } from '../utils/progress.js';
import type { DumpWriter } from '../writer/types.js';

export interface TableDataExportOptions {
  /** Row-fetch backpressure high-water mark passed through to `connection.stream()`. */
  readonly streamBatchSize?: number;
  /**
   * Maximum rows per multi-row `INSERT ... VALUES (...), (...), ...`
   * statement. Set to `1` for one `INSERT` per row. Defaults to `100`;
   * always clamped to SQL Server's own hard limit of 1000 rows per
   * `VALUES` table-value-constructor, regardless of what is requested,
   * since exceeding it would generate a statement that fails at restore
   * time.
   *
   * Each statement is its own implicit transaction at restore time, so this
   * sets how many transaction-log commits restoring the table costs — but
   * raising it is not the win that suggests: a large `VALUES` constructor
   * measured *slower* to restore than the commits it saves (see
   * `insertExport.ts`). Reach for `maxRowsPerBatch` to cut restore cost.
   */
  readonly maxRowsPerStatement?: number;
  /**
   * Approximate maximum size, in UTF-8 bytes, of one `INSERT` statement's
   * rendered `VALUES` list — a safety cap independent of row count, so one
   * batch of unusually wide rows cannot produce an unreasonably large
   * single statement. Defaults to 4,000,000 bytes.
   */
  readonly maxStatementBytes?: number;
  /**
   * Maximum rows accumulated into one `GO`-terminated T-SQL batch, across
   * however many `INSERT` statements that takes. Defaults to `10,000`.
   *
   * A batch is one round trip at restore time — `restoreSqlDump` executes
   * batches strictly sequentially, so with a `GO` after every statement a
   * large table becomes thousands of sequential round trips, and on anything
   * but a local server that latency, not the inserting, dominates restore
   * time. Packing statements into a batch costs nothing at restore beyond
   * holding the batch text in memory (bounded below by
   * `SqlBatchParserOptions.maxBatchBytes`, default 64 MiB).
   *
   * Set to `1` for the one-statement-per-batch shape, which gives the finest
   * possible error attribution on restore (`RestoreBatchError` identifies a
   * failing batch, not a statement within it) at the cost of a round trip per
   * statement. Bookkeeping statements (`SET IDENTITY_INSERT`) never count
   * toward the cap.
   */
  readonly maxRowsPerBatch?: number;
  /**
   * Maximum size, in UTF-8 bytes, of one `GO`-terminated batch's text — the
   * same safety valve `maxStatementBytes` provides for a single statement,
   * applied to the batch that contains them. Defaults to 8,000,000 bytes,
   * comfortably under the 64 MiB a restore accepts by default. A batch always
   * holds at least one statement, so a single statement larger than this is
   * still emitted, alone.
   */
  readonly maxBatchBytes?: number;
  /**
   * Emit `GO` batch separators at all (default `true`).
   *
   * Without them, a table's entire row data forms one enormous T-SQL batch:
   * restoring it would exceed `SqlBatchParserOptions.maxBatchBytes`, require
   * the whole thing to be buffered, and hand the server a single multi-hundred
   * -megabyte batch. `SET IDENTITY_INSERT` is *session*-scoped, not
   * batch-scoped, so splitting data across batches is safe. Turn it off only
   * when generating SQL for a consumer that has no `GO` support at all —
   * `maxRowsPerBatch` and `maxBatchBytes` then have nothing to act on.
   */
  readonly emitBatchSeparators?: boolean;
}

export interface TableDataExportRequest {
  readonly connection: MssqlConnection;
  readonly schemaName: string;
  readonly pureName: string;
  readonly writer: DumpWriter;
  /**
   * When provided, used to detect an identity column (`SET IDENTITY_INSERT`),
   * exclude computed/`rowversion`/unsupported-type columns from `INSERT`,
   * and render each value using its actual SQL Server type (exact vs.
   * approximate numeric, unicode vs. non-unicode strings, date/time
   * precision). Without it, every result column is exported using a
   * JS-runtime-type-only fallback and no column is excluded — optional
   * because data export does not strictly depend on introspection having
   * run, but callers that have a table model should always supply it.
   */
  readonly table?: MssqlTable;
  /**
   * Column names to `ORDER BY` when reading rows — normally the table's
   * primary key, which `dumpMssql` passes automatically.
   *
   * Without an explicit order SQL Server makes no guarantee at all: a heap
   * scan, a parallel plan, page splits, or a plan change can each reorder
   * rows between two otherwise identical dumps, which breaks byte-comparing
   * or hashing dump output. Row order is not semantically meaningful (keys
   * are written explicitly), so this exists purely for reproducible output.
   */
  readonly orderByColumns?: readonly string[];
  readonly options?: TableDataExportOptions;
  readonly signal?: AbortSignal;
  readonly onProgress?: DumpProgressCallback;
}

export interface TableDataExportResult {
  readonly rowsExported: number;
  readonly bytesWritten: number;
  readonly cancelled: boolean;
  /** Structured, one-per-column notices for excluded/precision-limited columns (see `columnValueRenderer.ts`). */
  readonly warnings: readonly MssqlDiagnostic[];
}

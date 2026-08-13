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
   */
  readonly maxRowsPerStatement?: number;
  /**
   * Approximate maximum size, in UTF-8 bytes, of one `INSERT` statement's
   * rendered `VALUES` list — a safety cap independent of row count, so one
   * batch of unusually wide rows cannot produce an unreasonably large
   * single statement. Defaults to 4,000,000 bytes.
   */
  readonly maxStatementBytes?: number;
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

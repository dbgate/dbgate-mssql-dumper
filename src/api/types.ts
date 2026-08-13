import type { DumpMode } from '../archive/types.js';
import type { TableDataExportOptions } from '../data/types.js';
import type { MssqlDiagnostic } from '../model/diagnostics.js';
import type { PlainSqlRenderOptions } from '../renderer/types.js';
import type { DumpSelection } from '../selection/types.js';

export interface DumpMssqlOptions {
  /** `'full'` (default): schema and data. `'schema-only'`: definitions only. `'data-only'`: row data only. */
  readonly mode?: DumpMode;
  readonly selection?: DumpSelection;
  readonly render?: PlainSqlRenderOptions;
  /** Row batching/streaming options for table data export (see `exportTableDataAsInserts`). */
  readonly dataExport?: TableDataExportOptions;
}

export interface DumpResult {
  readonly bytesWritten: number;
  readonly renderedDumpIds: readonly string[];
  readonly skippedDumpIds: readonly string[];
  readonly warnings: readonly MssqlDiagnostic[];
  readonly cancelled: boolean;
  /** Total rows written across every exported table (`mode: 'full' | 'data-only'`). */
  readonly rowsExported: number;
}

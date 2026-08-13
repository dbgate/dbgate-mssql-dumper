import type { MssqlColumn } from '../model/column.js';
import type { MssqlDiagnostic } from '../model/diagnostics.js';
import { quoteIdentifier, quoteQualifiedIdentifier } from '../security/identifiers.js';
import { renderSqlLiteral } from '../security/literals.js';
import type { SqlLiteralValue } from '../security/literals.js';
import { throwIfAborted } from '../utils/errors.js';
import {
  classifyColumnForExport,
  columnExportDiagnostics,
  renderColumnValue,
} from './columnValueRenderer.js';
import type { TableDataExportRequest, TableDataExportResult } from './types.js';

/** SQL Server's own hard limit on rows in one `VALUES` table-value-constructor. */
const MAX_ROWS_PER_STATEMENT_CEILING = 1000;

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'OperationCancelledError')
  );
}

/**
 * Streams every row of one table as deterministic `INSERT INTO ...` batches.
 * Requires a live connection; this is intentionally separate from
 * `renderPlainSql`, which only renders schema objects from the static
 * introspected model and never touches the database.
 *
 * When `request.table` is supplied, only columns `classifyColumnForExport`
 * calls `'insertable'` are selected and inserted (computed and
 * `rowversion`/`timestamp` columns are never valid `INSERT` targets;
 * unsupported types are excluded defensively — see `columnValueRenderer.ts`
 * for the full list and the diagnostics each exclusion produces), and each
 * value is rendered using its actual SQL Server type. Without a table
 * model, every result column from a plain `SELECT *` is exported using the
 * JS-runtime-type-only fallback in `renderSqlLiteral`, and none are
 * excluded — callers that have a table model should always supply it.
 */
export async function exportTableDataAsInserts(
  request: TableDataExportRequest,
): Promise<TableDataExportResult> {
  const { connection, schemaName, pureName, writer, table, signal, onProgress } = request;
  const tableIdent = quoteQualifiedIdentifier([schemaName, pureName]);
  const maxRowsPerStatement = Math.min(
    MAX_ROWS_PER_STATEMENT_CEILING,
    Math.max(1, request.options?.maxRowsPerStatement ?? 100),
  );
  const maxStatementBytes = Math.max(1, request.options?.maxStatementBytes ?? 4_000_000);
  const streamBatchSize = request.options?.streamBatchSize;

  const emit = (text: string): Promise<void> => writer.write(`${text}\n`, signal);

  const warnings: MssqlDiagnostic[] = [];
  let rowsExported = 0;

  const insertableColumns: MssqlColumn[] | null = table
    ? table.columns
        .slice()
        .sort((a, b) => a.ordinalPosition - b.ordinalPosition)
        .filter(column => {
          warnings.push(...columnExportDiagnostics(column, schemaName, pureName));
          return classifyColumnForExport(column) === 'insertable';
        })
    : null;

  const hasIdentityColumn = insertableColumns?.some(column => column.isIdentity) ?? false;
  let identityInsertOpened = false;

  const progress = (): void => {
    onProgress?.({
      phase: 'exporting-data',
      message: `${schemaName}.${pureName}`,
      objectsProcessed: rowsExported,
      bytesWritten: writer.bytesWritten,
    });
  };

  try {
    if (hasIdentityColumn) {
      await emit(`SET IDENTITY_INSERT ${tableIdent} ON;`);
      identityInsertOpened = true;
    }

    if (insertableColumns && insertableColumns.length === 0) {
      // Every column is computed, generated, or an unsupported type: there is nothing to select or
      // bind, but the table can still have rows. `DEFAULT VALUES` is valid T-SQL for exactly this
      // case; a plain row count is enough to know how many times to emit it.
      const countResult = await connection.query<{ rowCount: number }>(
        { sql: `SELECT COUNT(*) as rowCount FROM ${tableIdent}` },
        signal,
      );
      const rowCount = Number(countResult.rows[0]?.rowCount ?? 0);
      for (let i = 0; i < rowCount; i++) {
        throwIfAborted(signal);
        await emit(`INSERT INTO ${tableIdent} DEFAULT VALUES;`);
        rowsExported++;
        progress();
      }
    } else if (insertableColumns) {
      const columnList = insertableColumns
        .map(column => quoteIdentifier(column.columnName))
        .join(', ');
      let batchTuples: string[] = [];
      let batchBytes = 0;

      const flushBatch = async (): Promise<void> => {
        if (batchTuples.length === 0) {
          return;
        }
        await emit(`INSERT INTO ${tableIdent} (${columnList}) VALUES\n${batchTuples.join(',\n')};`);
        batchTuples = [];
        batchBytes = 0;
      };

      for await (const row of connection.stream(
        { sql: `SELECT ${columnList} FROM ${tableIdent}` },
        { signal, batchSize: streamBatchSize },
      )) {
        throwIfAborted(signal);
        const tuple = `(${insertableColumns.map(column => renderColumnValue(row[column.columnName] ?? null, column)).join(', ')})`;
        const tupleBytes = Buffer.byteLength(tuple, 'utf8');
        if (
          batchTuples.length > 0 &&
          (batchTuples.length >= maxRowsPerStatement || batchBytes + tupleBytes > maxStatementBytes)
        ) {
          await flushBatch();
        }
        batchTuples.push(tuple);
        batchBytes += tupleBytes;
        rowsExported++;
        progress();
      }
      await flushBatch();
    } else {
      // No table model: fall back to a plain `SELECT *`, column order taken from the first row
      // (relies on `MssqlConnection` returning every selected column key on every row, per its
      // contract), rendered with the JS-runtime-type-only generic literal renderer.
      let columns: string[] | null = null;
      for await (const row of connection.stream(
        { sql: `SELECT * FROM ${tableIdent}` },
        { signal, batchSize: streamBatchSize },
      )) {
        throwIfAborted(signal);
        if (!columns) {
          columns = Object.keys(row);
        }
        const values = columns.map(column => renderSqlLiteral(row[column] as SqlLiteralValue));
        const columnListText = columns.map(column => quoteIdentifier(column)).join(', ');
        await emit(`INSERT INTO ${tableIdent} (${columnListText}) VALUES (${values.join(', ')});`);
        rowsExported++;
        progress();
      }
    }

    if (identityInsertOpened) {
      await emit(`SET IDENTITY_INSERT ${tableIdent} OFF;`);
      identityInsertOpened = false;
    }

    return { rowsExported, bytesWritten: writer.bytesWritten, cancelled: false, warnings };
  } catch (error) {
    if (identityInsertOpened) {
      // Best-effort: never leave the generated script with an unbalanced `SET IDENTITY_INSERT ON`
      // that would affect unrelated statements later in the same restore session. Swallow a
      // secondary failure here so it never masks the original error.
      try {
        await emit(`SET IDENTITY_INSERT ${tableIdent} OFF;`);
      } catch {
        // ignored
      }
    }
    if (isAbortError(error)) {
      return { rowsExported, bytesWritten: writer.bytesWritten, cancelled: true, warnings };
    }
    throw error;
  }
}

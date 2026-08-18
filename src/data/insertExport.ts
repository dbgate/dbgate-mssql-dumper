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
  const emitBatchSeparators = request.options?.emitBatchSeparators ?? true;

  const emit = (text: string): Promise<void> => writer.write(`${text}\n`, signal);

  /**
   * Closes the current T-SQL batch. Without these, a large table's data would
   * be one single batch — unrestorable past the batch-size limit and
   * requiring the whole thing in memory on the way back in.
   * `SET IDENTITY_INSERT` survives a batch boundary (it is session-scoped),
   * so this is safe between the ON and OFF statements.
   */
  const emitBatchSeparator = async (): Promise<void> => {
    if (emitBatchSeparators) {
      await emit('GO');
    }
  };

  const orderByClause =
    request.orderByColumns && request.orderByColumns.length > 0
      ? // `always-quote`: these names are never read by a human, and the default
        // `quote-when-needed` policy leaves *context-sensitive* keywords bare —
        // a primary-key column named `OFFSET` would turn `ORDER BY OFFSET` into
        // the start of an OFFSET/FETCH clause and fail the whole export.
        ` ORDER BY ${request.orderByColumns
          .map(name => quoteIdentifier(name, 'always-quote'))
          .join(', ')}`
      : '';

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

  // Without a table model the identity column cannot be recognized from the
  // model, yet `SELECT *` still selects it and the generated `INSERT` still
  // names it — which fails at restore with "Cannot insert explicit value for
  // identity column ... when IDENTITY_INSERT is set to OFF". One cheap
  // catalog probe (fully parameterized) keeps the fallback path correct
  // rather than silently emitting an unrestorable dump.
  const hasIdentityColumn = insertableColumns
    ? insertableColumns.some(column => column.isIdentity)
    : await tableHasIdentityColumn(request);
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
        if (rowsExported % maxRowsPerStatement === 0) {
          await emitBatchSeparator();
        }
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
        await emitBatchSeparator();
        batchTuples = [];
        batchBytes = 0;
      };

      for await (const row of connection.stream(
        { sql: `SELECT ${columnList} FROM ${tableIdent}${orderByClause}` },
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
        { sql: `SELECT * FROM ${tableIdent}${orderByClause}` },
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
        if (rowsExported % maxRowsPerStatement === 0) {
          await emitBatchSeparator();
        }
        progress();
      }
    }

    if (identityInsertOpened) {
      await emit(`SET IDENTITY_INSERT ${tableIdent} OFF;`);
      identityInsertOpened = false;
      await emitBatchSeparator();
    }

    return { rowsExported, bytesWritten: writer.bytesWritten, cancelled: false, warnings };
  } catch (error) {
    if (identityInsertOpened) {
      // Best-effort: never leave the generated script with an unbalanced `SET IDENTITY_INSERT ON`
      // that would affect unrelated statements later in the same restore session. Swallow a
      // secondary failure here so it never masks the original error.
      //
      // Deliberately written *without* `signal`: the overwhelmingly common
      // reason for landing here is that `signal` was just aborted, and passing
      // it back into the writer would make this recovery write throw before
      // emitting anything — guaranteeing the unbalanced `ON` it exists to
      // prevent.
      try {
        await writer.write(`SET IDENTITY_INSERT ${tableIdent} OFF;\n`);
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

/**
 * Asks the catalog whether the table has an identity column, for the
 * no-table-model fallback path. The table name travels as a bound parameter
 * and is resolved by `OBJECT_ID`, never concatenated into the query text.
 */
async function tableHasIdentityColumn(request: TableDataExportRequest): Promise<boolean> {
  const result = await request.connection.query<{ hasIdentity: number | null }>(
    {
      sql: "select objectproperty(object_id(@qualifiedName), 'TableHasIdentity') as hasIdentity",
      parameters: [
        {
          name: 'qualifiedName',
          value: quoteQualifiedIdentifier([request.schemaName, request.pureName]),
          sqlType: 'NVarChar',
        },
      ],
    },
    request.signal,
  );
  return Number(result.rows[0]?.hasIdentity ?? 0) === 1;
}

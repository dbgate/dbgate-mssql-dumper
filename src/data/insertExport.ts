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

/**
 * Rows per `INSERT` statement by default — deliberately far below
 * {@link MAX_ROWS_PER_STATEMENT_CEILING}.
 *
 * Larger statements *should* be cheaper: each statement is its own implicit
 * transaction, so 1000-row statements commit a tenth as often as 100-row ones.
 * Measured against SQL Server 2022 (200k narrow rows, restore timed end to
 * end), they are not: raising this to 1000 made restores consistently slower,
 * by roughly a third, whether or not the statements were packed into batches —
 * a large `VALUES` table-value-constructor costs more to compile and
 * materialize than the commits it saves. The win in this area came from
 * `maxRowsPerBatch` instead, which cuts round trips without growing the
 * statements. Callers whose workload disagrees can still raise it.
 */
const DEFAULT_MAX_ROWS_PER_STATEMENT = 100;

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
    Math.max(1, request.options?.maxRowsPerStatement ?? DEFAULT_MAX_ROWS_PER_STATEMENT),
  );
  const maxStatementBytes = Math.max(1, request.options?.maxStatementBytes ?? 4_000_000);
  const maxRowsPerBatch = Math.max(1, request.options?.maxRowsPerBatch ?? 10_000);
  const maxBatchBytes = Math.max(1, request.options?.maxBatchBytes ?? 8_000_000);
  const streamBatchSize = request.options?.streamBatchSize;
  const emitBatchSeparators = request.options?.emitBatchSeparators ?? true;

  const emit = (text: string): Promise<void> => writer.write(`${text}\n`, signal);

  let batchRows = 0;
  let batchBytes = 0;
  let batchHasContent = false;

  /**
   * Closes the current T-SQL batch, if anything has been written into it.
   *
   * Without these separators a large table's data would be one single batch —
   * unrestorable past the batch-size limit and requiring the whole thing in
   * memory on the way back in. `SET IDENTITY_INSERT` survives a batch boundary
   * (it is session-scoped), so this is safe between the ON and OFF statements.
   */
  const endBatch = async (): Promise<void> => {
    if (!batchHasContent) {
      return;
    }
    batchRows = 0;
    batchBytes = 0;
    batchHasContent = false;
    if (emitBatchSeparators) {
      await emit('GO');
    }
  };

  /**
   * Writes one complete statement, then closes the batch once it is full.
   *
   * A batch holds *many* statements rather than exactly one, because every
   * batch costs a full client/server round trip at restore time: a `GO` after
   * each `INSERT` turns a million-row table into thousands of sequential round
   * trips, which dominates restore time on anything but a local server.
   *
   * `rows` is 0 for bookkeeping statements (`SET IDENTITY_INSERT`), which ride
   * along in whatever batch is open without counting toward its row cap.
   * `byteLength` is the statement's exact rendered size, excluding the line
   * terminator this function itself writes — computed by the caller from parts
   * it has already measured, never by re-scanning the assembled statement text
   * (which is up to `maxStatementBytes` long).
   */
  const emitStatement = async (sql: string, byteLength: number, rows: number): Promise<void> => {
    // Closing *before* writing, rather than after, keeps both caps true upper
    // bounds on what a batch contains — the same way `maxStatementBytes`
    // bounds a statement — instead of limits a batch is allowed to overshoot
    // by one statement. A batch always holds at least one statement, however
    // far over the caps that single statement is on its own.
    const writtenBytes = byteLength + 1; // the line terminator `emit` appends
    if (
      batchHasContent &&
      (batchRows + rows > maxRowsPerBatch || batchBytes + writtenBytes > maxBatchBytes)
    ) {
      await endBatch();
    }
    await emit(sql);
    batchHasContent = true;
    batchRows += rows;
    batchBytes += writtenBytes;
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
      const statement = `SET IDENTITY_INSERT ${tableIdent} ON;`;
      await emitStatement(statement, Buffer.byteLength(statement, 'utf8'), 0);
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
      // Every row renders to the identical statement, so its size is measured once.
      const statement = `INSERT INTO ${tableIdent} DEFAULT VALUES;`;
      const statementBytes = Buffer.byteLength(statement, 'utf8');
      for (let i = 0; i < rowCount; i++) {
        throwIfAborted(signal);
        await emitStatement(statement, statementBytes, 1);
        rowsExported++;
        progress();
      }
    } else if (insertableColumns) {
      const columnList = insertableColumns
        .map(column => quoteIdentifier(column.columnName))
        .join(', ');
      const statementHeader = `INSERT INTO ${tableIdent} (${columnList}) VALUES\n`;
      const statementHeaderBytes = Buffer.byteLength(statementHeader, 'utf8');
      let statementTuples: string[] = [];
      let statementBytes = 0;

      const flushStatement = async (): Promise<void> => {
        if (statementTuples.length === 0) {
          return;
        }
        const rows = statementTuples.length;
        const sql = `${statementHeader}${statementTuples.join(',\n')};`;
        // Exact: the header, the measured tuples, the `,\n` between each
        // adjacent pair, and the terminating `;`.
        const byteLength = statementHeaderBytes + statementBytes + 2 * (rows - 1) + 1;
        statementTuples = [];
        statementBytes = 0;
        await emitStatement(sql, byteLength, rows);
      };

      for await (const row of connection.stream(
        { sql: `SELECT ${columnList} FROM ${tableIdent}${orderByClause}` },
        { signal, batchSize: streamBatchSize },
      )) {
        throwIfAborted(signal);
        const tuple = `(${insertableColumns.map(column => renderColumnValue(row[column.columnName] ?? null, column)).join(', ')})`;
        const tupleBytes = Buffer.byteLength(tuple, 'utf8');
        if (
          statementTuples.length > 0 &&
          (statementTuples.length >= maxRowsPerStatement ||
            statementBytes + tupleBytes > maxStatementBytes)
        ) {
          await flushStatement();
        }
        statementTuples.push(tuple);
        statementBytes += tupleBytes;
        rowsExported++;
        progress();
      }
      await flushStatement();
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
        const statement = `INSERT INTO ${tableIdent} (${columnListText}) VALUES (${values.join(', ')});`;
        await emitStatement(statement, Buffer.byteLength(statement, 'utf8'), 1);
        rowsExported++;
        progress();
      }
    }

    if (identityInsertOpened) {
      const statement = `SET IDENTITY_INSERT ${tableIdent} OFF;`;
      await emitStatement(statement, Buffer.byteLength(statement, 'utf8'), 0);
      identityInsertOpened = false;
    }
    // Closes whatever the last statements left open. Emits nothing when the
    // table produced no statements at all (an empty table with no identity
    // column), so a data-only dump of empty tables stays free of stray `GO`s.
    await endBatch();

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

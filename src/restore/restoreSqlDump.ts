import { acquireMssqlConnection } from '../connection/acquire.js';
import type { MssqlConnection } from '../connection/types.js';
import { throwIfAborted } from '../utils/errors.js';
import { redactSecrets, safeSqlPreview } from './batches.js';
import { streamSqlBatches } from './batchParser.js';
import type { ParsedSqlBatch } from './batchParser.js';
import { RestoreExecutionError } from './errors.js';
import { InsertBatchPreparer } from './insertBatch.js';
import type { PreparedInsertBatchOperation } from './insertBatch.js';
import type { RestoreBatchError, SqlDumpRestoreRequest, SqlDumpRestoreResult } from './types.js';

interface RestoreExecutionDescriptor {
  readonly executionMode: 'bulk-insert' | 'sql-direct' | 'sql-fallback';
  readonly executionReason?: string;
  readonly schemaName: string;
  readonly tableName: string;
}

function describePreparedInsertBatch(
  operations: readonly PreparedInsertBatchOperation[],
): RestoreExecutionDescriptor | undefined {
  let schemaName: string | undefined;
  let tableName: string | undefined;
  let hasBulk = false;
  let sqlExecutionMode: 'sql-direct' | 'sql-fallback' | undefined;
  let executionReason: string | undefined;

  for (const operation of operations) {
    const operationSchema =
      operation.kind === 'bulk' ? operation.request.schemaName : operation.schemaName;
    const operationTable =
      operation.kind === 'bulk' ? operation.request.tableName : operation.tableName;
    if (!operationSchema || !operationTable) return undefined;
    if (schemaName && (schemaName !== operationSchema || tableName !== operationTable))
      return undefined;
    schemaName = operationSchema;
    tableName = operationTable;
    if (operation.kind === 'bulk') hasBulk = true;
    else if (operation.executionMode) {
      sqlExecutionMode = operation.executionMode;
      executionReason = operation.executionReason;
    }
  }

  return schemaName && tableName
    ? {
        executionMode: hasBulk ? 'bulk-insert' : (sqlExecutionMode ?? 'sql-fallback'),
        ...(!hasBulk && executionReason ? { executionReason } : {}),
        schemaName,
        tableName,
      }
    : undefined;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'OperationCancelledError')
  );
}

/**
 * Executes one already-batch-scoped `sql` string against `connection`,
 * using genuine batch semantics (`MssqlConnection.execBatch`, equivalent to
 * Tedious's `execSqlBatch`) when the adapter provides it, falling back to
 * `query()` — required so `CREATE PROCEDURE`/`CREATE VIEW`/`CREATE
 * FUNCTION`/`CREATE TRIGGER` and batch-scoped constructs behave exactly as
 * they would through `sqlcmd`/SSMS, not sandboxed inside `sp_executesql`.
 */
async function executeBatchText(
  connection: MssqlConnection,
  sql: string,
  signal?: AbortSignal,
): Promise<{ rowsAffected: number }> {
  if (connection.execBatch) {
    return connection.execBatch(sql, signal);
  }
  const result = await connection.query({ sql }, signal);
  return { rowsAffected: result.rowsAffected };
}

async function executePreparedInsertBatch(
  connection: MssqlConnection,
  operations: readonly PreparedInsertBatchOperation[],
  sessionState: RestoreSessionState,
  signal?: AbortSignal,
): Promise<{ rowsAffected: number }> {
  let rowsAffected = 0;
  for (const operation of operations) {
    throwIfAborted(signal);
    if (operation.kind === 'sql') {
      const result = await executeBatchText(connection, operation.sql, signal);
      rowsAffected += result.rowsAffected;
      // Observe each session-scoped statement immediately: if a later bulk
      // operation fails, cleanup must know that IDENTITY_INSERT is still on.
      sessionState.observe(operation.sql);
    } else {
      // Prepared operations are only produced when this capability exists.
      const result = await connection.bulkInsert!(operation.request, signal);
      rowsAffected += result.rowsAffected;
    }
  }
  return { rowsAffected };
}

/**
 * Restores a plain-SQL dump using only the {@link MssqlConnection}
 * abstraction — no `sqlcmd`, SMO, or external process. The input is parsed
 * into `GO`-separated batches by a streaming lexer (see `batchParser.ts`)
 * that recognizes `GO` only as a real standalone batch separator, never
 * inside a string/bracketed identifier/comment, and executes each batch
 * sequentially. A structural problem with the input itself (an unterminated
 * string, an invalid `GO` repeat count, an unsupported `sqlcmd` directive)
 * throws — see `errors.ts` — since the batch boundaries cannot be trusted
 * past that point. A batch that parses correctly but fails when executed is
 * instead recorded in `result.errors`, and — unless `stopOnError` (the
 * default) is set — restoration continues with the next batch.
 */
export async function restoreSqlDump(
  request: SqlDumpRestoreRequest,
): Promise<SqlDumpRestoreResult> {
  const stopOnError = request.options?.stopOnError ?? true;
  const acquired = await acquireMssqlConnection(request.connection, request.signal);

  let batchesExecuted = 0;
  let batchesFailed = 0;
  let rowsRestored = 0;
  const errors: RestoreBatchError[] = [];

  const report = (
    phase: 'parsing' | 'executing' | 'finalizing',
    batch?: ParsedSqlBatch,
    descriptor?: RestoreExecutionDescriptor,
    executionState?: 'started' | 'finished' | 'failed',
  ): void => {
    request.progress?.({
      phase,
      batchIndex: batch?.batchIndex,
      statementsProcessed: batchesExecuted + batchesFailed,
      rowsRestored,
      ...descriptor,
      executionState,
    });
  };

  const sessionState = new RestoreSessionState();
  const insertBatchPreparer =
    (request.options?.bulkInsertMode ?? 'auto') === 'auto' && acquired.connection.bulkInsert
      ? new InsertBatchPreparer(acquired.connection)
      : null;

  try {
    for await (const batch of streamSqlBatches(request.source, request.options, request.signal)) {
      report('parsing', batch);

      let preparedInsertBatch: readonly PreparedInsertBatchOperation[] | null = null;
      if (insertBatchPreparer) {
        try {
          preparedInsertBatch = await insertBatchPreparer.prepare(batch.sql, request.signal);
        } catch (error) {
          if (isAbortError(error)) throw error;
          // Metadata lookup is an optimization prerequisite, not part of the
          // restore itself. Permission/client limitations therefore use the
          // same correctness-preserving fallback as an unrecognized literal.
          preparedInsertBatch = null;
        }
      }

      const executionDescriptor = preparedInsertBatch
        ? describePreparedInsertBatch(preparedInsertBatch)
        : undefined;

      for (let repetition = 0; repetition < batch.repeatCount; repetition++) {
        throwIfAborted(request.signal);
        report('executing', batch, executionDescriptor, 'started');
        try {
          const result = preparedInsertBatch
            ? await executePreparedInsertBatch(
                acquired.connection,
                preparedInsertBatch,
                sessionState,
                request.signal,
              )
            : await executeBatchText(acquired.connection, batch.sql, request.signal);
          if (!preparedInsertBatch) sessionState.observe(batch.sql);
          rowsRestored += result.rowsAffected;
          batchesExecuted++;
          report('executing', batch, executionDescriptor, 'finished');
        } catch (error) {
          if (isAbortError(error)) {
            throw error;
          }
          batchesFailed++;
          report('executing', batch, executionDescriptor, 'failed');
          const executionError = new RestoreExecutionError(
            batch.batchIndex,
            batch.location,
            safeSqlPreview(batch.sql),
            redactSecrets(error instanceof Error ? error.message : String(error)),
            { cause: error },
          );
          errors.push({
            batchIndex: executionError.batchIndex,
            location: executionError.location,
            sqlPreview: executionError.sqlPreview,
            message: executionError.message,
          });
          if (stopOnError) {
            await sessionState.restore(acquired.connection);
            return { batchesExecuted, batchesFailed, rowsRestored, errors, cancelled: false };
          }
        }
      }
    }

    report('finalizing');
    await sessionState.restore(acquired.connection);
    return { batchesExecuted, batchesFailed, rowsRestored, errors, cancelled: false };
  } catch (error) {
    await sessionState.restore(acquired.connection);
    if (isAbortError(error)) {
      return { batchesExecuted, batchesFailed, rowsRestored, errors, cancelled: true };
    }
    throw error;
  } finally {
    await acquired.release();
  }
}

const IDENTITY_INSERT_STATEMENT = /SET\s+IDENTITY_INSERT\s+(.+?)\s+(ON|OFF)\s*;/gi;
const ANSI_NULLS_OFF = /SET\s+ANSI_NULLS\s+OFF\s*;/i;
const QUOTED_IDENTIFIER_OFF = /SET\s+QUOTED_IDENTIFIER\s+OFF\s*;/i;

/**
 * Tracks session-scoped settings a restore script turned on, so they can be put
 * back if the restore stops early.
 *
 * `SET IDENTITY_INSERT` and the module `SET` options are **session** state, not
 * script state. The generated dump balances them, but a restore that stops at a
 * failing batch (the `stopOnError` default) or is cancelled never reaches the
 * closing statements — handing the caller's connection back to their pool with
 * `IDENTITY_INSERT` still ON for some table. Their next unrelated insert then
 * fails with "Explicit value must be specified for identity column", or their
 * next restore fails with "IDENTITY_INSERT is already ON for table ...", and
 * nothing in the API lets them clear it.
 */
class RestoreSessionState {
  private openIdentityInsertTable: string | null = null;
  private ansiNullsTurnedOff = false;
  private quotedIdentifierTurnedOff = false;

  /** Records the session effects of a batch that executed successfully. */
  observe(sql: string): void {
    for (const match of sql.matchAll(IDENTITY_INSERT_STATEMENT)) {
      this.openIdentityInsertTable = match[2]!.toUpperCase() === 'ON' ? match[1]!.trim() : null;
    }
    if (ANSI_NULLS_OFF.test(sql)) {
      this.ansiNullsTurnedOff = true;
    }
    if (QUOTED_IDENTIFIER_OFF.test(sql)) {
      this.quotedIdentifierTurnedOff = true;
    }
  }

  /**
   * Best-effort restoration of the settings this restore changed. Deliberately
   * issued **without** the caller's `AbortSignal` — the usual reason for being
   * here is that the signal was just aborted, and reusing it would make the
   * cleanup throw before doing anything. Secondary failures are swallowed so
   * they can never mask the original outcome.
   */
  async restore(connection: MssqlConnection): Promise<void> {
    const statements: string[] = [];
    if (this.openIdentityInsertTable) {
      statements.push(`SET IDENTITY_INSERT ${this.openIdentityInsertTable} OFF;`);
    }
    if (this.ansiNullsTurnedOff) {
      statements.push('SET ANSI_NULLS ON;');
    }
    if (this.quotedIdentifierTurnedOff) {
      statements.push('SET QUOTED_IDENTIFIER ON;');
    }
    this.openIdentityInsertTable = null;
    this.ansiNullsTurnedOff = false;
    this.quotedIdentifierTurnedOff = false;

    for (const sql of statements) {
      try {
        await executeBatchText(connection, sql);
      } catch {
        // ignored: cleanup must never replace the real result or error
      }
    }
  }
}

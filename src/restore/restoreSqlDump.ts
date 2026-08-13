import { acquireMssqlConnection } from '../connection/acquire.js';
import { throwIfAborted } from '../utils/errors.js';
import { safeSqlPreview, splitSqlIntoBatches } from './batches.js';
import type {
  RestoreStatementError,
  SqlDumpRestoreRequest,
  SqlDumpRestoreResult,
  SqlDumpSource,
} from './types.js';

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'OperationCancelledError')
  );
}

async function readAllText(source: SqlDumpSource): Promise<string> {
  if (typeof source === 'string') {
    return source;
  }
  const chunks: string[] = [];
  for await (const chunk of source) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  }
  return chunks.join('');
}

/**
 * Restores a plain-SQL dump by splitting it into `GO`-separated batches and
 * executing each sequentially against one connection. This is a plain-text
 * executor, not a parser: it trusts the batch boundaries in the input and
 * sends each batch's text unmodified.
 */
export async function restoreSqlDump(
  request: SqlDumpRestoreRequest,
): Promise<SqlDumpRestoreResult> {
  const stopOnError = request.options?.stopOnError ?? true;
  const acquired = await acquireMssqlConnection(request.connection, request.signal);

  let statementsExecuted = 0;
  let statementsFailed = 0;
  const errors: RestoreStatementError[] = [];

  try {
    const sqlText = await readAllText(request.sql);
    const batches = splitSqlIntoBatches(sqlText);
    const total = batches.reduce((sum, batch) => sum + batch.repeatCount, 0);
    let processed = 0;
    let batchIndex = 0;

    for (const batch of batches) {
      for (let repetition = 0; repetition < batch.repeatCount; repetition++) {
        throwIfAborted(request.signal);
        try {
          await acquired.connection.query({ sql: batch.sql }, request.signal);
          statementsExecuted++;
        } catch (error) {
          statementsFailed++;
          errors.push({
            batchIndex,
            sqlPreview: safeSqlPreview(batch.sql),
            message: error instanceof Error ? error.message : String(error),
          });
          if (stopOnError) {
            return { statementsExecuted, statementsFailed, errors, cancelled: false };
          }
        }
        processed++;
        request.onProgress?.({
          phase: 'executing',
          statementsProcessed: processed,
          statementsTotal: total,
        });
      }
      batchIndex++;
    }

    return { statementsExecuted, statementsFailed, errors, cancelled: false };
  } catch (error) {
    if (isAbortError(error)) {
      return { statementsExecuted, statementsFailed, errors, cancelled: true };
    }
    throw error;
  } finally {
    await acquired.release();
  }
}

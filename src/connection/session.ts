import { MssqlDumperError } from '../utils/errors.js';
import type { MssqlConnection } from './types.js';

/**
 * Determines ownership of the transaction boundary during a dump/
 * introspection operation.
 *
 * - `managed` (default): requires an idle connection, starts a transaction
 *   at `isolationLevel` and owns its commit/rollback.
 * - `existing`: requires an already-active transaction and never commits or
 *   rolls it back — the caller retains ownership.
 * - `none`: performs no transaction work and provides no cross-query
 *   consistency guarantee.
 */
export type MssqlTransactionMode = 'managed' | 'existing' | 'none';

/**
 * T-SQL transaction isolation levels. SQL Server has no equivalent of
 * PostgreSQL's `READ ONLY` transaction modifier or exported snapshot
 * identifiers: the isolation level held for the duration of the session is
 * the only consistency lever available here. `SNAPSHOT` gives the closest
 * analogue to PostgreSQL's `REPEATABLE READ` (non-blocking, versioned reads)
 * but requires `ALLOW_SNAPSHOT_ISOLATION ON` at the database level, which
 * this library cannot assume is set; `REPEATABLE READ` (the default) is
 * always available but takes shared locks for the duration of the
 * transaction.
 */
export type MssqlIsolationLevel =
  'READ UNCOMMITTED' | 'READ COMMITTED' | 'REPEATABLE READ' | 'SNAPSHOT' | 'SERIALIZABLE';

export interface MssqlSessionOptions {
  readonly transactionMode?: MssqlTransactionMode;
  /** Only meaningful when `transactionMode` is `managed`. Defaults to `REPEATABLE READ`. */
  readonly isolationLevel?: MssqlIsolationLevel;
}

export interface MssqlSession {
  readonly transactionMode: MssqlTransactionMode;
  /** No-op for `existing`/`none`. Idempotent: a second call does nothing. */
  commit(signal?: AbortSignal): Promise<void>;
  /** No-op for `existing`/`none`. Idempotent: a second call does nothing. */
  rollback(signal?: AbortSignal): Promise<void>;
}

const DEFAULT_ISOLATION_LEVEL: MssqlIsolationLevel = 'REPEATABLE READ';

function noopSession(transactionMode: MssqlTransactionMode): MssqlSession {
  return {
    transactionMode,
    commit: async () => {},
    rollback: async () => {},
  };
}

/**
 * Establishes the transaction boundary for one dump/introspection operation
 * on a single physical connection. Introspection and data export belonging
 * to the same dump should share one {@link MssqlSession} (built on one
 * {@link MssqlConnection}) so that every query observes the same transaction
 * state.
 *
 * `managed` mode refuses to start when the connection already reports
 * `in-transaction`, `failed`, or `unknown` (rather than issuing a nested
 * `BEGIN TRANSACTION`, which SQL Server would silently accept and only
 * commit the outermost of); `existing` mode refuses when the connection is
 * not already `in-transaction`. Connections whose adapter does not
 * implement {@link MssqlConnection.getTransactionStatus} report `unknown`
 * and are refused by `managed` for the same reason.
 */
export async function beginMssqlSession(
  connection: MssqlConnection,
  options: MssqlSessionOptions = {},
  signal?: AbortSignal,
): Promise<MssqlSession> {
  const transactionMode = options.transactionMode ?? 'managed';

  if (transactionMode === 'none') {
    return noopSession(transactionMode);
  }

  const status = connection.getTransactionStatus
    ? await connection.getTransactionStatus(signal)
    : 'unknown';

  if (transactionMode === 'existing') {
    if (status !== 'in-transaction') {
      throw new MssqlDumperError(
        'transaction-mode-mismatch',
        `transactionMode "existing" requires an already-active transaction, but the connection reports "${status}"`,
      );
    }
    return noopSession(transactionMode);
  }

  if (status !== 'idle') {
    throw new MssqlDumperError(
      'transaction-mode-mismatch',
      `transactionMode "managed" requires an idle connection, but it reports "${status}"`,
    );
  }

  const isolationLevel = options.isolationLevel ?? DEFAULT_ISOLATION_LEVEL;
  await connection.query({ sql: `SET TRANSACTION ISOLATION LEVEL ${isolationLevel};` }, signal);
  await connection.query({ sql: 'BEGIN TRANSACTION;' }, signal);

  let finished = false;
  return {
    transactionMode,
    commit: async (commitSignal?: AbortSignal) => {
      if (finished) return;
      finished = true;
      await connection.query({ sql: 'COMMIT TRANSACTION;' }, commitSignal);
    },
    rollback: async (rollbackSignal?: AbortSignal) => {
      if (finished) return;
      finished = true;
      await connection.query({ sql: 'ROLLBACK TRANSACTION;' }, rollbackSignal);
    },
  };
}

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

/** Closed allow-list guarding the one interpolated-into-SQL option this package has. */
const ALLOWED_ISOLATION_LEVELS: ReadonlySet<MssqlIsolationLevel> = new Set([
  'READ UNCOMMITTED',
  'READ COMMITTED',
  'REPEATABLE READ',
  'SNAPSHOT',
  'SERIALIZABLE',
]);

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
  if (!ALLOWED_ISOLATION_LEVELS.has(isolationLevel)) {
    // `SET TRANSACTION ISOLATION LEVEL` takes no bound parameter, so this is
    // the one place in the package where a caller-supplied string reaches SQL
    // text. The `MssqlIsolationLevel` union only constrains TypeScript
    // callers; a plain-JS caller (or a value read from a config file or an
    // HTTP body) can pass anything, so validate against a closed allow-list
    // rather than trusting the compile-time type.
    throw new MssqlDumperError(
      'invalid-isolation-level',
      `Unsupported transaction isolation level ${JSON.stringify(isolationLevel)}; expected one of: ${[...ALLOWED_ISOLATION_LEVELS].join(', ')}`,
    );
  }
  await connection.query({ sql: `SET TRANSACTION ISOLATION LEVEL ${isolationLevel};` }, signal);
  await connection.query({ sql: 'BEGIN TRANSACTION;' }, signal);

  let finished = false;
  return {
    transactionMode,
    commit: async (commitSignal?: AbortSignal) => {
      if (finished) return;
      // Marked finished only *after* the statement succeeds. Setting it first
      // would make a failed COMMIT (a cancelled request, a broken connection)
      // silently turn the caller's follow-up `rollback()` into a no-op, handing
      // a pooled connection back with the transaction still open and its
      // REPEATABLE READ locks still held.
      await connection.query({ sql: 'COMMIT TRANSACTION;' }, commitSignal);
      finished = true;
    },
    rollback: async (rollbackSignal?: AbortSignal) => {
      if (finished) return;
      // Marked finished unconditionally: a failed rollback leaves nothing worth
      // retrying, and retrying it would just raise the same error again.
      try {
        await connection.query({ sql: 'ROLLBACK TRANSACTION;' }, rollbackSignal);
      } finally {
        finished = true;
      }
    },
  };
}

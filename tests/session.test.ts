import { describe, expect, it } from 'vitest';
import { beginMssqlSession } from '../src/connection/session.js';
import type {
  MssqlConnection,
  MssqlQuery,
  MssqlQueryResult,
  MssqlRow,
  MssqlTransactionStatus,
} from '../src/connection/types.js';

function createFakeConnection(
  initialStatus: MssqlTransactionStatus,
  options?: { withStatus?: boolean },
): { connection: MssqlConnection; log: string[] } {
  const log: string[] = [];
  let status = initialStatus;
  const withStatus = options?.withStatus ?? true;

  const connection: MssqlConnection = {
    async query<Row extends MssqlRow = MssqlRow>(
      query: MssqlQuery,
    ): Promise<MssqlQueryResult<Row>> {
      log.push(query.sql);
      if (query.sql.startsWith('BEGIN TRANSACTION')) status = 'in-transaction';
      if (query.sql.startsWith('COMMIT') || query.sql.startsWith('ROLLBACK')) status = 'idle';
      return { rows: [], columns: [], rowsAffected: 0 };
    },
    stream<Row extends MssqlRow = MssqlRow>(): AsyncIterable<Row> {
      return (async function* () {})();
    },
    async cancel(): Promise<void> {},
    ...(withStatus ? { getTransactionStatus: async () => status } : {}),
  };

  return { connection, log };
}

describe('beginMssqlSession', () => {
  it('managed mode begins a transaction at the default isolation level and commits once', async () => {
    const { connection, log } = createFakeConnection('idle');
    const session = await beginMssqlSession(connection);

    expect(session.transactionMode).toBe('managed');
    expect(log).toEqual(['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;', 'BEGIN TRANSACTION;']);

    await session.commit();
    expect(log).toEqual([
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;',
      'BEGIN TRANSACTION;',
      'COMMIT TRANSACTION;',
    ]);

    // Idempotent: a second commit does not re-issue COMMIT.
    await session.commit();
    expect(log).toHaveLength(3);
  });

  it('managed mode honors an explicit isolation level', async () => {
    const { connection, log } = createFakeConnection('idle');
    await beginMssqlSession(connection, { isolationLevel: 'SNAPSHOT' });
    expect(log[0]).toBe('SET TRANSACTION ISOLATION LEVEL SNAPSHOT;');
  });

  it('managed mode refuses a connection that already reports being in a transaction', async () => {
    const { connection } = createFakeConnection('in-transaction');
    await expect(beginMssqlSession(connection)).rejects.toThrow(/managed/);
  });

  it('managed mode refuses a connection whose transaction status is unknown', async () => {
    const { connection } = createFakeConnection('idle', { withStatus: false });
    await expect(beginMssqlSession(connection)).rejects.toThrow(/idle/);
  });

  it('rollback issues ROLLBACK and is idempotent', async () => {
    const { connection, log } = createFakeConnection('idle');
    const session = await beginMssqlSession(connection);
    await session.rollback();
    await session.rollback();
    expect(log.filter(sql => sql === 'ROLLBACK TRANSACTION;')).toHaveLength(1);
  });

  it('existing mode requires an already-active transaction and never finishes it', async () => {
    const { connection, log } = createFakeConnection('in-transaction');
    const session = await beginMssqlSession(connection, { transactionMode: 'existing' });

    expect(log).toHaveLength(0);
    await session.commit();
    await session.rollback();
    expect(log).toHaveLength(0);
  });

  it('existing mode refuses an idle connection', async () => {
    const { connection } = createFakeConnection('idle');
    await expect(beginMssqlSession(connection, { transactionMode: 'existing' })).rejects.toThrow(
      /existing/,
    );
  });

  it('none mode issues no queries and its commit/rollback are no-ops', async () => {
    const { connection, log } = createFakeConnection('idle');
    const session = await beginMssqlSession(connection, { transactionMode: 'none' });

    expect(log).toHaveLength(0);
    await session.commit();
    await session.rollback();
    expect(log).toHaveLength(0);
  });
});

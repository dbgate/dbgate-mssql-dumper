import { describe, expect, it } from 'vitest';
import { isDumperSqlDump, splitSqlIntoBatches } from '../src/restore/batches.js';
import { restoreSqlDump } from '../src/restore/restoreSqlDump.js';
import type {
  MssqlConnection,
  MssqlQuery,
  MssqlQueryResult,
  MssqlRow,
} from '../src/connection/types.js';

describe('splitSqlIntoBatches', () => {
  it('splits on standalone GO lines', () => {
    const batches = splitSqlIntoBatches('SELECT 1;\nGO\nSELECT 2;\nGO\n');
    expect(batches).toEqual([
      { sql: 'SELECT 1;', repeatCount: 1 },
      { sql: 'SELECT 2;', repeatCount: 1 },
    ]);
  });

  it('does not split on GO that is not alone on its line', () => {
    const batches = splitSqlIntoBatches("SELECT 'GO home';\nGO\n");
    expect(batches).toEqual([{ sql: "SELECT 'GO home';", repeatCount: 1 }]);
  });

  it('honors a GO repeat count', () => {
    const batches = splitSqlIntoBatches('PRINT 1;\nGO 3\n');
    expect(batches).toEqual([{ sql: 'PRINT 1;', repeatCount: 3 }]);
  });

  it('includes a trailing batch with no final GO', () => {
    const batches = splitSqlIntoBatches('SELECT 1;\nGO\nSELECT 2;');
    expect(batches.map(b => b.sql)).toEqual(['SELECT 1;', 'SELECT 2;']);
  });
});

describe('isDumperSqlDump', () => {
  it('recognizes the renderPlainSql header', () => {
    expect(isDumperSqlDump('-- dbgate-mssql-dumper plain SQL dump\nCREATE TABLE ...')).toBe(true);
  });

  it('rejects unrelated text', () => {
    expect(isDumperSqlDump('CREATE TABLE Foo (Id INT);')).toBe(false);
  });
});

function createFakeConnection(behavior: {
  onQuery?: (query: MssqlQuery) => void;
  failOn?: (sql: string) => boolean;
}): MssqlConnection {
  return {
    async query<Row extends MssqlRow = MssqlRow>(
      query: MssqlQuery,
    ): Promise<MssqlQueryResult<Row>> {
      behavior.onQuery?.(query);
      if (behavior.failOn?.(query.sql)) {
        throw new Error(`simulated failure for: ${query.sql}`);
      }
      return { rows: [], columns: [], rowsAffected: 0 };
    },
    stream<Row extends MssqlRow = MssqlRow>(): AsyncIterable<Row> {
      return (async function* () {})();
    },
    async cancel(): Promise<void> {},
  };
}

describe('restoreSqlDump', () => {
  it('executes each batch in order against the connection', async () => {
    const executed: string[] = [];
    const connection = createFakeConnection({ onQuery: q => executed.push(q.sql) });

    const result = await restoreSqlDump({
      connection,
      sql: 'CREATE TABLE A (Id INT);\nGO\nCREATE TABLE B (Id INT);\nGO\n',
    });

    expect(executed).toEqual(['CREATE TABLE A (Id INT);', 'CREATE TABLE B (Id INT);']);
    expect(result.statementsExecuted).toBe(2);
    expect(result.statementsFailed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('stops at the first failing batch by default', async () => {
    const executed: string[] = [];
    const connection = createFakeConnection({
      onQuery: q => executed.push(q.sql),
      failOn: sql => sql.includes('TABLE B '),
    });

    const result = await restoreSqlDump({
      connection,
      sql: 'CREATE TABLE A (Id INT);\nGO\nCREATE TABLE B (Id INT);\nGO\nCREATE TABLE C (Id INT);\nGO\n',
    });

    expect(executed).toEqual(['CREATE TABLE A (Id INT);', 'CREATE TABLE B (Id INT);']);
    expect(result.statementsExecuted).toBe(1);
    expect(result.statementsFailed).toBe(1);
    expect(result.errors).toHaveLength(1);
  });

  it('continues past failures when stopOnError is false', async () => {
    const connection = createFakeConnection({ failOn: sql => sql.includes('TABLE B ') });

    const result = await restoreSqlDump({
      connection,
      sql: 'CREATE TABLE A (Id INT);\nGO\nCREATE TABLE B (Id INT);\nGO\nCREATE TABLE C (Id INT);\nGO\n',
      options: { stopOnError: false },
    });

    expect(result.statementsExecuted).toBe(2);
    expect(result.statementsFailed).toBe(1);
  });
});

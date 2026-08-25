import { describe, expect, it } from 'vitest';
import { isDumperSqlDump, safeSqlPreview } from '../src/restore/batches.js';
import { MalformedSqlDumpError, UnsupportedSqlcmdDirectiveError } from '../src/restore/errors.js';
import { restoreSqlDump } from '../src/restore/restoreSqlDump.js';
import type {
  MssqlBulkInsertRequest,
  MssqlConnection,
  MssqlExecBatchResult,
  MssqlQuery,
  MssqlQueryResult,
  MssqlRow,
} from '../src/connection/types.js';

function createBulkRestoreConnection(
  metadata: readonly MssqlRow[],
  options?: { readonly failBulk?: boolean },
): {
  readonly connection: MssqlConnection;
  readonly sqlBatches: string[];
  readonly bulkRequests: MssqlBulkInsertRequest[];
  readonly metadataQueries: MssqlQuery[];
} {
  const sqlBatches: string[] = [];
  const bulkRequests: MssqlBulkInsertRequest[] = [];
  const metadataQueries: MssqlQuery[] = [];
  const connection: MssqlConnection = {
    async query<Row extends MssqlRow = MssqlRow>(query: MssqlQuery) {
      if (query.sql.includes('from sys.columns c')) {
        metadataQueries.push(query);
        return { rows: metadata as readonly Row[], columns: [], rowsAffected: metadata.length };
      }
      sqlBatches.push(query.sql);
      return { rows: [], columns: [], rowsAffected: 0 };
    },
    async execBatch(sql: string) {
      sqlBatches.push(sql);
      return { rowsAffected: 0 };
    },
    async bulkInsert(request: MssqlBulkInsertRequest) {
      bulkRequests.push(request);
      if (options?.failBulk) throw new Error('simulated bulk failure');
      return { rowsAffected: request.rows.length };
    },
    stream() {
      return (async function* () {})();
    },
    async cancel() {},
  };
  return { connection, sqlBatches, bulkRequests, metadataQueries };
}

describe('isDumperSqlDump', () => {
  it('recognizes the renderPlainSql header', () => {
    expect(isDumperSqlDump('-- dbgate-mssql-dumper plain SQL dump\nCREATE TABLE ...')).toBe(true);
  });

  it('rejects unrelated text', () => {
    expect(isDumperSqlDump('CREATE TABLE Foo (Id INT);')).toBe(false);
  });
});

describe('safeSqlPreview', () => {
  it('truncates long SQL text', () => {
    const sql = `SELECT ${'x'.repeat(300)};`;
    const preview = safeSqlPreview(sql, 50);
    expect(preview.length).toBe(51); // 50 chars + the truncation ellipsis
    expect(preview.endsWith('…')).toBe(true);
  });

  it('collapses internal whitespace', () => {
    expect(safeSqlPreview('SELECT   1,\n\n  2;')).toBe('SELECT 1, 2;');
  });

  it('redacts a PASSWORD literal so it never appears in an error preview', () => {
    const preview = safeSqlPreview("CREATE LOGIN foo WITH PASSWORD = 'super-secret-123';");
    expect(preview).not.toContain('super-secret-123');
    expect(preview).toContain('PASSWORD = ');
    expect(preview).toContain('REDACTED');
  });

  it('redacts an IDENTIFIED BY literal', () => {
    const preview = safeSqlPreview("ALTER USER foo IDENTIFIED BY 'super-secret-123';");
    expect(preview).not.toContain('super-secret-123');
    expect(preview).toContain('REDACTED');
  });

  it('redacts a Unicode (N-prefixed) PASSWORD literal', () => {
    const preview = safeSqlPreview("CREATE LOGIN foo WITH PASSWORD = N'super-secret-123';");
    expect(preview).not.toContain('super-secret-123');
  });
});

interface FakeConnectionBehavior {
  readonly onExecute?: (sql: string) => void;
  readonly failOn?: (sql: string) => boolean;
  readonly rowsAffectedFor?: (sql: string) => number;
  readonly supportsExecBatch?: boolean;
}

function createFakeConnection(behavior: FakeConnectionBehavior = {}): MssqlConnection {
  const execute = (sql: string): { rowsAffected: number } => {
    behavior.onExecute?.(sql);
    if (behavior.failOn?.(sql)) {
      throw new Error(`simulated failure for: ${sql}`);
    }
    return { rowsAffected: behavior.rowsAffectedFor?.(sql) ?? 0 };
  };

  const base: MssqlConnection = {
    async query<Row extends MssqlRow = MssqlRow>(
      query: MssqlQuery,
    ): Promise<MssqlQueryResult<Row>> {
      const { rowsAffected } = execute(query.sql);
      return { rows: [], columns: [], rowsAffected };
    },
    stream<Row extends MssqlRow = MssqlRow>(): AsyncIterable<Row> {
      return (async function* () {})();
    },
    async cancel(): Promise<void> {},
  };

  if (behavior.supportsExecBatch) {
    return {
      ...base,
      async execBatch(sql: string): Promise<MssqlExecBatchResult> {
        return execute(sql);
      },
    };
  }
  return base;
}

describe('restoreSqlDump', () => {
  it('bulk-loads canonical generated INSERT batches and preserves literal values', async () => {
    const bulk = createBulkRestoreConnection([
      {
        columnName: 'id',
        dataType: 'int',
        maxLength: 4,
        precision: 10,
        scale: 0,
        isNullable: 0,
        isIdentity: 1,
      },
      {
        columnName: 'body',
        dataType: 'nvarchar',
        maxLength: -1,
        precision: 0,
        scale: 0,
        isNullable: 1,
        isIdentity: 0,
      },
      {
        columnName: 'payload',
        dataType: 'varbinary',
        maxLength: -1,
        precision: 0,
        scale: 0,
        isNullable: 1,
        isIdentity: 0,
      },
      {
        columnName: 'created',
        dataType: 'datetime2',
        maxLength: 8,
        precision: 27,
        scale: 7,
        isNullable: 0,
        isIdentity: 0,
      },
    ]);
    const source = `SET IDENTITY_INSERT dbo.[Items] ON;
INSERT INTO dbo.[Items] ([id], [body], [payload], [created]) VALUES
(1, N'hello ''world
GO
ok', 0x00ff, '2026-08-24T12:00:00.1234567'),
(2, NULL, NULL, '2026-08-24T12:01:00.0000000');
SET IDENTITY_INSERT dbo.[Items] OFF;
GO
`;

    const result = await restoreSqlDump({ connection: bulk.connection, source });

    expect(result.errors).toEqual([]);
    expect(result.rowsRestored).toBe(2);
    expect(result.batchesExecuted).toBe(1);
    expect(bulk.metadataQueries).toHaveLength(1);
    expect(bulk.sqlBatches).toEqual([
      'SET IDENTITY_INSERT dbo.[Items] ON;',
      'SET IDENTITY_INSERT dbo.[Items] OFF;',
    ]);
    expect(bulk.bulkRequests).toHaveLength(1);
    expect(bulk.bulkRequests[0]!.rows[0]![0]).toBe(1);
    expect(bulk.bulkRequests[0]!.columns[0]!.identity).toBe(true);
    expect(bulk.bulkRequests[0]!.rows[0]![1]).toBe("hello 'world\nGO\nok");
    expect(bulk.bulkRequests[0]!.rows[0]![2]).toEqual(Buffer.from([0, 255]));
    expect(bulk.bulkRequests[0]!.rows[0]![3]).toBeInstanceOf(Date);
    expect(
      (bulk.bulkRequests[0]!.rows[0]![3] as Date & { nanosecondDelta?: number }).nanosecondDelta,
    ).toBeCloseTo(0.0004567, 7);
  });

  it('falls back with the entire batch when an INSERT expression is not canonical', async () => {
    const bulk = createBulkRestoreConnection([]);
    const source = 'INSERT INTO dbo.Items (id, created) VALUES (1, GETDATE());\nGO\n';

    const result = await restoreSqlDump({ connection: bulk.connection, source });

    expect(result.errors).toEqual([]);
    expect(bulk.bulkRequests).toEqual([]);
    expect(bulk.metadataQueries).toEqual([]);
    expect(bulk.sqlBatches).toEqual(['INSERT INTO dbo.Items (id, created) VALUES (1, GETDATE());']);
  });

  it('falls back before writing anything when a target column type is unsupported for bulk', async () => {
    const bulk = createBulkRestoreConnection([
      {
        columnName: 'id',
        dataType: 'int',
        maxLength: 4,
        precision: 10,
        scale: 0,
        isNullable: 0,
        isIdentity: 0,
      },
      {
        columnName: 'document',
        dataType: 'xml',
        maxLength: -1,
        precision: 0,
        scale: 0,
        isNullable: 1,
        isIdentity: 0,
      },
    ]);
    const batch = "INSERT INTO dbo.Items (id, document) VALUES (1, N'<x/>');";

    await restoreSqlDump({ connection: bulk.connection, source: `${batch}\nGO\n` });

    expect(bulk.bulkRequests).toEqual([]);
    expect(bulk.sqlBatches).toEqual([batch]);
  });

  it('falls back before writing a decimal value outside the Tedious bulk encoder range', async () => {
    const bulk = createBulkRestoreConnection([
      {
        columnName: 'value',
        dataType: 'decimal',
        maxLength: 17,
        precision: 38,
        scale: 10,
        isNullable: 0,
        isIdentity: 0,
      },
    ]);
    const batch = 'INSERT INTO dbo.Items ([value]) VALUES (1234567890123456700000000000);';

    await restoreSqlDump({ connection: bulk.connection, source: `${batch}\nGO\n` });

    expect(bulk.bulkRequests).toEqual([]);
    expect(bulk.sqlBatches).toEqual([batch]);
  });

  it('falls back for a closing bracket in a column name that Tedious cannot quote', async () => {
    const bulk = createBulkRestoreConnection([
      {
        columnName: 'Col]Bracket',
        dataType: 'nvarchar',
        maxLength: 100,
        precision: 0,
        scale: 0,
        isNullable: 0,
        isIdentity: 0,
      },
    ]);
    const batch = "INSERT INTO dbo.Items ([Col]]Bracket]) VALUES (N'value');";

    await restoreSqlDump({ connection: bulk.connection, source: `${batch}\nGO\n` });

    expect(bulk.bulkRequests).toEqual([]);
    expect(bulk.sqlBatches).toEqual([batch]);
  });

  it('falls back for non-ASCII varchar data whose column collation is unknown to Tedious', async () => {
    const bulk = createBulkRestoreConnection([
      {
        columnName: 'body',
        dataType: 'varchar',
        maxLength: 100,
        precision: 0,
        scale: 0,
        isNullable: 0,
        isIdentity: 0,
      },
    ]);
    const batch = "INSERT INTO dbo.Items (body) VALUES (N'北京');";

    const progress: Array<{
      executionMode?: string;
      executionState?: string;
      schemaName?: string;
      tableName?: string;
    }> = [];

    await restoreSqlDump({
      connection: bulk.connection,
      source: `${batch}\nGO\n`,
      progress: event => progress.push(event),
    });

    expect(bulk.bulkRequests).toEqual([]);
    expect(bulk.sqlBatches).toEqual([batch]);
    expect(
      progress
        .filter(event => event.executionState)
        .map(event => ({
          executionMode: event.executionMode,
          executionState: event.executionState,
          schemaName: event.schemaName,
          tableName: event.tableName,
        })),
    ).toEqual([
      {
        executionMode: 'sql-fallback',
        executionState: 'started',
        schemaName: 'dbo',
        tableName: 'Items',
      },
      {
        executionMode: 'sql-fallback',
        executionState: 'finished',
        schemaName: 'dbo',
        tableName: 'Items',
      },
    ]);
  });

  it('splits a large canonical SQL fallback into bounded requests before executing it', async () => {
    const bulk = createBulkRestoreConnection([
      {
        columnName: 'body',
        dataType: 'varchar',
        maxLength: -1,
        precision: 0,
        scale: 0,
        isNullable: 0,
        isIdentity: 0,
      },
    ]);
    const statements = Array.from(
      { length: 20 },
      (_, index) => `INSERT INTO dbo.Items (body) VALUES (N'č-${index}-${'x'.repeat(20_000)}');`,
    );

    await restoreSqlDump({ connection: bulk.connection, source: `${statements.join('\n')}\nGO\n` });

    expect(bulk.bulkRequests).toEqual([]);
    expect(bulk.sqlBatches.length).toBeGreaterThan(1);
    expect(Math.max(...bulk.sqlBatches.map(sql => sql.length))).toBeLessThanOrEqual(256 * 1024);
    expect(bulk.sqlBatches.join('\n')).toBe(statements.join('\n'));
  });

  it('does not replay a batch after a bulk operation has started and failed', async () => {
    const bulk = createBulkRestoreConnection(
      [
        {
          columnName: 'id',
          dataType: 'int',
          maxLength: 4,
          precision: 10,
          scale: 0,
          isNullable: 0,
          isIdentity: 1,
        },
      ],
      { failBulk: true },
    );
    const source = `SET IDENTITY_INSERT dbo.Items ON;
INSERT INTO dbo.Items (id) VALUES (1);
SET IDENTITY_INSERT dbo.Items OFF;
GO
`;

    const result = await restoreSqlDump({ connection: bulk.connection, source });

    expect(result.batchesFailed).toBe(1);
    expect(bulk.bulkRequests).toHaveLength(1);
    // The first ON came from the prepared operation; the second statement is
    // cleanup. The original INSERT batch was never submitted again.
    expect(bulk.sqlBatches).toEqual([
      'SET IDENTITY_INSERT dbo.Items ON;',
      'SET IDENTITY_INSERT dbo.Items OFF;',
    ]);
  });

  it('can disable bulk INSERT recognition explicitly', async () => {
    const bulk = createBulkRestoreConnection([]);
    const batch = 'INSERT INTO dbo.Items (id) VALUES (1);';

    await restoreSqlDump({
      connection: bulk.connection,
      source: `${batch}\nGO\n`,
      options: { bulkInsertMode: 'off' },
    });

    expect(bulk.metadataQueries).toEqual([]);
    expect(bulk.bulkRequests).toEqual([]);
    expect(bulk.sqlBatches).toEqual([batch]);
  });

  it('executes each batch in order against the connection', async () => {
    const executed: string[] = [];
    const connection = createFakeConnection({ onExecute: sql => executed.push(sql) });

    const result = await restoreSqlDump({
      connection,
      source: 'CREATE TABLE A (Id INT);\nGO\nCREATE TABLE B (Id INT);\nGO\n',
    });

    expect(executed).toEqual(['CREATE TABLE A (Id INT);', 'CREATE TABLE B (Id INT);']);
    expect(result.batchesExecuted).toBe(2);
    expect(result.batchesFailed).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(result.cancelled).toBe(false);
  });

  it('prefers execBatch batch-execution semantics over query() when the adapter provides it', async () => {
    const execBatchCalls: string[] = [];
    let queryCalls = 0;
    const connection: MssqlConnection = {
      async query<Row extends MssqlRow = MssqlRow>(): Promise<MssqlQueryResult<Row>> {
        queryCalls++;
        return { rows: [], columns: [], rowsAffected: 0 };
      },
      async execBatch(sql: string): Promise<MssqlExecBatchResult> {
        execBatchCalls.push(sql);
        return { rowsAffected: 0 };
      },
      stream<Row extends MssqlRow = MssqlRow>(): AsyncIterable<Row> {
        return (async function* () {})();
      },
      async cancel(): Promise<void> {},
    };

    await restoreSqlDump({ connection, source: 'CREATE PROCEDURE dbo.P AS SELECT 1;\nGO\n' });

    expect(execBatchCalls).toEqual(['CREATE PROCEDURE dbo.P AS SELECT 1;']);
    expect(queryCalls).toBe(0);
  });

  it('falls back to query() when the adapter has no execBatch', async () => {
    const executed: string[] = [];
    const connection = createFakeConnection({ onExecute: sql => executed.push(sql) });
    expect(connection.execBatch).toBeUndefined();

    const result = await restoreSqlDump({ connection, source: 'SELECT 1;\nGO\n' });
    expect(executed).toEqual(['SELECT 1;']);
    expect(result.batchesExecuted).toBe(1);
  });

  it('executes a GO <n> batch that many times, in order', async () => {
    const executed: string[] = [];
    const connection = createFakeConnection({ onExecute: sql => executed.push(sql) });

    const result = await restoreSqlDump({ connection, source: 'PRINT 1;\nGO 3\n' });

    expect(executed).toEqual(['PRINT 1;', 'PRINT 1;', 'PRINT 1;']);
    expect(result.batchesExecuted).toBe(3);
  });

  it('sums rowsAffected across all executed batches, including repeated GO <n> executions', async () => {
    const connection = createFakeConnection({
      rowsAffectedFor: sql => (sql.startsWith('INSERT') ? 2 : 0),
    });

    const result = await restoreSqlDump({
      connection,
      source: 'CREATE TABLE T (Id INT);\nGO\nINSERT INTO T VALUES (1), (2);\nGO 3\n',
    });

    expect(result.rowsRestored).toBe(6); // 2 rows * 3 repeats
  });

  it('stops at the first failing batch by default and records a RestoreBatchError', async () => {
    const executed: string[] = [];
    const connection = createFakeConnection({
      onExecute: sql => executed.push(sql),
      failOn: sql => sql.includes('TABLE B '),
    });

    const result = await restoreSqlDump({
      connection,
      source:
        'CREATE TABLE A (Id INT);\nGO\nCREATE TABLE B (Id INT);\nGO\nCREATE TABLE C (Id INT);\nGO\n',
    });

    expect(executed).toEqual(['CREATE TABLE A (Id INT);', 'CREATE TABLE B (Id INT);']);
    expect(result.batchesExecuted).toBe(1);
    expect(result.batchesFailed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      batchIndex: 1,
      location: { startLine: 3, endLine: 3 },
      sqlPreview: 'CREATE TABLE B (Id INT);',
      message: expect.stringContaining('simulated failure'),
    });
  });

  it('never leaks a secret value into a RestoreBatchError preview', async () => {
    const connection = createFakeConnection({
      failOn: sql => sql.includes('CREATE LOGIN'),
    });

    const result = await restoreSqlDump({
      connection,
      source: "CREATE LOGIN foo WITH PASSWORD = 'super-secret-123';\nGO\n",
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.sqlPreview).not.toContain('super-secret-123');
    expect(result.errors[0]!.message).not.toContain('super-secret-123');
  });

  it('continues past failures when stopOnError is false', async () => {
    const connection = createFakeConnection({ failOn: sql => sql.includes('TABLE B ') });

    const result = await restoreSqlDump({
      connection,
      source:
        'CREATE TABLE A (Id INT);\nGO\nCREATE TABLE B (Id INT);\nGO\nCREATE TABLE C (Id INT);\nGO\n',
      options: { stopOnError: false },
    });

    expect(result.batchesExecuted).toBe(2);
    expect(result.batchesFailed).toBe(1);
    expect(result.errors).toHaveLength(1);
  });

  it('reports parsing/executing/finalizing progress with batchIndex and a running rowsRestored total', async () => {
    const connection = createFakeConnection({ rowsAffectedFor: () => 1 });
    const phases: Array<{ phase: string; batchIndex?: number; rowsRestored?: number }> = [];

    await restoreSqlDump({
      connection,
      source: 'CREATE TABLE A (Id INT);\nGO\nINSERT INTO A VALUES (1);\nGO\n',
      progress: event =>
        phases.push({
          phase: event.phase,
          batchIndex: event.batchIndex,
          rowsRestored: event.rowsRestored,
        }),
    });

    expect(phases.some(p => p.phase === 'parsing' && p.batchIndex === 0)).toBe(true);
    expect(phases.some(p => p.phase === 'parsing' && p.batchIndex === 1)).toBe(true);
    expect(phases.some(p => p.phase === 'executing' && p.rowsRestored === 1)).toBe(true);
    expect(phases.some(p => p.phase === 'finalizing')).toBe(true);
  });

  it('returns cancelled: true and releases the connection when the signal is already aborted', async () => {
    let released = false;
    const connection = createFakeConnection({});
    const controller = new AbortController();
    controller.abort();

    const result = await restoreSqlDump({
      connection: {
        acquire: async () => ({
          connection,
          release: async () => {
            released = true;
          },
        }),
      },
      source: 'SELECT 1;\nGO\nSELECT 2;\nGO\n',
      signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
    expect(released).toBe(true);
  });

  it('stops mid-stream and reports cancelled: true once the signal is aborted after the first batch', async () => {
    const controller = new AbortController();
    const connection = createFakeConnection({
      onExecute: () => controller.abort(),
    });

    const result = await restoreSqlDump({
      connection,
      source: 'SELECT 1;\nGO\nSELECT 2;\nGO\n',
      signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
    expect(result.batchesExecuted).toBe(1);
  });

  it('propagates a parse error (malformed dump) instead of swallowing it into result.errors', async () => {
    const connection = createFakeConnection({});

    await expect(
      restoreSqlDump({ connection, source: "SELECT 'unterminated;\nGO\n" }),
    ).rejects.toBeInstanceOf(MalformedSqlDumpError);
  });

  it('propagates an unsupported sqlcmd directive error and never executes any batch', async () => {
    const executed: string[] = [];
    const connection = createFakeConnection({ onExecute: sql => executed.push(sql) });

    await expect(
      restoreSqlDump({ connection, source: ':setvar DbName MyDb\nSELECT 1;\nGO\n' }),
    ).rejects.toBeInstanceOf(UnsupportedSqlcmdDirectiveError);
    expect(executed).toHaveLength(0);
  });

  it('releases an acquired connection even when a parse error propagates', async () => {
    let released = false;
    const connection = createFakeConnection({});

    await expect(
      restoreSqlDump({
        connection: {
          acquire: async () => ({
            connection,
            release: async () => {
              released = true;
            },
          }),
        },
        source: '/* unterminated\nSELECT 1;\n',
      }),
    ).rejects.toThrow();
    expect(released).toBe(true);
  });

  it('accepts a Readable stream as the source', async () => {
    const { Readable } = await import('node:stream');
    const executed: string[] = [];
    const connection = createFakeConnection({ onExecute: sql => executed.push(sql) });

    const result = await restoreSqlDump({
      connection,
      source: Readable.from(['CREATE TABLE A', ' (Id INT);\nGO\n']),
    });

    expect(executed).toEqual(['CREATE TABLE A (Id INT);']);
    expect(result.batchesExecuted).toBe(1);
  });
});

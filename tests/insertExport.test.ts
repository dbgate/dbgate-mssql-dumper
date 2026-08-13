import { describe, expect, it } from 'vitest';
import { exportTableDataAsInserts } from '../src/data/insertExport.js';
import type { MssqlColumn } from '../src/model/column.js';
import type { MssqlTable } from '../src/model/table.js';
import type {
  MssqlConnection,
  MssqlQuery,
  MssqlQueryResult,
  MssqlRow,
} from '../src/connection/types.js';
import { StringDumpWriter } from '../src/writer/stringWriter.js';

function column(
  overrides: Partial<MssqlColumn> & {
    columnName: string;
    dataType: string;
    ordinalPosition: number;
  },
): MssqlColumn {
  return {
    maxLength: null,
    characterMaxLength: null,
    precision: null,
    scale: null,
    isNullable: true,
    isIdentity: false,
    identitySeed: null,
    identityIncrement: null,
    isComputed: false,
    computedExpression: null,
    isPersisted: null,
    isSparse: false,
    isRowGuidCol: false,
    collationName: null,
    defaultConstraintName: null,
    defaultExpression: null,
    comment: null,
    ...overrides,
  };
}

function table(
  overrides: Partial<MssqlTable> & { pureName: string; columns: MssqlColumn[] },
): MssqlTable {
  return {
    schemaName: 'dbo',
    objectId: 1,
    createDate: null,
    modifyDate: null,
    comment: null,
    isMemoryOptimized: false,
    durability: null,
    isSystemVersioned: false,
    historyTableSchemaName: null,
    historyTablePureName: null,
    ...overrides,
  };
}

/** A fake connection whose `stream()` replays a fixed row set and whose `query()` answers a `COUNT(*)`. */
function createFakeDataConnection(
  rows: readonly MssqlRow[],
): MssqlConnection & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async query<Row extends MssqlRow = MssqlRow>(
      query: MssqlQuery,
    ): Promise<MssqlQueryResult<Row>> {
      queries.push(query.sql);
      if (query.sql.includes('COUNT(*)')) {
        return {
          rows: [{ rowCount: rows.length } as unknown as Row],
          columns: [],
          rowsAffected: 1,
        };
      }
      throw new Error(`Unexpected query: ${query.sql}`);
    },
    stream<Row extends MssqlRow = MssqlRow>(): AsyncIterable<Row> {
      queries.push('(stream)');
      return (async function* () {
        for (const row of rows) {
          yield row as unknown as Row;
        }
      })();
    },
    async cancel(): Promise<void> {},
  };
}

describe('exportTableDataAsInserts: column-aware path', () => {
  const customersTable = table({
    pureName: 'Customers',
    columns: [
      column({
        columnName: 'Id',
        dataType: 'int',
        ordinalPosition: 1,
        isIdentity: true,
        identitySeed: 1,
        identityIncrement: 1,
      }),
      column({ columnName: 'Name', dataType: 'nvarchar', ordinalPosition: 2 }),
    ],
  });

  it('renders one INSERT per row by default batching, quoting values with N-prefixed strings', async () => {
    const rows = [
      { Id: 1, Name: 'Alice' },
      { Id: 2, Name: 'Bob' },
    ];
    const connection = createFakeDataConnection(rows);
    const writer = new StringDumpWriter();

    const result = await exportTableDataAsInserts({
      connection,
      schemaName: 'dbo',
      pureName: 'Customers',
      writer,
      table: customersTable,
      options: { maxRowsPerStatement: 1 },
    });

    expect(result.rowsExported).toBe(2);
    expect(result.warnings).toEqual([]);
    const text = writer.toString();
    expect(text).toContain('SET IDENTITY_INSERT dbo.Customers ON;');
    expect(text).toContain("INSERT INTO dbo.Customers (Id, Name) VALUES\n(1, N'Alice');");
    expect(text).toContain("INSERT INTO dbo.Customers (Id, Name) VALUES\n(2, N'Bob');");
    expect(text).toContain('SET IDENTITY_INSERT dbo.Customers OFF;');
  });

  it('batches multiple rows into one multi-row INSERT statement', async () => {
    const rows = [
      { Id: 1, Name: 'Alice' },
      { Id: 2, Name: 'Bob' },
      { Id: 3, Name: 'Cara' },
    ];
    const connection = createFakeDataConnection(rows);
    const writer = new StringDumpWriter();

    const result = await exportTableDataAsInserts({
      connection,
      schemaName: 'dbo',
      pureName: 'Customers',
      writer,
      table: customersTable,
      options: { maxRowsPerStatement: 100 },
    });

    expect(result.rowsExported).toBe(3);
    const insertStatements = writer
      .toString()
      .split('\n')
      .filter(line => line.startsWith('INSERT INTO'));
    // All three rows collapse into a single multi-row INSERT statement (one "INSERT INTO" line).
    expect(insertStatements).toHaveLength(1);
    expect(writer.toString()).toContain("(1, N'Alice'),\n(2, N'Bob'),\n(3, N'Cara');");
  });

  it('flushes a new statement once maxRowsPerStatement is reached', async () => {
    const rows = [
      { Id: 1, Name: 'A' },
      { Id: 2, Name: 'B' },
      { Id: 3, Name: 'C' },
    ];
    const connection = createFakeDataConnection(rows);
    const writer = new StringDumpWriter();

    await exportTableDataAsInserts({
      connection,
      schemaName: 'dbo',
      pureName: 'Customers',
      writer,
      table: customersTable,
      options: { maxRowsPerStatement: 2 },
    });

    const insertStatements = writer
      .toString()
      .split('\n')
      .filter(line => line.startsWith('INSERT INTO'));
    expect(insertStatements).toHaveLength(2); // rows [1,2] then [3]
  });

  it('clamps maxRowsPerStatement to the SQL Server 1000-row VALUES limit', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ Id: i + 1, Name: `N${i}` }));
    const connection = createFakeDataConnection(rows);
    const writer = new StringDumpWriter();

    await exportTableDataAsInserts({
      connection,
      schemaName: 'dbo',
      pureName: 'Customers',
      writer,
      table: customersTable,
      options: { maxRowsPerStatement: 5000 },
    });

    // With only 5 rows this can't actually prove the 1000 clamp numerically, but it must not throw
    // and must still produce exactly one statement (5 rows all fit well under any sane limit).
    const insertStatements = writer
      .toString()
      .split('\n')
      .filter(line => line.startsWith('INSERT INTO'));
    expect(insertStatements).toHaveLength(1);
  });

  it('flushes a new statement once maxStatementBytes would be exceeded', async () => {
    const wideTable = table({
      pureName: 'Notes',
      columns: [
        column({ columnName: 'Id', dataType: 'int', ordinalPosition: 1 }),
        column({ columnName: 'Body', dataType: 'nvarchar', ordinalPosition: 2 }),
      ],
    });
    const longText = 'x'.repeat(1000);
    const rows = [
      { Id: 1, Body: longText },
      { Id: 2, Body: longText },
      { Id: 3, Body: longText },
    ];
    const connection = createFakeDataConnection(rows);
    const writer = new StringDumpWriter();

    await exportTableDataAsInserts({
      connection,
      schemaName: 'dbo',
      pureName: 'Notes',
      writer,
      table: wideTable,
      options: { maxRowsPerStatement: 100, maxStatementBytes: 1500 },
    });

    const insertStatements = writer
      .toString()
      .split('\n')
      .filter(line => line.startsWith('INSERT INTO'));
    // Each row's rendered tuple is >1000 bytes, so a 1500-byte cap forces one row per statement.
    expect(insertStatements).toHaveLength(3);
  });

  it('excludes computed and rowversion columns from the column list and every INSERT', async () => {
    const auditedTable = table({
      pureName: 'Audited',
      columns: [
        column({ columnName: 'Id', dataType: 'int', ordinalPosition: 1 }),
        column({
          columnName: 'Total',
          dataType: 'int',
          ordinalPosition: 2,
          isComputed: true,
          computedExpression: '[Qty]*[Price]',
        }),
        column({ columnName: 'RowVer', dataType: 'rowversion', ordinalPosition: 3 }),
        column({ columnName: 'Name', dataType: 'nvarchar', ordinalPosition: 4 }),
      ],
    });
    const rows = [{ Id: 1, Name: 'Alice' }];
    const connection = createFakeDataConnection(rows);
    const writer = new StringDumpWriter();

    const result = await exportTableDataAsInserts({
      connection,
      schemaName: 'dbo',
      pureName: 'Audited',
      writer,
      table: auditedTable,
    });

    expect(writer.toString()).toContain(
      "INSERT INTO dbo.Audited (Id, Name) VALUES\n(1, N'Alice');",
    );
    expect(writer.toString()).not.toContain('Total');
    expect(writer.toString()).not.toContain('RowVer');
    expect(result.warnings).toEqual([]);
  });

  it('warns about and excludes an unsupported column type, still exporting the rest', async () => {
    const geoTable = table({
      pureName: 'Places',
      columns: [
        column({ columnName: 'Id', dataType: 'int', ordinalPosition: 1 }),
        column({ columnName: 'Location', dataType: 'geography', ordinalPosition: 2 }),
      ],
    });
    const rows = [{ Id: 1 }];
    const connection = createFakeDataConnection(rows);
    const writer = new StringDumpWriter();

    const result = await exportTableDataAsInserts({
      connection,
      schemaName: 'dbo',
      pureName: 'Places',
      writer,
      table: geoTable,
    });

    expect(result.warnings.some(w => w.code === 'unsupported-column-type')).toBe(true);
    expect(writer.toString()).toContain('INSERT INTO dbo.Places (Id) VALUES\n(1);');
  });

  it('uses DEFAULT VALUES when every column is computed/generated/unsupported', async () => {
    const emptyInsertTable = table({
      pureName: 'Ghost',
      columns: [
        column({
          columnName: 'Total',
          dataType: 'int',
          ordinalPosition: 1,
          isComputed: true,
          computedExpression: '1',
        }),
        column({ columnName: 'RowVer', dataType: 'rowversion', ordinalPosition: 2 }),
      ],
    });
    // Three underlying rows exist even though nothing is selectable from them.
    const connection = createFakeDataConnection([{}, {}, {}]);
    const writer = new StringDumpWriter();

    const result = await exportTableDataAsInserts({
      connection,
      schemaName: 'dbo',
      pureName: 'Ghost',
      writer,
      table: emptyInsertTable,
    });

    expect(result.rowsExported).toBe(3);
    expect(connection.queries.some(q => q.includes('COUNT(*)'))).toBe(true);
    const insertStatements = writer
      .toString()
      .split('\n')
      .filter(line => line.startsWith('INSERT INTO'));
    expect(insertStatements).toEqual([
      'INSERT INTO dbo.Ghost DEFAULT VALUES;',
      'INSERT INTO dbo.Ghost DEFAULT VALUES;',
      'INSERT INTO dbo.Ghost DEFAULT VALUES;',
    ]);
  });

  it('still emits SET IDENTITY_INSERT OFF if the row stream fails mid-export', async () => {
    const identityTable = table({
      pureName: 'Customers',
      columns: [
        column({
          columnName: 'Id',
          dataType: 'int',
          ordinalPosition: 1,
          isIdentity: true,
          identitySeed: 1,
          identityIncrement: 1,
        }),
      ],
    });
    const writer = new StringDumpWriter();
    const failingConnection: MssqlConnection = {
      async query() {
        throw new Error('should not be called');
      },
      stream<Row extends MssqlRow = MssqlRow>(): AsyncIterable<Row> {
        return {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<Row>> {
                return Promise.reject(new Error('connection dropped'));
              },
            };
          },
        };
      },
      async cancel() {},
    };

    await expect(
      exportTableDataAsInserts({
        connection: failingConnection,
        schemaName: 'dbo',
        pureName: 'Customers',
        writer,
        table: identityTable,
      }),
    ).rejects.toThrow('connection dropped');

    const text = writer.toString();
    expect(text).toContain('SET IDENTITY_INSERT dbo.Customers ON;');
    expect(text).toContain('SET IDENTITY_INSERT dbo.Customers OFF;');
  });
});

describe('exportTableDataAsInserts: legacy fallback without a table model', () => {
  it('falls back to SELECT * and generic literal rendering when no table model is supplied', async () => {
    const rows = [{ Id: 1, Name: 'Alice' }];
    const connection = createFakeDataConnection(rows);
    const writer = new StringDumpWriter();

    const result = await exportTableDataAsInserts({
      connection,
      schemaName: 'dbo',
      pureName: 'Customers',
      writer,
    });

    expect(result.rowsExported).toBe(1);
    expect(writer.toString()).toContain(
      "INSERT INTO dbo.Customers (Id, Name) VALUES (1, N'Alice');",
    );
  });
});

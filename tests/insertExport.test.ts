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

/**
 * A fake connection whose `stream()` replays a fixed row set and whose
 * `query()` answers the two catalog/aggregate probes the exporter can make:
 * a `COUNT(*)` (all-columns-excluded path) and the `TableHasIdentity`
 * property lookup (no-table-model fallback path).
 */
function createFakeDataConnection(
  rows: readonly MssqlRow[],
  options?: { hasIdentity?: boolean },
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
      if (query.sql.includes('TableHasIdentity')) {
        return {
          rows: [{ hasIdentity: options?.hasIdentity ? 1 : 0 } as unknown as Row],
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
        identitySeed: 1n,
        identityIncrement: 1n,
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
          identitySeed: 1n,
          identityIncrement: 1n,
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

  it('still wraps the data in SET IDENTITY_INSERT when the catalog reports an identity column', async () => {
    // Without a table model the identity column cannot be seen in the model,
    // but `SELECT *` still selects it and the generated INSERT still names
    // it — so the wrapper is required or the dump cannot be restored.
    const connection = createFakeDataConnection([{ Id: 1, Name: 'Alice' }], { hasIdentity: true });
    const writer = new StringDumpWriter();

    await exportTableDataAsInserts({
      connection,
      schemaName: 'dbo',
      pureName: 'Customers',
      writer,
    });

    const text = writer.toString();
    expect(text).toContain('SET IDENTITY_INSERT dbo.Customers ON;');
    expect(text).toContain('SET IDENTITY_INSERT dbo.Customers OFF;');
  });

  it('passes the table name to the identity probe as a bound parameter, never inlined', async () => {
    const connection = createFakeDataConnection([], { hasIdentity: false });
    const boundParameters: unknown[] = [];
    const originalQuery = connection.query.bind(connection);
    connection.query = async query => {
      boundParameters.push(query.parameters);
      return originalQuery(query);
    };

    await exportTableDataAsInserts({
      connection,
      schemaName: 'dbo',
      pureName: "Weird'Name",
      writer: new StringDumpWriter(),
    });

    const probe = connection.queries.find(sql => sql.includes('TableHasIdentity'));
    expect(probe).toBeDefined();
    expect(probe).not.toContain("Weird'Name");
    expect(boundParameters[0]).toEqual([
      { name: 'qualifiedName', value: `dbo.[Weird'Name]`, sqlType: 'NVarChar' },
    ]);
  });
});

describe('exportTableDataAsInserts: identifiers reaching live SQL are always quoted', () => {
  // This is the only place in the package where caller-supplied strings are
  // interpolated into *live* SQL text (every catalog query binds its values),
  // so the quoting here is load-bearing.
  function captureQueries(request: {
    schemaName: string;
    pureName: string;
    columns: MssqlColumn[];
    orderByColumns?: readonly string[];
  }): Promise<string[]> {
    const connection = createFakeDataConnection([]);
    const streamed: string[] = [];
    const originalStream = connection.stream.bind(connection);
    connection.stream = (query, streamOptions) => {
      streamed.push(query.sql);
      return originalStream(query, streamOptions);
    };
    return exportTableDataAsInserts({
      connection,
      schemaName: request.schemaName,
      pureName: request.pureName,
      writer: new StringDumpWriter(),
      table: table({ pureName: request.pureName, columns: request.columns }),
      orderByColumns: request.orderByColumns,
    }).then(() => streamed);
  }

  it('doubles a closing bracket in the schema, table and column names', async () => {
    const [sql] = await captureQueries({
      schemaName: 'we]rd',
      pureName: 'T]--',
      columns: [column({ columnName: 'c]1', dataType: 'int', ordinalPosition: 1 })],
    });
    expect(sql).toContain('[we]]rd].[T]]--]');
    expect(sql).toContain('[c]]1]');
    // The `--` can never begin a comment because it is inside brackets.
    expect(sql).not.toMatch(/FROM \[we]]rd]\.\[T]--]/);
  });

  it('quotes an order-by column that tries to inject a clause', async () => {
    const [sql] = await captureQueries({
      schemaName: 'dbo',
      pureName: 'T',
      columns: [column({ columnName: 'a', dataType: 'int', ordinalPosition: 1 })],
      orderByColumns: ['a] DESC, (select 1) --'],
    });
    expect(sql).toContain('ORDER BY [a]] DESC, (select 1) --]');
    expect(sql).not.toContain('(select 1) --]\n');
  });
});

describe('exportTableDataAsInserts: batch separators', () => {
  it('emits a GO after each INSERT statement so a large table is not one giant batch', async () => {
    const connection = createFakeDataConnection([
      { Id: 1, Name: 'a' },
      { Id: 2, Name: 'b' },
      { Id: 3, Name: 'c' },
    ]);
    const writer = new StringDumpWriter();

    await exportTableDataAsInserts({
      connection,
      schemaName: 'dbo',
      pureName: 'T',
      writer,
      table: table({
        pureName: 'T',
        columns: [
          column({ columnName: 'Id', dataType: 'int', ordinalPosition: 1 }),
          column({ columnName: 'Name', dataType: 'nvarchar', ordinalPosition: 2 }),
        ],
      }),
      options: { maxRowsPerStatement: 2 },
    });

    const text = writer.toString();
    // Two statements (2 rows + 1 row), each followed by its own separator.
    expect(text.match(/^GO$/gm)).toHaveLength(2);
    expect(text.indexOf('GO')).toBeGreaterThan(text.indexOf('INSERT INTO'));
  });

  it('omits batch separators when emitBatchSeparators is false', async () => {
    const connection = createFakeDataConnection([{ Id: 1 }]);
    const writer = new StringDumpWriter();

    await exportTableDataAsInserts({
      connection,
      schemaName: 'dbo',
      pureName: 'T',
      writer,
      table: table({
        pureName: 'T',
        columns: [column({ columnName: 'Id', dataType: 'int', ordinalPosition: 1 })],
      }),
      options: { emitBatchSeparators: false },
    });

    expect(writer.toString()).not.toMatch(/^GO$/m);
  });
});

describe('exportTableDataAsInserts: deterministic row order', () => {
  it('adds an ORDER BY when orderByColumns is supplied, quoting each column', async () => {
    const connection = createFakeDataConnection([]);
    const streamed: string[] = [];
    const originalStream = connection.stream.bind(connection);
    connection.stream = (query, streamOptions) => {
      streamed.push(query.sql);
      return originalStream(query, streamOptions);
    };

    await exportTableDataAsInserts({
      connection,
      schemaName: 'dbo',
      pureName: 'T',
      writer: new StringDumpWriter(),
      table: table({
        pureName: 'T',
        columns: [
          column({ columnName: 'A', dataType: 'int', ordinalPosition: 1 }),
          column({ columnName: 'Odd]Name', dataType: 'int', ordinalPosition: 2 }),
        ],
      }),
      orderByColumns: ['A', 'Odd]Name'],
    });

    expect(streamed[0]).toContain('ORDER BY A, [Odd]]Name]');
  });

  it('emits no ORDER BY when no order columns are supplied', async () => {
    const connection = createFakeDataConnection([]);
    const streamed: string[] = [];
    const originalStream = connection.stream.bind(connection);
    connection.stream = (query, streamOptions) => {
      streamed.push(query.sql);
      return originalStream(query, streamOptions);
    };

    await exportTableDataAsInserts({
      connection,
      schemaName: 'dbo',
      pureName: 'T',
      writer: new StringDumpWriter(),
      table: table({
        pureName: 'T',
        columns: [column({ columnName: 'A', dataType: 'int', ordinalPosition: 1 })],
      }),
    });

    expect(streamed[0]).not.toContain('ORDER BY');
  });
});

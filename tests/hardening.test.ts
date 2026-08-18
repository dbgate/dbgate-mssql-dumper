/**
 * Regression tests for defects found in the pre-v1 correctness/security
 * audit (see the "Audit findings" section of `docs/known-limitations.md`).
 *
 * These live together rather than being scattered across the topical suites
 * because each one pins a *specific, previously-broken* behaviour, and the
 * value of the test is the failure it prevents, not the module it touches.
 * Each block names the class of defect it guards against.
 */
import { describe, expect, it } from 'vitest';
import { inspectDumpArchive } from '../src/archive/planner.js';
import { beginMssqlSession } from '../src/connection/session.js';
import type { MssqlConnection, MssqlQuery, MssqlRow } from '../src/connection/types.js';
import { renderColumnValue } from '../src/data/columnValueRenderer.js';
import type { MssqlColumn } from '../src/model/column.js';
import { formatColumnDataType } from '../src/renderer/formatType.js';
import { renderPlainSql } from '../src/renderer/plainSql.js';
import {
  renderCheckConstraintCreate,
  renderForeignKeyCreate,
  renderIndexCreate,
  renderSchemaCreate,
  renderTriggerCreate,
  renderViewCreate,
} from '../src/renderer/objectRenderers.js';
import { resolvePlainSqlRenderOptions } from '../src/renderer/types.js';
import { safeSqlPreview } from '../src/restore/batches.js';
import { SqlBatchParser, parseSqlBatches } from '../src/restore/batchParser.js';
import { BatchTooLargeError } from '../src/restore/errors.js';
import { formatApproximateNumber } from '../src/security/literals.js';
import { StringDumpWriter } from '../src/writer/stringWriter.js';
import { buildEmptyDatabase } from './fixtures.js';

function column(
  overrides: Partial<MssqlColumn> & { columnName: string; dataType: string },
): MssqlColumn {
  return {
    ordinalPosition: 1,
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

describe('unbounded memory: a terminator-free script cannot grow without limit', () => {
  it('throws BatchTooLargeError from push() for input containing no line break at all', () => {
    // Previously the size check lived only on the completed-line path, so a
    // script written entirely on one physical line accumulated forever.
    const parser = new SqlBatchParser({ maxBatchBytes: 1_000 });
    expect(() => {
      for (let i = 0; i < 200; i++) {
        parser.push('x'.repeat(100));
      }
    }).toThrow(BatchTooLargeError);
  });

  it('counts the incomplete trailing line together with the already-accumulated batch', () => {
    const parser = new SqlBatchParser({ maxBatchBytes: 60 });
    parser.push('SELECT 1;\n'); // 10 bytes accumulated into the batch
    expect(() => parser.push('y'.repeat(100))).toThrow(BatchTooLargeError);
  });
});

describe('Unicode corruption: line-ending handling must not rewrite string data', () => {
  it('preserves a CRLF that is data inside a string literal', () => {
    const sql = "INSERT INTO T VALUES (N'line one\r\nline two');";
    const batches = parseSqlBatches(`${sql}\nGO\n`);
    expect(batches[0]!.sql).toBe(sql);
  });

  it('preserves a lone CR inside a string literal', () => {
    const sql = "INSERT INTO T VALUES (N'a\rb');";
    const batches = parseSqlBatches(`${sql}\nGO\n`);
    expect(batches[0]!.sql).toBe(sql);
  });

  it('preserves original terminators across a chunk boundary that splits a CRLF pair', () => {
    const parser = new SqlBatchParser();
    const batches = [
      ...parser.push("INSERT INTO T VALUES (N'a\r"),
      ...parser.push("\nb');\nGO\n"),
      ...parser.finish(),
    ];
    expect(batches[0]!.sql).toBe("INSERT INTO T VALUES (N'a\r\nb');");
  });

  it('never leaves an unpaired surrogate when truncating a preview mid-emoji', () => {
    // 199 ASCII characters, then an astral-plane emoji straddling the cut.
    const preview = safeSqlPreview(`${'x'.repeat(199)}😀tail`, 200);
    for (let i = 0; i < preview.length; i++) {
      const unit = preview.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        // A high surrogate must be followed by a low surrogate.
        const next = preview.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
      }
    }
    expect(preview).toBe(`${'x'.repeat(199)}…`);
  });
});

describe('SQL injection: no caller-supplied string reaches SQL text unvalidated', () => {
  function idleConnection(): MssqlConnection & { queries: string[] } {
    const queries: string[] = [];
    return {
      queries,
      async query<Row extends MssqlRow = MssqlRow>(query: MssqlQuery) {
        queries.push(query.sql);
        return { rows: [] as readonly Row[], columns: [], rowsAffected: 0 };
      },
      stream<Row extends MssqlRow = MssqlRow>(): AsyncIterable<Row> {
        return (async function* () {})();
      },
      async cancel() {},
      async getTransactionStatus() {
        return 'idle' as const;
      },
    };
  }

  it('rejects an isolation level outside the closed allow-list instead of interpolating it', async () => {
    const connection = idleConnection();
    await expect(
      beginMssqlSession(connection, {
        transactionMode: 'managed',
        // A plain-JS caller (or a value from a config file) is not bound by
        // the MssqlIsolationLevel union at all.
        isolationLevel: 'READ COMMITTED; DROP TABLE dbo.Users; --' as never,
      }),
    ).rejects.toThrow(/Unsupported transaction isolation level/);
    expect(connection.queries.some(sql => sql.includes('DROP TABLE'))).toBe(false);
  });

  it('still accepts every documented isolation level', async () => {
    for (const level of [
      'READ UNCOMMITTED',
      'READ COMMITTED',
      'REPEATABLE READ',
      'SNAPSHOT',
      'SERIALIZABLE',
    ] as const) {
      const connection = idleConnection();
      await beginMssqlSession(connection, { transactionMode: 'managed', isolationLevel: level });
      expect(connection.queries).toContain(`SET TRANSACTION ISOLATION LEVEL ${level};`);
    }
  });
});

describe('identifier escaping: a schema name nested inside EXEC() needs both layers', () => {
  const options = resolvePlainSqlRenderOptions(undefined);

  it("doubles a quote in the schema name inside the EXEC('...') argument", () => {
    const sql = renderSchemaCreate("O'Brien", options);
    // The EXEC argument is a string literal, so the identifier's own quote
    // must be doubled there too; bracket quoting alone only escapes `]`.
    expect(sql).toContain("EXEC(N'CREATE SCHEMA [O''Brien]')");
  });

  it('cannot be made to close the EXEC argument early and append a statement', () => {
    const sql = renderSchemaCreate("x');DROP TABLE dbo.Users;--", options);
    // The hostile text may appear — escaped, as inert data. What must never
    // appear is the *unescaped* single quote that would end the EXEC string
    // and turn the rest into peer statements.
    expect(sql).not.toContain("[x');DROP");
    expect(sql).toContain("[x'');DROP");
  });

  it('still doubles a `]` in the bracket-quoted identifier', () => {
    expect(renderSchemaCreate('we]rd', options)).toContain('[we]]rd]');
  });
});

describe('identifier escaping: user-defined type names are identifiers, not keywords', () => {
  it('preserves the original case of a user-defined alias type', () => {
    // Lowercasing it (right for a built-in keyword) would fail to resolve
    // under a case-sensitive collation. Quoting is applied only when the name
    // needs it, exactly as `quoteIdentifier` does everywhere else.
    expect(formatColumnDataType(column({ columnName: 'Email', dataType: 'EmailAddress' }))).toBe(
      'EmailAddress',
    );
  });

  it('quotes a user-defined type name containing a space or a bracket', () => {
    expect(formatColumnDataType(column({ columnName: 'c', dataType: 'My Type' }))).toBe(
      '[My Type]',
    );
    expect(formatColumnDataType(column({ columnName: 'c', dataType: 'We]rd' }))).toBe('[We]]rd]');
  });

  it('still lowercases and leaves built-in types unquoted', () => {
    expect(formatColumnDataType(column({ columnName: 'c', dataType: 'INT' }))).toBe('int');
    expect(
      formatColumnDataType(
        column({ columnName: 'c', dataType: 'NVARCHAR', characterMaxLength: 50 }),
      ),
    ).toBe('nvarchar(50)');
  });
});

describe('precision loss: approximate numerics must keep exponential notation', () => {
  it('renders a float beyond decimal(38) range in exponential form, not 309 plain digits', () => {
    const rendered = renderColumnValue(
      1.7976931348623157e308,
      column({ columnName: 'f', dataType: 'float' }),
    );
    // Expanding this to plain digits would produce a literal SQL Server
    // parses as `decimal` and reject: "out of range for numeric
    // representation (maximum precision 38)".
    expect(rendered).toBe('1.7976931348623157e+308');
    expect(rendered.length).toBeLessThan(40);
  });

  it('renders 1e39 in a form SQL Server accepts for a float column', () => {
    expect(renderColumnValue(1e39, column({ columnName: 'f', dataType: 'real' }))).toBe('1e+39');
  });

  it('formatApproximateNumber round-trips every double exactly', () => {
    for (const value of [0.1, 1 / 3, 1e-320, 5e-324, 1.7976931348623157e308, -2.5e-7]) {
      expect(Number(formatApproximateNumber(value))).toBe(value);
    }
  });

  it('keeps a bigint column exact by passing the driver-supplied string through unquoted', () => {
    // Tedious returns every `bigint` column as a decimal string; without
    // explicit handling it fell through to the generic renderer and came out
    // as a quoted N'...' string.
    const col = column({ columnName: 'big', dataType: 'bigint' });
    expect(renderColumnValue('9223372036854775807', col)).toBe('9223372036854775807');
    expect(renderColumnValue('-9223372036854775808', col)).toBe('-9223372036854775808');
  });
});

describe('nondeterministic ordering: index names are unique per table, not per schema', () => {
  function databaseWithDuplicateIndexNames() {
    const idColumn = {
      columnName: 'CustomerId',
      ordinalPosition: 1,
      dataType: 'int',
      maxLength: null,
      characterMaxLength: null,
      precision: null,
      scale: null,
      isNullable: false,
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
    } satisfies MssqlColumn;

    const table = (pureName: string) => ({
      schemaName: 'dbo',
      pureName,
      objectId: pureName.length,
      createDate: null,
      modifyDate: null,
      comment: null,
      isMemoryOptimized: false,
      durability: null,
      isSystemVersioned: false,
      historyTableSchemaName: null,
      historyTablePureName: null,
      columns: [idColumn],
    });

    const index = (pureName: string) => ({
      indexName: 'IX_CustomerId',
      schemaName: 'dbo',
      pureName,
      indexType: 'NONCLUSTERED' as const,
      isUnique: false,
      isUniqueConstraint: false,
      isDisabled: false,
      filterDefinition: null,
      columns: [
        { columnName: 'CustomerId', ordinalPosition: 1, isDescending: false, isIncluded: false },
      ],
    });

    return buildEmptyDatabase({
      schemas: [{ schemaName: 'dbo', ownerName: 'dbo' }],
      tables: [table('Orders'), table('Invoices')],
      indexes: [index('Orders'), index('Invoices')],
    });
  }

  it('renders each same-named index against its own table instead of one twice', async () => {
    const database = databaseWithDuplicateIndexNames();
    const archive = inspectDumpArchive(database, { mode: 'schema-only' });
    const writer = new StringDumpWriter();

    await renderPlainSql({ database, archive, writer });
    const text = writer.toString();

    expect(text).toContain('CREATE NONCLUSTERED INDEX IX_CustomerId ON dbo.Orders');
    expect(text).toContain('CREATE NONCLUSTERED INDEX IX_CustomerId ON dbo.Invoices');
    // Exactly two CREATE INDEX statements, not the same one emitted twice.
    expect(text.match(/CREATE NONCLUSTERED INDEX IX_CustomerId/g)).toHaveLength(2);
  });
});

describe('line endings: CRLF output must not become CR CR LF', () => {
  it('does not double the CR of an already-CRLF module definition', async () => {
    const database = buildEmptyDatabase({
      schemas: [{ schemaName: 'dbo', ownerName: 'dbo' }],
      views: [
        {
          schemaName: 'dbo',
          pureName: 'V',
          objectId: 1,
          // As stored by SSMS and every Windows SQL Server client.
          definition: 'CREATE VIEW [dbo].[V] AS\r\nSELECT 1 AS X',
          isSchemaBound: false,
          usesAnsiNulls: true,
          usesQuotedIdentifier: true,
          isEncrypted: false,
          comment: null,
        },
      ],
    });
    const archive = inspectDumpArchive(database, { mode: 'schema-only' });
    const writer = new StringDumpWriter();

    await renderPlainSql({ database, archive, writer, options: { lineEnding: '\r\n' } });
    const text = writer.toString();

    expect(text).not.toContain('\r\r\n');
    expect(text).toContain('CREATE VIEW [dbo].[V] AS\r\nSELECT 1 AS X');
  });
});

describe('module definitions must be restorable into an empty database', () => {
  const options = resolvePlainSqlRenderOptions(undefined);

  function view(definition: string): Parameters<typeof renderViewCreate>[0] {
    return {
      schemaName: 'dbo',
      pureName: 'V',
      objectId: 1,
      definition,
      isSchemaBound: false,
      usesAnsiNulls: true,
      usesQuotedIdentifier: true,
      isEncrypted: false,
      comment: null,
    };
  }

  it('rewrites a leading ALTER to CREATE', () => {
    // `sys.sql_modules.definition` holds the text of the LAST statement that
    // defined the module, so anything modified after creation is stored as
    // `ALTER`. Emitted verbatim it fails on an empty target with "Could not
    // find object", and stopOnError then skips the entire rest of the dump.
    const sql = renderViewCreate(view('ALTER VIEW [dbo].[V] AS SELECT 1 AS x'), options);
    expect(sql).toContain('CREATE VIEW [dbo].[V]');
    expect(sql).not.toContain('ALTER VIEW');
  });

  it('rewrites ALTER for every module keyword form', () => {
    for (const keyword of ['PROC', 'PROCEDURE', 'VIEW', 'FUNCTION', 'TRIGGER']) {
      const sql = renderViewCreate(view(`ALTER ${keyword} [dbo].[V] AS SELECT 1`), options);
      expect(sql).toContain(`CREATE ${keyword} [dbo].[V]`);
    }
  });

  it('rewrites ALTER even behind leading comments and whitespace', () => {
    const sql = renderViewCreate(
      view('-- header comment\n/* block */\n  ALTER VIEW [dbo].[V] AS SELECT 1'),
      options,
    );
    expect(sql).toContain('CREATE VIEW [dbo].[V]');
    expect(sql).not.toMatch(/ALTER\s+VIEW/);
    // The comments are preserved, not stripped.
    expect(sql).toContain('-- header comment');
  });

  it('leaves CREATE OR ALTER alone, since it already restores either way', () => {
    const sql = renderViewCreate(view('CREATE OR ALTER VIEW [dbo].[V] AS SELECT 1'), options);
    expect(sql).toContain('CREATE OR ALTER VIEW [dbo].[V]');
  });

  it('does not touch an ALTER appearing later in the body', () => {
    const sql = renderViewCreate(
      view("CREATE VIEW [dbo].[V] AS SELECT 'ALTER TABLE x' AS note"),
      options,
    );
    expect(sql).toContain("'ALTER TABLE x'");
  });
});

describe('disabled constraints and indexes must not be restored enabled', () => {
  const options = resolvePlainSqlRenderOptions(undefined);

  it('emits DISABLE TRIGGER, in its own batch, for a disabled trigger', () => {
    const sql = renderTriggerCreate(
      {
        triggerName: 'TR_Audit',
        objectId: 1,
        schemaName: 'dbo',
        parentName: 'Orders',
        definition: 'create trigger [dbo].[TR_Audit] on [dbo].[Orders] after insert as select 1',
        isDisabled: true,
        isInsteadOf: false,
        events: ['INSERT'],
        usesAnsiNulls: true,
        usesQuotedIdentifier: true,
        isEncrypted: false,
      },
      options,
    );
    // CREATE TRIGGER must be alone in its batch, so the disable needs its own.
    expect(sql).toMatch(/\nGO\nDISABLE TRIGGER TR_Audit ON dbo\.Orders;$/);
  });

  it('emits no DISABLE TRIGGER for an enabled trigger', () => {
    const sql = renderTriggerCreate(
      {
        triggerName: 'TR_Audit',
        objectId: 1,
        schemaName: 'dbo',
        parentName: 'Orders',
        definition: 'create trigger [dbo].[TR_Audit] on [dbo].[Orders] after insert as select 1',
        isDisabled: false,
        isInsteadOf: false,
        events: ['INSERT'],
        usesAnsiNulls: true,
        usesQuotedIdentifier: true,
        isEncrypted: false,
      },
      options,
    );
    expect(sql).not.toContain('DISABLE TRIGGER');
  });

  it('emits NOCHECK CONSTRAINT for a disabled check constraint', () => {
    // `WITH NOCHECK` on the ADD only makes it *untrusted* — it is still
    // enforced for new DML. Without the explicit disable, the restored database
    // enforces a rule the source deliberately did not, so writes that succeed
    // against the source fail against the copy.
    const sql = renderCheckConstraintCreate(
      {
        constraintName: 'CK_T',
        schemaName: 'dbo',
        pureName: 'T',
        definition: '([V]>(0))',
        isNotTrusted: true,
        isDisabled: true,
      },
      options,
    );
    expect(sql).toContain('WITH NOCHECK ADD CONSTRAINT CK_T');
    expect(sql).toContain('ALTER TABLE dbo.T NOCHECK CONSTRAINT CK_T;');
  });

  it('emits NOCHECK CONSTRAINT for a disabled foreign key', () => {
    const sql = renderForeignKeyCreate(
      {
        constraintName: 'FK_T',
        schemaName: 'dbo',
        pureName: 'C',
        refSchemaName: 'dbo',
        refTableName: 'P',
        updateAction: 'NO ACTION',
        deleteAction: 'NO ACTION',
        isNotTrusted: true,
        isDisabled: true,
        columns: [{ columnName: 'PId', refColumnName: 'Id', ordinalPosition: 1 }],
      },
      options,
    );
    expect(sql).toContain('ALTER TABLE dbo.C NOCHECK CONSTRAINT FK_T;');
  });

  it('emits ALTER INDEX ... DISABLE for a disabled index', () => {
    // A disabled index keeps its definition but is not maintained and cannot be
    // used by the optimizer; recreating it enabled changes write cost and plan
    // choice on the target.
    const sql = renderIndexCreate(
      {
        indexName: 'IX_D',
        schemaName: 'dbo',
        pureName: 'T',
        indexType: 'NONCLUSTERED',
        isUnique: false,
        isUniqueConstraint: false,
        isDisabled: true,
        filterDefinition: null,
        columns: [{ columnName: 'V', ordinalPosition: 1, isDescending: false, isIncluded: false }],
      },
      options,
    );
    expect(sql).toContain('CREATE NONCLUSTERED INDEX IX_D ON dbo.T (V ASC);');
    expect(sql).toContain('ALTER INDEX IX_D ON dbo.T DISABLE;');
  });

  it('emits no disable statement for enabled constraints and indexes', () => {
    const check = renderCheckConstraintCreate(
      {
        constraintName: 'CK_T',
        schemaName: 'dbo',
        pureName: 'T',
        definition: '([V]>(0))',
        isNotTrusted: false,
        isDisabled: false,
      },
      options,
    );
    expect(check).not.toContain('NOCHECK');

    const index = renderIndexCreate(
      {
        indexName: 'IX_E',
        schemaName: 'dbo',
        pureName: 'T',
        indexType: 'NONCLUSTERED',
        isUnique: false,
        isUniqueConstraint: false,
        isDisabled: false,
        filterDefinition: null,
        columns: [{ columnName: 'V', ordinalPosition: 1, isDescending: false, isIncluded: false }],
      },
      options,
    );
    expect(index).not.toContain('DISABLE');
  });
});

describe('session SET options must not leak past a module', () => {
  function databaseWithModuleFlags(usesAnsiNulls: boolean, usesQuotedIdentifier: boolean) {
    return buildEmptyDatabase({
      schemas: [{ schemaName: 'dbo', ownerName: 'dbo' }],
      views: [
        {
          schemaName: 'dbo',
          pureName: 'V',
          objectId: 1,
          definition: 'create view [dbo].[V] as select 1 as x',
          isSchemaBound: false,
          usesAnsiNulls,
          usesQuotedIdentifier,
          isEncrypted: false,
          comment: null,
        },
      ],
    });
  }

  async function render(database: ReturnType<typeof buildEmptyDatabase>): Promise<string> {
    const archive = inspectDumpArchive(database, { mode: 'schema-only' });
    const writer = new StringDumpWriter();
    await renderPlainSql({ database, archive, writer });
    return writer.toString();
  }

  it('resets ANSI_NULLS and QUOTED_IDENTIFIER to ON after a module that needed them OFF', async () => {
    // SET options are session-scoped, so leaving them OFF breaks every
    // following filtered index / indexed view / computed-column index
    // ("CREATE INDEX failed because the following SET options have incorrect
    // settings") and silently changes NULL semantics for the caller afterwards.
    const text = await render(databaseWithModuleFlags(false, false));

    const ansiOff = text.indexOf('SET ANSI_NULLS OFF;');
    const quotedOff = text.indexOf('SET QUOTED_IDENTIFIER OFF;');
    const definition = text.indexOf('create view [dbo].[V]');
    const ansiOn = text.indexOf('SET ANSI_NULLS ON;');
    const quotedOn = text.indexOf('SET QUOTED_IDENTIFIER ON;');

    expect(ansiOff).toBeGreaterThan(-1);
    expect(quotedOff).toBeGreaterThan(-1);
    // The resets come after the definition, not before it.
    expect(ansiOn).toBeGreaterThan(definition);
    expect(quotedOn).toBeGreaterThan(definition);
    expect(definition).toBeGreaterThan(ansiOff);
    expect(definition).toBeGreaterThan(quotedOff);
  });

  it('resets only the option that was actually turned off', async () => {
    const text = await render(databaseWithModuleFlags(false, true));
    const definition = text.indexOf('create view [dbo].[V]');

    expect(text.indexOf('SET ANSI_NULLS ON;')).toBeGreaterThan(definition);
    // QUOTED_IDENTIFIER was already ON for this module; no reset is needed.
    expect(text.indexOf('SET QUOTED_IDENTIFIER ON;')).toBeLessThan(definition);
  });

  it('emits no reset at all for the common all-ON case', async () => {
    const text = await render(databaseWithModuleFlags(true, true));
    const definition = text.indexOf('create view [dbo].[V]');

    // Both preamble lines precede the definition and nothing follows it.
    expect(text.indexOf('SET ANSI_NULLS ON;')).toBeLessThan(definition);
    expect(text.indexOf('SET QUOTED_IDENTIFIER ON;')).toBeLessThan(definition);
    expect(text.slice(definition)).not.toContain('SET ANSI_NULLS');
    expect(text.slice(definition)).not.toContain('SET QUOTED_IDENTIFIER');
  });

  it('keeps each reset in its own batch', async () => {
    const text = await render(databaseWithModuleFlags(false, false));
    // Every SET must be separated by GO from the module creation, which has to
    // be alone in its batch.
    expect(text).toMatch(/create view \[dbo]\.\[V] as select 1 as x\nGO\nSET ANSI_NULLS ON;\nGO\n/);
  });
});

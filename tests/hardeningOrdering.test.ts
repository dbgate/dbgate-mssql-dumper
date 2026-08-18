/**
 * Second half of the pre-v1 audit regression suite (see `tests/hardening.test.ts`
 * for the first). These cover archive ordering, restore session hygiene, batch
 * location reporting, and selection diagnostics.
 */
import { describe, expect, it } from 'vitest';
import { inspectDumpArchive } from '../src/archive/planner.js';
import type { MssqlConnection, MssqlQuery, MssqlRow } from '../src/connection/types.js';
import type { MssqlColumn } from '../src/model/column.js';
import type { MssqlTable } from '../src/model/table.js';
import { parseSqlBatches } from '../src/restore/batchParser.js';
import { restoreSqlDump } from '../src/restore/restoreSqlDump.js';
import { buildEmptyDatabase } from './fixtures.js';

function column(columnName: string): MssqlColumn {
  return {
    columnName,
    ordinalPosition: 1,
    dataType: 'int',
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
  };
}

function table(pureName: string, objectId: number): MssqlTable {
  return {
    schemaName: 'dbo',
    pureName,
    objectId,
    createDate: null,
    modifyDate: null,
    comment: null,
    isMemoryOptimized: false,
    durability: null,
    isSystemVersioned: false,
    historyTableSchemaName: null,
    historyTablePureName: null,
    columns: [column('Id')],
  };
}

describe('archive ordering: real edges must not invert load-bearing tie-breaks', () => {
  it('orders a function before a check constraint calling it, even when the function has its own dependency', () => {
    // SQL Server validates a UDF's existence at the moment the CHECK is added
    // (no deferred name resolution), so an inverted order fails the restore
    // outright. This previously relied only on the section tie-break, which any
    // real incoming edge on the function — here a schema-bound reference to a
    // view — overrides, because the function is then not "ready" when post-data
    // begins.
    const database = buildEmptyDatabase({
      schemas: [{ schemaName: 'dbo', ownerName: 'dbo' }],
      tables: [table('T', 1)],
      views: [
        {
          schemaName: 'dbo',
          pureName: 'V',
          objectId: 2,
          definition: 'create view [dbo].[V] as select 1 as x',
          isSchemaBound: true,
          usesAnsiNulls: true,
          usesQuotedIdentifier: true,
          isEncrypted: false,
          comment: null,
        },
      ],
      routines: [
        {
          kind: 'scalar-function',
          schemaName: 'dbo',
          pureName: 'fnOk',
          objectId: 3,
          definition: 'create function [dbo].[fnOk]() returns int as begin return 1 end',
          isSchemaBound: true,
          usesAnsiNulls: true,
          usesQuotedIdentifier: true,
          isEncrypted: false,
          parameters: [],
          comment: null,
        },
      ],
      checkConstraints: [
        {
          constraintName: 'CK_T',
          schemaName: 'dbo',
          pureName: 'T',
          definition: '([dbo].[fnOk]()=(1))',
          isNotTrusted: false,
          isDisabled: false,
        },
      ],
    });

    const archive = inspectDumpArchive(database, {
      mode: 'schema-only',
      dependencies: [
        {
          fromKind: 'scalar-function',
          fromSchemaName: 'dbo',
          fromName: 'fnOk',
          toKind: 'view',
          toSchemaName: 'dbo',
          toName: 'V',
          isSchemaBoundReference: true,
        },
      ],
    });

    const names = archive.entries.map(entry => `${entry.objectType}:${entry.name}`);
    // Assert presence explicitly: a missing entry would make indexOf return -1,
    // which would satisfy a bare `toBeLessThan` for the wrong reason.
    expect(names).toContain('function:fnOk');
    expect(names).toContain('checkConstraint:CK_T');
    expect(names.indexOf('function:fnOk')).toBeLessThan(names.indexOf('checkConstraint:CK_T'));
  });

  it('orders parent table data before child table data in data-only mode', () => {
    // `full` mode is safe by construction (every FK is post-data), but a
    // data-only dump is applied to a target that already has the constraints,
    // so row order must respect them. Alphabetically `Orders` precedes `Users`,
    // so the tie-break alone gets this exactly backwards.
    const database = buildEmptyDatabase({
      schemas: [{ schemaName: 'dbo', ownerName: 'dbo' }],
      tables: [table('Orders', 1), table('Users', 2)],
      foreignKeys: [
        {
          constraintName: 'FK_Orders_Users',
          schemaName: 'dbo',
          pureName: 'Orders',
          refSchemaName: 'dbo',
          refTableName: 'Users',
          updateAction: 'NO ACTION',
          deleteAction: 'NO ACTION',
          isNotTrusted: false,
          isDisabled: false,
          columns: [{ columnName: 'Id', refColumnName: 'Id', ordinalPosition: 1 }],
        },
      ],
    });

    const archive = inspectDumpArchive(database, { mode: 'data-only' });
    const dataNames = archive.entries
      .filter(entry => entry.objectType === 'tableData')
      .map(entry => entry.name);
    expect(dataNames).toEqual(['Users', 'Orders']);
  });

  it('still resolves mutually referencing table data instead of invalidating the archive', () => {
    // The FK-derived data edges are preference-strength precisely so a cycle
    // here is broken rather than reported as unsatisfiable.
    const database = buildEmptyDatabase({
      schemas: [{ schemaName: 'dbo', ownerName: 'dbo' }],
      tables: [table('A', 1), table('B', 2)],
      foreignKeys: [
        {
          constraintName: 'FK_A_B',
          schemaName: 'dbo',
          pureName: 'A',
          refSchemaName: 'dbo',
          refTableName: 'B',
          updateAction: 'NO ACTION',
          deleteAction: 'NO ACTION',
          isNotTrusted: false,
          isDisabled: false,
          columns: [{ columnName: 'Id', refColumnName: 'Id', ordinalPosition: 1 }],
        },
        {
          constraintName: 'FK_B_A',
          schemaName: 'dbo',
          pureName: 'B',
          refSchemaName: 'dbo',
          refTableName: 'A',
          updateAction: 'NO ACTION',
          deleteAction: 'NO ACTION',
          isNotTrusted: false,
          isDisabled: false,
          columns: [{ columnName: 'Id', refColumnName: 'Id', ordinalPosition: 1 }],
        },
      ],
    });

    const archive = inspectDumpArchive(database, { mode: 'data-only' });
    expect(archive.valid).toBe(true);
    expect(archive.droppedPreferenceEdges.length).toBeGreaterThan(0);
  });
});

describe('restore session state must not outlive an early exit', () => {
  function trackingConnection(failOn?: (sql: string) => boolean): {
    connection: MssqlConnection;
    executed: string[];
  } {
    const executed: string[] = [];
    const connection: MssqlConnection = {
      async query<Row extends MssqlRow = MssqlRow>(query: MssqlQuery) {
        executed.push(query.sql);
        if (failOn?.(query.sql)) {
          throw new Error(`simulated failure: ${query.sql}`);
        }
        return { rows: [] as readonly Row[], columns: [], rowsAffected: 0 };
      },
      stream<Row extends MssqlRow = MssqlRow>(): AsyncIterable<Row> {
        return (async function* () {})();
      },
      async cancel() {},
    };
    return { connection, executed };
  }

  it('turns IDENTITY_INSERT back off when stopOnError short-circuits the restore', async () => {
    // The generated script balances ON/OFF, but a restore that stops at a
    // failing batch never reaches the OFF — handing the caller's pooled
    // connection back unable to insert into that table normally, and unable to
    // run another restore ("IDENTITY_INSERT is already ON for table ...").
    const { connection, executed } = trackingConnection(sql => sql.includes('VALUES (2)'));
    const result = await restoreSqlDump({
      connection,
      source: [
        'SET IDENTITY_INSERT dbo.T ON;',
        'INSERT INTO dbo.T (Id) VALUES (1);',
        'GO',
        'INSERT INTO dbo.T (Id) VALUES (2);',
        'GO',
        'SET IDENTITY_INSERT dbo.T OFF;',
        'GO',
        '',
      ].join('\n'),
    });

    expect(result.batchesFailed).toBe(1);
    expect(executed.at(-1)).toBe('SET IDENTITY_INSERT dbo.T OFF;');
  });

  it('restores SET options that the script turned off', async () => {
    const { connection, executed } = trackingConnection(sql => sql.includes('BOOM'));
    await restoreSqlDump({
      connection,
      source: 'SET ANSI_NULLS OFF;\nGO\nSET QUOTED_IDENTIFIER OFF;\nGO\nBOOM;\nGO\n',
    });

    expect(executed).toContain('SET ANSI_NULLS ON;');
    expect(executed).toContain('SET QUOTED_IDENTIFIER ON;');
  });

  it('issues no cleanup when the script left nothing open', async () => {
    const { connection, executed } = trackingConnection();
    await restoreSqlDump({ connection, source: 'SELECT 1;\nGO\n' });
    expect(executed).toEqual(['SELECT 1;']);
  });

  it('does not treat a balanced IDENTITY_INSERT as still open', async () => {
    const { connection, executed } = trackingConnection();
    await restoreSqlDump({
      connection,
      source:
        'SET IDENTITY_INSERT dbo.T ON;\nINSERT INTO dbo.T (Id) VALUES (1);\nSET IDENTITY_INSERT dbo.T OFF;\nGO\n',
    });
    // One batch, no cleanup statement appended.
    expect(executed).toHaveLength(1);
  });
});

describe('batch locations must point at real SQL lines', () => {
  it('does not count the synthetic final line of a newline-terminated file', () => {
    const batches = parseSqlBatches('SELECT 1;\nGO\nSELECT 2;\n');
    expect(batches[1]!.location).toEqual({ startLine: 3, endLine: 3 });
  });

  it('does not count a leading blank line before a batch', () => {
    const batches = parseSqlBatches('SELECT 1;\nGO\n\nSELECT 2;\nGO\n');
    expect(batches[1]!.location).toEqual({ startLine: 4, endLine: 4 });
  });
});

describe('selection must not silently produce an empty dump', () => {
  it('marks a strict-selection archive as carrying no usable order', () => {
    // `valid: false` is documented to mean no order exists, and the cycle path
    // already omits sequenceNumber; the strict path used to keep it.
    const database = buildEmptyDatabase({
      schemas: [{ schemaName: 'dbo', ownerName: 'dbo' }],
      tables: [table('Orders', 1), table('Customers', 2)],
      foreignKeys: [
        {
          constraintName: 'FK_Orders_Customers',
          schemaName: 'dbo',
          pureName: 'Orders',
          refSchemaName: 'dbo',
          refTableName: 'Customers',
          updateAction: 'NO ACTION',
          deleteAction: 'NO ACTION',
          isNotTrusted: false,
          isDisabled: false,
          columns: [{ columnName: 'Id', refColumnName: 'Id', ordinalPosition: 1 }],
        },
      ],
    });

    const archive = inspectDumpArchive(database, {
      mode: 'schema-only',
      selection: {
        tables: new Set(['dbo.Orders']),
        excludeTables: new Set(),
        excludeSchemas: new Set(),
        includeSystemSchemas: false,
      },
      strictSelection: true,
    });

    expect(archive.valid).toBe(false);
    expect(archive.entries.every(entry => entry.sequenceNumber === undefined)).toBe(true);
  });

  it('emits a PRIMARY KEY for a table pulled in only as a foreign-key target', () => {
    // Without it the FK that caused the inclusion cannot be created: "There are
    // no primary or candidate keys in the referenced table ... that match the
    // referencing column list" — an unrestorable dump reported as valid.
    const database = buildEmptyDatabase({
      schemas: [{ schemaName: 'dbo', ownerName: 'dbo' }],
      tables: [table('Orders', 1), table('Customers', 2)],
      primaryKeys: [
        {
          constraintName: 'PK_Customers',
          schemaName: 'dbo',
          pureName: 'Customers',
          isClustered: true,
          columns: [{ columnName: 'Id', ordinalPosition: 1, isDescending: false }],
        },
      ],
      foreignKeys: [
        {
          constraintName: 'FK_Orders_Customers',
          schemaName: 'dbo',
          pureName: 'Orders',
          refSchemaName: 'dbo',
          refTableName: 'Customers',
          updateAction: 'NO ACTION',
          deleteAction: 'NO ACTION',
          isNotTrusted: false,
          isDisabled: false,
          columns: [{ columnName: 'Id', refColumnName: 'Id', ordinalPosition: 1 }],
        },
      ],
    });

    const archive = inspectDumpArchive(database, {
      mode: 'schema-only',
      selection: {
        tables: new Set(['dbo.Orders']),
        excludeTables: new Set(),
        excludeSchemas: new Set(),
        includeSystemSchemas: false,
      },
    });

    const names = archive.entries.map(entry => `${entry.objectType}:${entry.name}`);
    expect(names).toContain('primaryKey:PK_Customers');
    expect(names.indexOf('primaryKey:PK_Customers')).toBeLessThan(
      names.indexOf('foreignKey:FK_Orders_Customers'),
    );
  });

  it('raises the severity when an excluded table is still referenced by a module', () => {
    // CREATE VIEW / CREATE FUNCTION resolve names eagerly, so the referencing
    // object will fail to restore — that is not an `info`-level fact.
    const database = buildEmptyDatabase({
      schemas: [{ schemaName: 'dbo', ownerName: 'dbo' }],
      tables: [table('Orders', 1)],
      views: [
        {
          schemaName: 'dbo',
          pureName: 'vOrders',
          objectId: 2,
          definition: 'create view [dbo].[vOrders] as select [Id] from [dbo].[Orders]',
          isSchemaBound: false,
          usesAnsiNulls: true,
          usesQuotedIdentifier: true,
          isEncrypted: false,
          comment: null,
        },
      ],
    });

    const archive = inspectDumpArchive(database, {
      mode: 'schema-only',
      selection: {
        excludeTables: new Set(['dbo.Orders']),
        excludeSchemas: new Set(),
        includeSystemSchemas: false,
      },
      dependencies: [
        {
          fromKind: 'view',
          fromSchemaName: 'dbo',
          fromName: 'vOrders',
          toKind: 'table',
          toSchemaName: 'dbo',
          toName: 'Orders',
          isSchemaBoundReference: false,
        },
      ],
    });

    const diagnostic = archive.diagnostics.find(d => d.code === 'dependency-excluded-by-selection');
    expect(diagnostic?.severity).toBe('warning');
  });
});

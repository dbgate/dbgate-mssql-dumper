import { describe, expect, it } from 'vitest';
import { loadColumns } from '../src/introspection/catalog/columns.js';
import { loadTables } from '../src/introspection/catalog/tables.js';
import { createScriptedConnection, row } from './mockConnection.js';

describe('loadTables', () => {
  it('maps durability and temporal fields from sys.tables', async () => {
    const connection = createScriptedConnection([
      {
        pattern: 'from sys.tables t',
        rows: [
          row({
            objectId: 1,
            schemaName: 'dbo',
            pureName: 'Customers',
            createDate: new Date('2024-01-01T00:00:00Z'),
            modifyDate: new Date('2024-02-01T00:00:00Z'),
            isMemoryOptimized: false,
            durabilityDesc: null,
            temporalTypeDesc: 'NON_TEMPORAL_TABLE',
            historyTableSchemaName: null,
            historyTablePureName: null,
            comment: 'Customer master table',
          }),
          row({
            objectId: 2,
            schemaName: 'dbo',
            pureName: 'Orders',
            createDate: null,
            modifyDate: null,
            isMemoryOptimized: true,
            durabilityDesc: 'SCHEMA_AND_DATA',
            temporalTypeDesc: 'SYSTEM_VERSIONED_TEMPORAL_TABLE',
            historyTableSchemaName: 'dbo',
            historyTablePureName: 'OrdersHistory',
            comment: null,
          }),
        ],
      },
    ]);

    const tables = await loadTables(connection);

    expect(tables).toHaveLength(2);
    expect(tables[0]).toMatchObject({
      schemaName: 'dbo',
      pureName: 'Customers',
      comment: 'Customer master table',
      isMemoryOptimized: false,
      durability: null,
      isSystemVersioned: false,
    });
    expect(tables[1]).toMatchObject({
      pureName: 'Orders',
      isMemoryOptimized: true,
      durability: 'schema-and-data',
      isSystemVersioned: true,
      historyTableSchemaName: 'dbo',
      historyTablePureName: 'OrdersHistory',
    });
    // Columns are loaded separately; loadTables never populates them itself.
    expect(tables[0]?.columns).toEqual([]);
  });

  it('maps SCHEMA_ONLY durability distinctly from SCHEMA_AND_DATA', async () => {
    const connection = createScriptedConnection([
      {
        pattern: 'from sys.tables t',
        rows: [
          row({
            objectId: 1,
            schemaName: 'dbo',
            pureName: 'Sessions',
            createDate: null,
            modifyDate: null,
            isMemoryOptimized: true,
            durabilityDesc: 'SCHEMA_ONLY',
            temporalTypeDesc: 'NON_TEMPORAL_TABLE',
            historyTableSchemaName: null,
            historyTablePureName: null,
            comment: null,
          }),
        ],
      },
    ]);

    const tables = await loadTables(connection);
    expect(tables[0]?.durability).toBe('schema-only');
  });
});

describe('loadColumns', () => {
  it('returns an empty map without querying when there are no table ids', async () => {
    const connection = createScriptedConnection([]);
    const result = await loadColumns(connection, []);
    expect(result.size).toBe(0);
    expect(connection.calls).toHaveLength(0);
  });

  it('maps identity, computed, and default-constraint metadata, computing characterMaxLength', async () => {
    const connection = createScriptedConnection([
      {
        pattern: 'from sys.columns c',
        rows: [
          row({
            objectId: 1,
            columnId: 1,
            columnName: 'Id',
            dataType: 'int',
            maxLength: 4,
            precision: 10,
            scale: 0,
            isNullable: false,
            collationName: null,
            isRowGuidCol: false,
            isSparse: false,
            isIdentity: true,
            identitySeed: '1',
            identityIncrement: '1',
            computedExpression: null,
            isPersisted: null,
            defaultConstraintName: null,
            defaultExpression: null,
            comment: null,
          }),
          row({
            objectId: 1,
            columnId: 2,
            columnName: 'Name',
            dataType: 'nvarchar',
            maxLength: 100,
            precision: 0,
            scale: 0,
            isNullable: true,
            collationName: 'SQL_Latin1_General_CP1_CI_AS',
            isRowGuidCol: false,
            isSparse: false,
            isIdentity: false,
            identitySeed: null,
            identityIncrement: null,
            computedExpression: null,
            isPersisted: null,
            defaultConstraintName: 'DF_Customers_Name',
            defaultExpression: "('unknown')",
            comment: null,
          }),
          row({
            objectId: 1,
            columnId: 3,
            columnName: 'FullDescription',
            dataType: 'nvarchar',
            maxLength: -1,
            precision: 0,
            scale: 0,
            isNullable: true,
            collationName: null,
            isRowGuidCol: false,
            isSparse: false,
            isIdentity: false,
            identitySeed: null,
            identityIncrement: null,
            computedExpression: "[FirstName]+' '+[LastName]",
            isPersisted: true,
            defaultConstraintName: null,
            defaultExpression: null,
            comment: null,
          }),
        ],
      },
    ]);

    const result = await loadColumns(connection, [1]);
    const columns = result.get(1)!;
    expect(columns).toHaveLength(3);

    expect(columns[0]).toMatchObject({
      columnName: 'Id',
      isIdentity: true,
      // Kept at full bigint precision so a seed beyond 2^53 survives.
      identitySeed: 1n,
      identityIncrement: 1n,
      characterMaxLength: null,
    });
    expect(columns[1]).toMatchObject({
      columnName: 'Name',
      characterMaxLength: 50, // nvarchar(100) is 100 bytes / 2
      defaultConstraintName: 'DF_Customers_Name',
      defaultExpression: "('unknown')",
    });
    expect(columns[2]).toMatchObject({
      columnName: 'FullDescription',
      characterMaxLength: -1, // nvarchar(max)
      isComputed: true,
      isPersisted: true,
    });

    // Scoped by object id, not interpolated: the bound parameter carries the id list.
    expect(connection.calls[0]?.parameters).toEqual([
      { name: 'tableIds', value: '[1]', sqlType: 'NVarChar' },
    ]);
  });

  it('computes characterMaxLength for non-unicode char types without halving', async () => {
    const connection = createScriptedConnection([
      {
        pattern: 'from sys.columns c',
        rows: [
          row({
            objectId: 1,
            columnId: 1,
            columnName: 'Code',
            dataType: 'varchar',
            maxLength: 20,
            precision: 0,
            scale: 0,
            isNullable: false,
            collationName: null,
            isRowGuidCol: false,
            isSparse: false,
            isIdentity: false,
            identitySeed: null,
            identityIncrement: null,
            computedExpression: null,
            isPersisted: null,
            defaultConstraintName: null,
            defaultExpression: null,
            comment: null,
          }),
        ],
      },
    ]);

    const result = await loadColumns(connection, [1]);
    expect(result.get(1)?.[0]?.characterMaxLength).toBe(20);
  });
});

import { describe, expect, it } from 'vitest';
import { introspectMssql } from '../src/introspection/introspect.js';
import type {
  MssqlConnection,
  MssqlQuery,
  MssqlQueryResult,
  MssqlRow,
} from '../src/connection/types.js';
import { row } from './mockConnection.js';

/**
 * Every catalog row this scenario's tables/views/routines/triggers could
 * return, keyed by which `object_id`-bound parameter (if any) scopes the
 * query. Filtering by the actual bound `OPENJSON` parameter — rather than
 * by call order — is what lets one connection stand in for the several
 * independent `sys.sql_modules` calls made by `loadViews`/`loadRoutines`/
 * `loadTriggers`, each scoped to a different object-id set.
 */
function createIntrospectionScenario() {
  const tableHeaderRows = [
    row({
      objectId: 1,
      schemaName: 'dbo',
      pureName: 'Customers',
      createDate: null,
      modifyDate: null,
      isMemoryOptimized: false,
      durabilityDesc: null,
      temporalTypeDesc: 'NON_TEMPORAL_TABLE',
      historyTableSchemaName: null,
      historyTablePureName: null,
      comment: null,
    }),
    row({
      objectId: 2,
      schemaName: 'dbo',
      pureName: 'Orders',
      createDate: null,
      modifyDate: null,
      isMemoryOptimized: false,
      durabilityDesc: null,
      temporalTypeDesc: 'NON_TEMPORAL_TABLE',
      historyTableSchemaName: null,
      historyTablePureName: null,
      comment: null,
    }),
    row({
      objectId: 3,
      schemaName: 'archived',
      pureName: 'LegacyCustomers',
      createDate: null,
      modifyDate: null,
      isMemoryOptimized: false,
      durabilityDesc: null,
      temporalTypeDesc: 'NON_TEMPORAL_TABLE',
      historyTableSchemaName: null,
      historyTablePureName: null,
      comment: null,
    }),
  ];

  const columnRows = [
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
      identitySeed: 1,
      identityIncrement: 1,
      computedExpression: null,
      isPersisted: null,
      defaultConstraintName: null,
      defaultExpression: null,
      comment: null,
    }),
    row({
      objectId: 2,
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
      identitySeed: 1,
      identityIncrement: 1,
      computedExpression: null,
      isPersisted: null,
      defaultConstraintName: null,
      defaultExpression: null,
      comment: null,
    }),
    row({
      objectId: 2,
      columnId: 2,
      columnName: 'CustomerId',
      dataType: 'int',
      maxLength: 4,
      precision: 10,
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
    row({
      objectId: 2,
      columnId: 3,
      columnName: 'LegacyCustomerId',
      dataType: 'int',
      maxLength: 4,
      precision: 10,
      scale: 0,
      isNullable: true,
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
    row({
      objectId: 3,
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
      isIdentity: false,
      identitySeed: null,
      identityIncrement: null,
      computedExpression: null,
      isPersisted: null,
      defaultConstraintName: null,
      defaultExpression: null,
      comment: null,
    }),
  ];

  const foreignKeyHeaderRows = [
    row({
      objectId: 10,
      parentObjectId: 2,
      refObjectId: 1,
      constraintName: 'FK_Orders_Customers',
      updateActionDesc: 'NO_ACTION',
      deleteActionDesc: 'NO_ACTION',
      isNotTrusted: false,
      isDisabled: false,
    }),
    row({
      objectId: 11,
      parentObjectId: 2,
      refObjectId: 3,
      constraintName: 'FK_Orders_LegacyCustomer',
      updateActionDesc: 'NO_ACTION',
      deleteActionDesc: 'SET_NULL',
      isNotTrusted: false,
      isDisabled: false,
    }),
  ];

  const foreignKeyColumnRows = [
    row({
      constraintObjectId: 10,
      ordinalPosition: 1,
      columnName: 'CustomerId',
      refColumnName: 'Id',
    }),
    row({
      constraintObjectId: 11,
      ordinalPosition: 1,
      columnName: 'LegacyCustomerId',
      refColumnName: 'Id',
    }),
  ];

  const keyConstraintRows = [
    row({
      objectId: 1,
      constraintName: 'PK_Customers',
      constraintType: 'PK',
      isClustered: true,
      keyOrdinal: 1,
      isDescending: false,
      columnName: 'Id',
    }),
    row({
      objectId: 2,
      constraintName: 'PK_Orders',
      constraintType: 'PK',
      isClustered: true,
      keyOrdinal: 1,
      isDescending: false,
      columnName: 'Id',
    }),
  ];

  const indexHeaderRows = [
    row({
      objectId: 2,
      indexId: 2,
      indexName: 'IX_Orders_CustomerId',
      indexTypeDesc: 'NONCLUSTERED',
      isUnique: false,
      isDisabled: false,
      filterDefinition: null,
    }),
  ];
  const indexColumnRows = [
    row({
      objectId: 2,
      indexId: 2,
      keyOrdinal: 1,
      indexColumnId: 1,
      isDescending: false,
      isIncluded: false,
      columnName: 'CustomerId',
    }),
  ];

  const viewHeaderRows = [
    row({
      objectId: 20,
      schemaName: 'dbo',
      pureName: 'vw_CustomerSummary',
      isSchemaBound: false,
      comment: null,
    }),
  ];

  const routineHeaderRows = [
    row({
      objectId: 30,
      schemaName: 'dbo',
      pureName: 'usp_GetOrders',
      objectType: 'P',
      comment: null,
    }),
    row({
      objectId: 31,
      schemaName: 'archived',
      pureName: 'usp_LegacyReport',
      objectType: 'P',
      comment: null,
    }),
  ];

  const triggerHeaderRows = [
    row({
      objectId: 40,
      parentId: 2,
      triggerName: 'trg_Orders_Audit',
      isDisabled: false,
      isInsteadOf: false,
      isInsertTrigger: true,
      isUpdateTrigger: false,
      isDeleteTrigger: false,
    }),
  ];

  const moduleRows = new Map<number, MssqlRow>([
    [
      20,
      row({
        objectId: 20,
        definition: 'CREATE VIEW [dbo].[vw_CustomerSummary] AS SELECT Id FROM dbo.Customers',
        usesAnsiNulls: true,
        usesQuotedIdentifier: true,
        isEncrypted: false,
        isSchemaBound: false,
      }),
    ],
    [
      30,
      row({
        objectId: 30,
        definition: 'CREATE PROCEDURE [dbo].[usp_GetOrders] AS SELECT * FROM dbo.Orders',
        usesAnsiNulls: true,
        usesQuotedIdentifier: true,
        isEncrypted: false,
        isSchemaBound: false,
      }),
    ],
    [
      40,
      row({
        objectId: 40,
        definition:
          'CREATE TRIGGER [dbo].[trg_Orders_Audit] ON [dbo].[Orders] AFTER INSERT AS BEGIN SET NOCOUNT ON; END',
        usesAnsiNulls: true,
        usesQuotedIdentifier: true,
        isEncrypted: false,
        isSchemaBound: null,
      }),
    ],
  ]);

  function boundIds(query: MssqlQuery): number[] {
    const parameter = query.parameters?.[0];
    if (!parameter || typeof parameter.value !== 'string') {
      throw new Error(`Expected exactly one JSON-array parameter on scoped query:\n${query.sql}`);
    }
    return JSON.parse(parameter.value) as number[];
  }

  const connection: MssqlConnection = {
    async query<Row extends MssqlRow = MssqlRow>(
      query: MssqlQuery,
    ): Promise<MssqlQueryResult<Row>> {
      const respond = (rows: readonly MssqlRow[]): MssqlQueryResult<Row> => ({
        rows: rows as readonly Row[],
        columns: [],
        rowsAffected: rows.length,
      });

      if (query.sql.includes('SERVERPROPERTY')) {
        return respond([
          row({ productVersion: '16.0.1000.6', productLevel: 'RTM', engineEdition: 2 }),
        ]);
      }
      if (query.sql.includes('DATABASEPROPERTYEX')) {
        return respond([
          row({
            databaseName: 'ScenarioDb',
            collationName: 'SQL_Latin1_General_CP1_CI_AS',
            compatibilityLevel: 160,
          }),
        ]);
      }
      if (query.sql.includes('from sys.schemas s')) {
        return respond([
          row({ schemaName: 'dbo', ownerName: 'dbo' }),
          row({ schemaName: 'archived', ownerName: 'dbo' }),
          row({ schemaName: 'sys', ownerName: 'sys' }),
        ]);
      }
      if (query.sql.includes('from sys.tables t')) {
        return respond(tableHeaderRows);
      }
      if (query.sql.includes('from sys.columns c')) {
        const ids = new Set(boundIds(query));
        return respond(columnRows.filter(r => ids.has(r.objectId)));
      }
      if (query.sql.includes('from sys.foreign_keys fk')) {
        return respond(foreignKeyHeaderRows);
      }
      if (query.sql.includes('from sys.foreign_key_columns fkc')) {
        const ids = new Set(boundIds(query));
        return respond(foreignKeyColumnRows.filter(r => ids.has(r.constraintObjectId)));
      }
      if (query.sql.includes('from sys.key_constraints kc')) {
        const ids = new Set(boundIds(query));
        return respond(keyConstraintRows.filter(r => ids.has(r.objectId)));
      }
      if (query.sql.includes('from sys.check_constraints cc')) {
        return respond([]);
      }
      if (query.sql.includes('from sys.default_constraints dc')) {
        return respond([]);
      }
      // Indexes on views (indexed/materialized views) — reported as warnings.
      if (query.sql.includes('from sys.indexes vi')) {
        return respond([]);
      }
      if (query.sql.includes('from sys.indexes i')) {
        const ids = new Set(boundIds(query));
        return respond(indexHeaderRows.filter(r => ids.has(r.objectId)));
      }
      if (query.sql.includes('from sys.index_columns ic')) {
        const ids = new Set(boundIds(query));
        return respond(indexColumnRows.filter(r => ids.has(r.objectId)));
      }
      if (query.sql.includes('from sys.sequences seq')) {
        return respond([]);
      }
      if (query.sql.includes('from sys.views v')) {
        return respond(viewHeaderRows);
      }
      if (query.sql.includes('from sys.objects o')) {
        return respond(routineHeaderRows);
      }
      if (query.sql.includes('from sys.triggers tr')) {
        const ids = new Set(boundIds(query));
        return respond(triggerHeaderRows.filter(r => ids.has(r.parentId)));
      }
      if (query.sql.includes('from sys.sql_modules m')) {
        const ids = boundIds(query);
        return respond(
          ids.map(id => moduleRows.get(id)).filter((r): r is MssqlRow => r !== undefined),
        );
      }
      if (query.sql.includes('from sys.sql_expression_dependencies d')) {
        return respond([]);
      }
      throw new Error(`No scripted response configured for query:\n${query.sql}`);
    },
    stream<Row extends MssqlRow = MssqlRow>(): AsyncIterable<Row> {
      return (async function* () {})();
    },
    async cancel(): Promise<void> {},
    async getTransactionStatus() {
      return 'idle' as const;
    },
  };

  return connection;
}

describe('introspectMssql', () => {
  it('detects version, loads the full catalog, and applies exact schema selection', async () => {
    const connection = createIntrospectionScenario();
    const result = await introspectMssql(connection, { selection: { schemas: ['dbo'] } });

    expect(result.version.majorVersion).toBe(16);
    expect(result.version.engineEdition).toBe('standard');
    expect(result.database.databaseName).toBe('ScenarioDb');
    expect(result.database.compatibilityLevel).toBe(160);

    // 'archived' was not in the schema include list; the default-excluded 'sys' never appears either.
    expect(result.database.schemas.map(s => s.schemaName)).toEqual(['dbo']);
  });

  it("pulls a foreign key's referenced table into database.tables even though its schema is excluded", async () => {
    const connection = createIntrospectionScenario();
    const result = await introspectMssql(connection, { selection: { schemas: ['dbo'] } });

    const tableNames = result.database.tables.map(t => `${t.schemaName}.${t.pureName}`).sort();
    expect(tableNames).toEqual(['archived.LegacyCustomers', 'dbo.Customers', 'dbo.Orders']);

    const legacy = result.database.tables.find(t => t.pureName === 'LegacyCustomers');
    // Pulled in for FK validity, so it keeps its columns...
    expect(legacy?.columns).toEqual([expect.objectContaining({ columnName: 'Id' })]);
    // ...but is not independently selected, so it gets none of its own constraints in this pass.
    expect(result.database.primaryKeys.some(pk => pk.pureName === 'LegacyCustomers')).toBe(false);

    expect(result.database.foreignKeys).toHaveLength(2);
    expect(result.database.foreignKeys.map(fk => fk.constraintName).sort()).toEqual([
      'FK_Orders_Customers',
      'FK_Orders_LegacyCustomer',
    ]);
    const crossSchemaFk = result.database.foreignKeys.find(
      fk => fk.constraintName === 'FK_Orders_LegacyCustomer',
    );
    expect(crossSchemaFk).toMatchObject({
      refSchemaName: 'archived',
      refTableName: 'LegacyCustomers',
      deleteAction: 'SET NULL',
    });
  });

  it('loads views/routines/triggers scoped to the selection, with definitions from sys.sql_modules', async () => {
    const connection = createIntrospectionScenario();
    const result = await introspectMssql(connection, { selection: { schemas: ['dbo'] } });

    expect(result.database.views).toHaveLength(1);
    expect(result.database.views[0]).toMatchObject({
      pureName: 'vw_CustomerSummary',
      definition: expect.stringContaining('CREATE VIEW'),
    });

    // usp_LegacyReport lives in the excluded 'archived' schema.
    expect(result.database.routines.map(r => r.pureName)).toEqual(['usp_GetOrders']);

    expect(result.database.triggers).toHaveLength(1);
    expect(result.database.triggers[0]).toMatchObject({
      triggerName: 'trg_Orders_Audit',
      parentName: 'Orders',
      events: ['INSERT'],
    });
  });

  it('loads independent indexes and primary keys for selected tables', async () => {
    const connection = createIntrospectionScenario();
    const result = await introspectMssql(connection, { selection: { schemas: ['dbo'] } });

    expect(result.database.primaryKeys.map(pk => pk.pureName).sort()).toEqual([
      'Customers',
      'Orders',
    ]);
    expect(result.database.indexes).toHaveLength(1);
    expect(result.database.indexes[0]).toMatchObject({
      indexName: 'IX_Orders_CustomerId',
      pureName: 'Orders',
    });
  });

  it('returns an empty database (but still detects version) when no schema matches the selection', async () => {
    const connection = createIntrospectionScenario();
    const result = await introspectMssql(connection, {
      selection: { schemas: ['does_not_exist'] },
    });

    expect(result.database.tables).toEqual([]);
    expect(result.database.views).toEqual([]);
    expect(result.database.routines).toEqual([]);
    expect(result.version.majorVersion).toBe(16);
  });
});

import type { MssqlDatabase } from '../src/model/database.js';
import type { MssqlColumn } from '../src/model/column.js';

/** A fully-shaped, otherwise-empty database, for tests that only need a handful of specific objects. */
export function buildEmptyDatabase(overrides: Partial<MssqlDatabase> = {}): MssqlDatabase {
  return {
    databaseName: 'TestDb',
    collationName: null,
    compatibilityLevel: null,
    schemas: [],
    tables: [],
    views: [],
    routines: [],
    triggers: [],
    sequences: [],
    primaryKeys: [],
    uniqueConstraints: [],
    foreignKeys: [],
    checkConstraints: [],
    defaultConstraints: [],
    indexes: [],
    ...overrides,
  };
}

function column(
  overrides: Partial<MssqlColumn> & { columnName: string; ordinalPosition: number },
): MssqlColumn {
  return {
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
    ...overrides,
  };
}

/**
 * A small `dbo.Customers` / `dbo.Orders` model: one identity primary key per
 * table, a foreign key from Orders to Customers, a supporting index, a
 * check and default constraint, and a view over Orders. Used across
 * archive/renderer tests so their expectations describe one shared,
 * readable schema instead of ad hoc fixtures per test.
 */
export function buildSampleDatabase(): MssqlDatabase {
  return {
    databaseName: 'SampleDb',
    collationName: 'SQL_Latin1_General_CP1_CI_AS',
    compatibilityLevel: 160,
    schemas: [{ schemaName: 'dbo', ownerName: 'dbo' }],
    tables: [
      {
        schemaName: 'dbo',
        pureName: 'Customers',
        objectId: 1,
        createDate: null,
        modifyDate: null,
        comment: null,
        isMemoryOptimized: false,
        durability: null,
        isSystemVersioned: false,
        historyTableSchemaName: null,
        historyTablePureName: null,
        columns: [
          column({
            columnName: 'Id',
            ordinalPosition: 1,
            isIdentity: true,
            identitySeed: 1n,
            identityIncrement: 1n,
          }),
          column({
            columnName: 'Name',
            ordinalPosition: 2,
            dataType: 'nvarchar',
            characterMaxLength: 100,
            isNullable: true,
          }),
        ],
      },
      {
        schemaName: 'dbo',
        pureName: 'Orders',
        objectId: 2,
        createDate: null,
        modifyDate: null,
        comment: null,
        isMemoryOptimized: false,
        durability: null,
        isSystemVersioned: false,
        historyTableSchemaName: null,
        historyTablePureName: null,
        columns: [
          column({
            columnName: 'Id',
            ordinalPosition: 1,
            isIdentity: true,
            identitySeed: 1n,
            identityIncrement: 1n,
          }),
          column({ columnName: 'CustomerId', ordinalPosition: 2 }),
          column({
            columnName: 'Amount',
            ordinalPosition: 3,
            dataType: 'decimal',
            precision: 18,
            scale: 2,
          }),
        ],
      },
    ],
    views: [
      {
        schemaName: 'dbo',
        pureName: 'vw_OrderSummary',
        objectId: 3,
        definition: 'CREATE VIEW [dbo].[vw_OrderSummary] AS SELECT Id, Amount FROM dbo.Orders',
        isSchemaBound: false,
        usesAnsiNulls: true,
        usesQuotedIdentifier: true,
        isEncrypted: false,
        comment: null,
      },
    ],
    routines: [],
    triggers: [],
    sequences: [],
    primaryKeys: [
      {
        constraintName: 'PK_Customers',
        schemaName: 'dbo',
        pureName: 'Customers',
        isClustered: true,
        columns: [{ columnName: 'Id', ordinalPosition: 1, isDescending: false }],
      },
      {
        constraintName: 'PK_Orders',
        schemaName: 'dbo',
        pureName: 'Orders',
        isClustered: true,
        columns: [{ columnName: 'Id', ordinalPosition: 1, isDescending: false }],
      },
    ],
    uniqueConstraints: [],
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
        columns: [{ columnName: 'CustomerId', refColumnName: 'Id', ordinalPosition: 1 }],
      },
    ],
    checkConstraints: [
      {
        constraintName: 'CK_Orders_Amount',
        schemaName: 'dbo',
        pureName: 'Orders',
        definition: '([Amount]>(0))',
        isNotTrusted: false,
        isDisabled: false,
      },
    ],
    defaultConstraints: [
      {
        constraintName: 'DF_Orders_Amount',
        schemaName: 'dbo',
        pureName: 'Orders',
        columnName: 'Amount',
        definition: '((0))',
      },
    ],
    indexes: [
      {
        indexName: 'IX_Orders_CustomerId',
        schemaName: 'dbo',
        pureName: 'Orders',
        indexType: 'NONCLUSTERED',
        isUnique: false,
        isUniqueConstraint: false,
        isDisabled: false,
        filterDefinition: null,
        columns: [
          { columnName: 'CustomerId', ordinalPosition: 1, isDescending: false, isIncluded: false },
        ],
      },
    ],
  };
}

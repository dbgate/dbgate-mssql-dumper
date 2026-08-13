import { describe, expect, it } from 'vitest';
import { buildObjectRefMap } from '../src/introspection/catalog/common.js';
import { loadCheckConstraints } from '../src/introspection/catalog/checkConstraints.js';
import { loadDefaultConstraints } from '../src/introspection/catalog/defaultConstraints.js';
import { loadForeignKeys } from '../src/introspection/catalog/foreignKeys.js';
import { loadKeyConstraints } from '../src/introspection/catalog/keyConstraints.js';
import { createScriptedConnection, row } from './mockConnection.js';

const tableRefs = buildObjectRefMap([
  { objectId: 1, schemaName: 'dbo', pureName: 'Customers' },
  { objectId: 2, schemaName: 'dbo', pureName: 'Orders' },
]);

describe('loadDefaultConstraints', () => {
  it('returns [] without querying when there are no table ids', async () => {
    const connection = createScriptedConnection([]);
    expect(await loadDefaultConstraints(connection, [], tableRefs)).toEqual([]);
    expect(connection.calls).toHaveLength(0);
  });

  it('resolves schemaName/pureName from the ref map rather than joining schemas again', async () => {
    const connection = createScriptedConnection([
      {
        pattern: 'from sys.default_constraints dc',
        rows: [
          row({
            objectId: 2,
            columnId: 3,
            columnName: 'Amount',
            constraintName: 'DF_Orders_Amount',
            definition: '((0))',
          }),
        ],
      },
    ]);

    const constraints = await loadDefaultConstraints(connection, [2], tableRefs);
    expect(constraints).toEqual([
      {
        constraintName: 'DF_Orders_Amount',
        schemaName: 'dbo',
        pureName: 'Orders',
        columnName: 'Amount',
        definition: '((0))',
      },
    ]);
  });

  it('silently drops a row whose object id is not in the ref map (defensive, should not happen given correct scoping)', async () => {
    const connection = createScriptedConnection([
      {
        pattern: 'from sys.default_constraints dc',
        rows: [
          row({
            objectId: 999,
            columnId: 1,
            columnName: 'X',
            constraintName: 'DF_X',
            definition: '(0)',
          }),
        ],
      },
    ]);
    expect(await loadDefaultConstraints(connection, [999], tableRefs)).toEqual([]);
  });
});

describe('loadKeyConstraints', () => {
  it('splits PK and UQ rows and groups multi-column keys in key_ordinal order', async () => {
    const connection = createScriptedConnection([
      {
        pattern: 'from sys.key_constraints kc',
        rows: [
          row({
            objectId: 2,
            constraintName: 'PK_Orders',
            constraintType: 'PK',
            isClustered: true,
            keyOrdinal: 1,
            isDescending: false,
            columnName: 'Id',
          }),
          row({
            objectId: 1,
            constraintName: 'UQ_Customers_Email',
            constraintType: 'UQ',
            isClustered: false,
            keyOrdinal: 1,
            isDescending: false,
            columnName: 'Email',
          }),
          row({
            objectId: 1,
            constraintName: 'UQ_Customers_NameRegion',
            constraintType: 'UQ',
            isClustered: false,
            keyOrdinal: 1,
            isDescending: false,
            columnName: 'Name',
          }),
          row({
            objectId: 1,
            constraintName: 'UQ_Customers_NameRegion',
            constraintType: 'UQ',
            isClustered: false,
            keyOrdinal: 2,
            isDescending: true,
            columnName: 'Region',
          }),
        ],
      },
    ]);

    const result = await loadKeyConstraints(connection, [1, 2], tableRefs);

    expect(result.primaryKeys).toEqual([
      {
        constraintName: 'PK_Orders',
        schemaName: 'dbo',
        pureName: 'Orders',
        isClustered: true,
        columns: [{ columnName: 'Id', ordinalPosition: 1, isDescending: false }],
      },
    ]);

    const composite = result.uniqueConstraints.find(
      uq => uq.constraintName === 'UQ_Customers_NameRegion',
    );
    expect(composite?.columns).toEqual([
      { columnName: 'Name', ordinalPosition: 1, isDescending: false },
      { columnName: 'Region', ordinalPosition: 2, isDescending: true },
    ]);
  });
});

describe('loadCheckConstraints', () => {
  it('maps definition, trust, and disabled state', async () => {
    const connection = createScriptedConnection([
      {
        pattern: 'from sys.check_constraints cc',
        rows: [
          row({
            objectId: 2,
            constraintName: 'CK_Orders_Amount',
            definition: '([Amount]>(0))',
            isNotTrusted: true,
            isDisabled: false,
          }),
        ],
      },
    ]);

    const constraints = await loadCheckConstraints(connection, [2], tableRefs);
    expect(constraints).toEqual([
      {
        constraintName: 'CK_Orders_Amount',
        schemaName: 'dbo',
        pureName: 'Orders',
        definition: '([Amount]>(0))',
        isNotTrusted: true,
        isDisabled: false,
      },
    ]);
  });
});

describe('loadForeignKeys', () => {
  it('joins header and column-list queries, normalizing underscore-separated referential actions', async () => {
    const connection = createScriptedConnection([
      {
        pattern: 'from sys.foreign_keys fk',
        rows: [
          row({
            objectId: 10,
            parentObjectId: 2,
            refObjectId: 1,
            constraintName: 'FK_Orders_Customers',
            updateActionDesc: 'CASCADE',
            deleteActionDesc: 'SET_NULL',
            isNotTrusted: false,
            isDisabled: false,
          }),
        ],
      },
      {
        pattern: 'from sys.foreign_key_columns fkc',
        rows: [
          row({
            constraintObjectId: 10,
            ordinalPosition: 1,
            columnName: 'CustomerId',
            refColumnName: 'Id',
          }),
        ],
      },
    ]);

    const result = await loadForeignKeys(connection, [2], tableRefs);

    expect(result.diagnostics).toEqual([]);
    expect(result.foreignKeys).toEqual([
      {
        constraintName: 'FK_Orders_Customers',
        schemaName: 'dbo',
        pureName: 'Orders',
        refSchemaName: 'dbo',
        refTableName: 'Customers',
        updateAction: 'CASCADE',
        deleteAction: 'SET NULL',
        isNotTrusted: false,
        isDisabled: false,
        columns: [{ columnName: 'CustomerId', refColumnName: 'Id', ordinalPosition: 1 }],
      },
    ]);
  });

  it('maps NO_ACTION and SET_DEFAULT', async () => {
    const connection = createScriptedConnection([
      {
        pattern: 'from sys.foreign_keys fk',
        rows: [
          row({
            objectId: 10,
            parentObjectId: 2,
            refObjectId: 1,
            constraintName: 'FK_A',
            updateActionDesc: 'NO_ACTION',
            deleteActionDesc: 'SET_DEFAULT',
            isNotTrusted: false,
            isDisabled: false,
          }),
        ],
      },
      { pattern: 'from sys.foreign_key_columns fkc', rows: [] },
    ]);

    const result = await loadForeignKeys(connection, [2], tableRefs);
    expect(result.foreignKeys[0]).toMatchObject({
      updateAction: 'NO ACTION',
      deleteAction: 'SET DEFAULT',
    });
  });

  it('reports a diagnostic instead of a foreign key when the referenced table cannot be resolved', async () => {
    const connection = createScriptedConnection([
      {
        pattern: 'from sys.foreign_keys fk',
        rows: [
          row({
            objectId: 10,
            parentObjectId: 2,
            refObjectId: 999,
            constraintName: 'FK_Dangling',
            updateActionDesc: 'NO_ACTION',
            deleteActionDesc: 'NO_ACTION',
            isNotTrusted: false,
            isDisabled: false,
          }),
        ],
      },
      { pattern: 'from sys.foreign_key_columns fkc', rows: [] },
    ]);

    const result = await loadForeignKeys(connection, [2], tableRefs);
    expect(result.foreignKeys).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      severity: 'warning',
      code: 'unresolved-foreign-key-target',
    });
  });

  it('returns empty results without querying when there are no table ids', async () => {
    const connection = createScriptedConnection([]);
    const result = await loadForeignKeys(connection, [], tableRefs);
    expect(result).toEqual({ foreignKeys: [], diagnostics: [] });
    expect(connection.calls).toHaveLength(0);
  });
});

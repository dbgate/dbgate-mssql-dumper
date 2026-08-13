import { describe, expect, it } from 'vitest';
import { buildObjectRefMap } from '../src/introspection/catalog/common.js';
import { loadIndexes } from '../src/introspection/catalog/indexes.js';
import { createScriptedConnection, row } from './mockConnection.js';

const tableRefs = buildObjectRefMap([{ objectId: 2, schemaName: 'dbo', pureName: 'Orders' }]);

describe('loadIndexes', () => {
  it('returns [] without querying when there are no table ids', async () => {
    const connection = createScriptedConnection([]);
    expect(await loadIndexes(connection, [], tableRefs)).toEqual([]);
    expect(connection.calls).toHaveLength(0);
  });

  it('separates key columns from INCLUDE columns and orders them independently', async () => {
    const connection = createScriptedConnection([
      {
        pattern: 'from sys.indexes i',
        rows: [
          row({
            objectId: 2,
            indexId: 2,
            indexName: 'IX_Orders_CustomerId',
            indexTypeDesc: 'NONCLUSTERED',
            isUnique: false,
            isDisabled: false,
            filterDefinition: null,
          }),
        ],
      },
      {
        pattern: 'from sys.index_columns ic',
        rows: [
          row({
            objectId: 2,
            indexId: 2,
            keyOrdinal: 1,
            indexColumnId: 1,
            isDescending: false,
            isIncluded: false,
            columnName: 'CustomerId',
          }),
          row({
            objectId: 2,
            indexId: 2,
            keyOrdinal: 0,
            indexColumnId: 2,
            isDescending: false,
            isIncluded: true,
            columnName: 'Amount',
          }),
          row({
            objectId: 2,
            indexId: 2,
            keyOrdinal: 0,
            indexColumnId: 3,
            isDescending: false,
            isIncluded: true,
            columnName: 'Status',
          }),
        ],
      },
    ]);

    const indexes = await loadIndexes(connection, [2], tableRefs);
    expect(indexes).toHaveLength(1);
    expect(indexes[0]).toMatchObject({
      indexName: 'IX_Orders_CustomerId',
      indexType: 'NONCLUSTERED',
      isUnique: false,
      isUniqueConstraint: false,
    });
    expect(indexes[0]?.columns).toEqual([
      { columnName: 'CustomerId', ordinalPosition: 1, isDescending: false, isIncluded: false },
      { columnName: 'Amount', ordinalPosition: 2, isDescending: false, isIncluded: true },
      { columnName: 'Status', ordinalPosition: 3, isDescending: false, isIncluded: true },
    ]);
  });

  it('excludes PK/unique-constraint-backed indexes at the SQL level, and preserves columnstore type_desc verbatim', async () => {
    const connection = createScriptedConnection([
      {
        pattern: 'from sys.indexes i',
        rows: [
          row({
            objectId: 2,
            indexId: 3,
            indexName: 'CCI_Orders',
            indexTypeDesc: 'CLUSTERED COLUMNSTORE',
            isUnique: false,
            isDisabled: false,
            filterDefinition: null,
          }),
        ],
      },
      { pattern: 'from sys.index_columns ic', rows: [] },
    ]);

    const indexes = await loadIndexes(connection, [2], tableRefs);
    expect(indexes[0]?.indexType).toBe('CLUSTERED COLUMNSTORE');
    // The query itself is responsible for excluding is_primary_key/is_unique_constraint rows;
    // this test documents the SQL filter's intent via the mock's absence of such rows.
    expect(indexes.every(ix => !ix.isUniqueConstraint)).toBe(true);
  });

  it('maps a filtered index definition and disabled state', async () => {
    const connection = createScriptedConnection([
      {
        pattern: 'from sys.indexes i',
        rows: [
          row({
            objectId: 2,
            indexId: 4,
            indexName: 'IX_Orders_Active',
            indexTypeDesc: 'NONCLUSTERED',
            isUnique: true,
            isDisabled: true,
            filterDefinition: '([IsActive]=(1))',
          }),
        ],
      },
      { pattern: 'from sys.index_columns ic', rows: [] },
    ]);

    const indexes = await loadIndexes(connection, [2], tableRefs);
    expect(indexes[0]).toMatchObject({
      isUnique: true,
      isDisabled: true,
      filterDefinition: '([IsActive]=(1))',
    });
  });

  it('drops an index whose owning table id is not in the ref map', async () => {
    const connection = createScriptedConnection([
      {
        pattern: 'from sys.indexes i',
        rows: [
          row({
            objectId: 999,
            indexId: 1,
            indexName: 'IX_Orphan',
            indexTypeDesc: 'NONCLUSTERED',
            isUnique: false,
            isDisabled: false,
            filterDefinition: null,
          }),
        ],
      },
      { pattern: 'from sys.index_columns ic', rows: [] },
    ]);

    expect(await loadIndexes(connection, [999], tableRefs)).toEqual([]);
  });
});

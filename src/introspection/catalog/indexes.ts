import type { MssqlConnection, MssqlRow } from '../../connection/types.js';
import type { MssqlIndex, MssqlIndexColumn, MssqlIndexType } from '../../model/indexes.js';
import type { ObjectRef } from './common.js';
import { objectIdFilter } from './objectIdFilter.js';

interface IndexHeaderRow extends MssqlRow {
  readonly objectId: number;
  readonly indexId: number;
  readonly indexName: string;
  readonly indexTypeDesc: string;
  readonly isUnique: boolean;
  readonly isDisabled: boolean;
  readonly filterDefinition: string | null;
}

interface IndexColumnRow extends MssqlRow {
  readonly objectId: number;
  readonly indexId: number;
  readonly keyOrdinal: number;
  readonly indexColumnId: number;
  readonly isDescending: boolean;
  readonly isIncluded: boolean;
  readonly columnName: string;
}

/**
 * Loads every independent (non primary-key, non unique-constraint-backed)
 * index for the given table `object_id`s via two bulk queries — headers
 * from `sys.indexes`, columns from `sys.index_columns` — joined by
 * `(object_id, index_id)` in memory. Primary keys and unique constraints
 * are excluded here (`is_primary_key = 0 and is_unique_constraint = 0`) so
 * they stay distinguishable as their own model collections rather than
 * also appearing as plain indexes.
 */
export async function loadIndexes(
  connection: MssqlConnection,
  tableObjectIds: readonly number[],
  tableRefs: ReadonlyMap<number, ObjectRef>,
  signal?: AbortSignal,
): Promise<MssqlIndex[]> {
  if (tableObjectIds.length === 0) {
    return [];
  }

  const headerFilter = objectIdFilter('i.object_id', 'tableIds', tableObjectIds);
  const headerResult = await connection.query<IndexHeaderRow>(
    {
      sql: `select
        i.object_id as objectId,
        i.index_id as indexId,
        i.name as indexName,
        i.type_desc as indexTypeDesc,
        i.is_unique as isUnique,
        i.is_disabled as isDisabled,
        i.filter_definition as filterDefinition
      from sys.indexes i
      where ${headerFilter.clause}
        and i.index_id > 0
        and i.is_hypothetical = 0
        and i.is_primary_key = 0
        and i.is_unique_constraint = 0
      order by i.object_id, i.name`,
      parameters: [headerFilter.parameter],
    },
    signal,
  );

  if (headerResult.rows.length === 0) {
    return [];
  }

  const columnFilter = objectIdFilter('ic.object_id', 'tableIds', tableObjectIds);
  const columnResult = await connection.query<IndexColumnRow>(
    {
      sql: `select
        ic.object_id as objectId,
        ic.index_id as indexId,
        ic.key_ordinal as keyOrdinal,
        ic.index_column_id as indexColumnId,
        ic.is_descending_key as isDescending,
        ic.is_included_column as isIncluded,
        col.name as columnName
      from sys.index_columns ic
      inner join sys.columns col on col.object_id = ic.object_id and col.column_id = ic.column_id
      where ${columnFilter.clause}
      order by ic.object_id, ic.index_id, ic.index_column_id`,
      parameters: [columnFilter.parameter],
    },
    signal,
  );

  const columnsByIndex = new Map<string, MssqlIndexColumn[]>();
  for (const row of columnResult.rows) {
    const key = `${row.objectId}.${row.indexId}`;
    const column: MssqlIndexColumn = {
      columnName: row.columnName,
      ordinalPosition: row.isIncluded ? row.indexColumnId : row.keyOrdinal,
      isDescending: row.isDescending,
      isIncluded: row.isIncluded,
    };
    const existing = columnsByIndex.get(key);
    if (existing) {
      existing.push(column);
    } else {
      columnsByIndex.set(key, [column]);
    }
  }

  const indexes: MssqlIndex[] = [];
  for (const row of headerResult.rows) {
    const ref = tableRefs.get(row.objectId);
    if (!ref) {
      continue;
    }
    indexes.push({
      indexName: row.indexName,
      schemaName: ref.schemaName,
      pureName: ref.pureName,
      indexType: row.indexTypeDesc as MssqlIndexType,
      isUnique: row.isUnique,
      isUniqueConstraint: false,
      isDisabled: row.isDisabled,
      filterDefinition: row.filterDefinition,
      columns: columnsByIndex.get(`${row.objectId}.${row.indexId}`) ?? [],
    });
  }
  return indexes;
}

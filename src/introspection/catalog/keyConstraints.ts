import type { MssqlConnection, MssqlRow } from '../../connection/types.js';
import type {
  MssqlKeyColumn,
  MssqlPrimaryKey,
  MssqlUniqueConstraint,
} from '../../model/constraint.js';
import type { ObjectRef } from './common.js';
import { objectIdFilter } from './objectIdFilter.js';

interface KeyConstraintRow extends MssqlRow {
  readonly objectId: number;
  readonly constraintName: string;
  /** `'PK'` or `'UQ'`, from `sys.key_constraints.type`. */
  readonly constraintType: string;
  readonly isClustered: boolean;
  readonly keyOrdinal: number;
  readonly isDescending: boolean;
  readonly columnName: string;
}

export interface KeyConstraints {
  readonly primaryKeys: MssqlPrimaryKey[];
  readonly uniqueConstraints: MssqlUniqueConstraint[];
}

/**
 * Loads every `PRIMARY KEY` and `UNIQUE` constraint for the given table
 * `object_id`s in one bulk query (`sys.key_constraints` joined to the
 * backing `sys.indexes`/`sys.index_columns`), splitting the two constraint
 * kinds apart afterward by `constraintType` rather than querying them
 * separately.
 */
export async function loadKeyConstraints(
  connection: MssqlConnection,
  tableObjectIds: readonly number[],
  tableRefs: ReadonlyMap<number, ObjectRef>,
  signal?: AbortSignal,
): Promise<KeyConstraints> {
  if (tableObjectIds.length === 0) {
    return { primaryKeys: [], uniqueConstraints: [] };
  }

  const filter = objectIdFilter('kc.parent_object_id', 'tableIds', tableObjectIds);
  const result = await connection.query<KeyConstraintRow>(
    {
      sql: `select
        kc.parent_object_id as objectId,
        kc.name as constraintName,
        kc.type as constraintType,
        i.is_clustered as isClustered,
        ic.key_ordinal as keyOrdinal,
        ic.is_descending_key as isDescending,
        col.name as columnName
      from sys.key_constraints kc
      inner join sys.indexes i on i.object_id = kc.parent_object_id and i.index_id = kc.unique_index_id
      inner join sys.index_columns ic on ic.object_id = i.object_id and ic.index_id = i.index_id
      inner join sys.columns col on col.object_id = ic.object_id and col.column_id = ic.column_id
      where ${filter.clause}
      order by kc.parent_object_id, kc.name, ic.key_ordinal`,
      parameters: [filter.parameter],
    },
    signal,
  );

  interface Builder {
    readonly constraintName: string;
    readonly schemaName: string;
    readonly pureName: string;
    readonly isClustered: boolean;
    readonly columns: MssqlKeyColumn[];
  }

  const primaryKeys = new Map<string, Builder>();
  const uniqueConstraints = new Map<string, Builder>();

  for (const row of result.rows) {
    const ref = tableRefs.get(row.objectId);
    if (!ref) {
      continue;
    }
    const key = `${row.objectId}.${row.constraintName}`;
    const targetMap = row.constraintType === 'PK' ? primaryKeys : uniqueConstraints;
    const column: MssqlKeyColumn = {
      columnName: row.columnName,
      ordinalPosition: row.keyOrdinal,
      isDescending: row.isDescending,
    };
    const existing = targetMap.get(key);
    if (existing) {
      existing.columns.push(column);
    } else {
      targetMap.set(key, {
        constraintName: row.constraintName,
        schemaName: ref.schemaName,
        pureName: ref.pureName,
        isClustered: row.isClustered,
        columns: [column],
      });
    }
  }

  return {
    primaryKeys: [...primaryKeys.values()] as MssqlPrimaryKey[],
    uniqueConstraints: [...uniqueConstraints.values()] as MssqlUniqueConstraint[],
  };
}

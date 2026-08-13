import type { MssqlConnection, MssqlRow } from '../../connection/types.js';
import type { MssqlDefaultConstraint } from '../../model/constraint.js';
import type { ObjectRef } from './common.js';
import { objectIdFilter } from './objectIdFilter.js';

interface DefaultConstraintRow extends MssqlRow {
  readonly objectId: number;
  readonly columnId: number;
  readonly columnName: string;
  readonly constraintName: string;
  readonly definition: string;
}

/**
 * Loads every `DEFAULT` constraint for the given table `object_id`s in one
 * bulk query. Resolving `schemaName`/`pureName` from `tableRefs` (rather
 * than joining `sys.schemas` again here) means this query only ever
 * selects the owning `object_id`, keeping every constraint/index/trigger
 * query in this module uniform in shape.
 */
export async function loadDefaultConstraints(
  connection: MssqlConnection,
  tableObjectIds: readonly number[],
  tableRefs: ReadonlyMap<number, ObjectRef>,
  signal?: AbortSignal,
): Promise<MssqlDefaultConstraint[]> {
  if (tableObjectIds.length === 0) {
    return [];
  }

  const filter = objectIdFilter('dc.parent_object_id', 'tableIds', tableObjectIds);
  const result = await connection.query<DefaultConstraintRow>(
    {
      sql: `select
        dc.parent_object_id as objectId,
        dc.parent_column_id as columnId,
        col.name as columnName,
        dc.name as constraintName,
        dc.definition as definition
      from sys.default_constraints dc
      inner join sys.columns col on col.object_id = dc.parent_object_id and col.column_id = dc.parent_column_id
      where ${filter.clause}
      order by dc.parent_object_id, dc.name`,
      parameters: [filter.parameter],
    },
    signal,
  );

  const constraints: MssqlDefaultConstraint[] = [];
  for (const row of result.rows) {
    const ref = tableRefs.get(row.objectId);
    if (!ref) {
      continue;
    }
    constraints.push({
      constraintName: row.constraintName,
      schemaName: ref.schemaName,
      pureName: ref.pureName,
      columnName: row.columnName,
      definition: row.definition,
    });
  }
  return constraints;
}

import type { MssqlConnection, MssqlRow } from '../../connection/types.js';
import type { MssqlCheckConstraint } from '../../model/constraint.js';
import type { ObjectRef } from './common.js';
import { objectIdFilter } from './objectIdFilter.js';

interface CheckConstraintRow extends MssqlRow {
  readonly objectId: number;
  readonly constraintName: string;
  readonly definition: string;
  readonly isNotTrusted: boolean;
  readonly isDisabled: boolean;
}

/** Loads every `CHECK` constraint for the given table `object_id`s in one bulk query. */
export async function loadCheckConstraints(
  connection: MssqlConnection,
  tableObjectIds: readonly number[],
  tableRefs: ReadonlyMap<number, ObjectRef>,
  signal?: AbortSignal,
): Promise<MssqlCheckConstraint[]> {
  if (tableObjectIds.length === 0) {
    return [];
  }

  const filter = objectIdFilter('cc.parent_object_id', 'tableIds', tableObjectIds);
  const result = await connection.query<CheckConstraintRow>(
    {
      sql: `select
        cc.parent_object_id as objectId,
        cc.name as constraintName,
        cc.definition as definition,
        cc.is_not_trusted as isNotTrusted,
        cc.is_disabled as isDisabled
      from sys.check_constraints cc
      where ${filter.clause}
      order by cc.parent_object_id, cc.name`,
      parameters: [filter.parameter],
    },
    signal,
  );

  const constraints: MssqlCheckConstraint[] = [];
  for (const row of result.rows) {
    const ref = tableRefs.get(row.objectId);
    if (!ref) {
      continue;
    }
    constraints.push({
      constraintName: row.constraintName,
      schemaName: ref.schemaName,
      pureName: ref.pureName,
      definition: row.definition,
      isNotTrusted: row.isNotTrusted,
      isDisabled: row.isDisabled,
    });
  }
  return constraints;
}

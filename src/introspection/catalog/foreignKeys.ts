import type { MssqlConnection, MssqlRow } from '../../connection/types.js';
import type {
  MssqlForeignKey,
  MssqlForeignKeyAction,
  MssqlForeignKeyColumn,
} from '../../model/constraint.js';
import type { MssqlDiagnostic } from '../../model/diagnostics.js';
import type { ObjectRef } from './common.js';
import { objectIdFilter } from './objectIdFilter.js';

interface ForeignKeyHeaderRow extends MssqlRow {
  readonly objectId: number;
  readonly parentObjectId: number;
  readonly refObjectId: number;
  readonly constraintName: string;
  readonly updateActionDesc: string;
  readonly deleteActionDesc: string;
  readonly isNotTrusted: boolean;
  readonly isDisabled: boolean;
}

interface ForeignKeyColumnRow extends MssqlRow {
  readonly constraintObjectId: number;
  readonly ordinalPosition: number;
  readonly columnName: string;
  readonly refColumnName: string;
}

/** `sys.foreign_keys.update_referential_action_desc`/`delete_referential_action_desc` use underscores, not spaces. */
function toForeignKeyAction(desc: string): MssqlForeignKeyAction {
  switch (desc) {
    case 'CASCADE':
      return 'CASCADE';
    case 'SET_NULL':
      return 'SET NULL';
    case 'SET_DEFAULT':
      return 'SET DEFAULT';
    default:
      return 'NO ACTION';
  }
}

export interface ForeignKeysResult {
  readonly foreignKeys: MssqlForeignKey[];
  readonly diagnostics: MssqlDiagnostic[];
}

/**
 * Loads every foreign key for the given (owning-table) `object_id`s via two
 * bulk queries — one header query (`sys.foreign_keys`) and one column-list
 * query (`sys.foreign_key_columns`) — joined together by `object_id` in
 * memory rather than a per-constraint loop.
 *
 * `allTableRefs` must cover every table in the database, not just the
 * selected/scoped set: a foreign key's referenced table can be outside the
 * current selection (the archive planner is responsible for deciding
 * whether to pull it in as a dependency), but this loader still needs to
 * name it correctly regardless.
 */
export async function loadForeignKeys(
  connection: MssqlConnection,
  tableObjectIds: readonly number[],
  allTableRefs: ReadonlyMap<number, ObjectRef>,
  signal?: AbortSignal,
): Promise<ForeignKeysResult> {
  if (tableObjectIds.length === 0) {
    return { foreignKeys: [], diagnostics: [] };
  }

  const headerFilter = objectIdFilter('fk.parent_object_id', 'tableIds', tableObjectIds);
  const headerResult = await connection.query<ForeignKeyHeaderRow>(
    {
      sql: `select
        fk.object_id as objectId,
        fk.parent_object_id as parentObjectId,
        fk.referenced_object_id as refObjectId,
        fk.name as constraintName,
        fk.update_referential_action_desc as updateActionDesc,
        fk.delete_referential_action_desc as deleteActionDesc,
        fk.is_not_trusted as isNotTrusted,
        fk.is_disabled as isDisabled
      from sys.foreign_keys fk
      where ${headerFilter.clause}
      order by fk.parent_object_id, fk.name`,
      parameters: [headerFilter.parameter],
    },
    signal,
  );

  if (headerResult.rows.length === 0) {
    return { foreignKeys: [], diagnostics: [] };
  }

  const constraintIds = headerResult.rows.map(row => row.objectId);
  const columnFilter = objectIdFilter('fkc.constraint_object_id', 'constraintIds', constraintIds);
  const columnResult = await connection.query<ForeignKeyColumnRow>(
    {
      sql: `select
        fkc.constraint_object_id as constraintObjectId,
        fkc.constraint_column_id as ordinalPosition,
        pc.name as columnName,
        rc.name as refColumnName
      from sys.foreign_key_columns fkc
      inner join sys.columns pc on pc.object_id = fkc.parent_object_id and pc.column_id = fkc.parent_column_id
      inner join sys.columns rc on rc.object_id = fkc.referenced_object_id and rc.column_id = fkc.referenced_column_id
      where ${columnFilter.clause}
      order by fkc.constraint_object_id, fkc.constraint_column_id`,
      parameters: [columnFilter.parameter],
    },
    signal,
  );

  const columnsByConstraint = new Map<number, MssqlForeignKeyColumn[]>();
  for (const row of columnResult.rows) {
    const column: MssqlForeignKeyColumn = {
      columnName: row.columnName,
      refColumnName: row.refColumnName,
      ordinalPosition: row.ordinalPosition,
    };
    const existing = columnsByConstraint.get(row.constraintObjectId);
    if (existing) {
      existing.push(column);
    } else {
      columnsByConstraint.set(row.constraintObjectId, [column]);
    }
  }

  const foreignKeys: MssqlForeignKey[] = [];
  const diagnostics: MssqlDiagnostic[] = [];

  for (const row of headerResult.rows) {
    const parentRef = allTableRefs.get(row.parentObjectId);
    const refRef = allTableRefs.get(row.refObjectId);
    if (!parentRef) {
      continue;
    }
    if (!refRef) {
      diagnostics.push({
        severity: 'warning',
        code: 'unresolved-foreign-key-target',
        message: `Foreign key "${row.constraintName}" on "${parentRef.schemaName}"."${parentRef.pureName}" references an object_id (${row.refObjectId}) that could not be resolved to a table`,
        objectReference: {
          kind: 'foreignKey',
          schemaName: parentRef.schemaName,
          name: row.constraintName,
          parentName: parentRef.pureName,
        },
      });
      continue;
    }
    foreignKeys.push({
      constraintName: row.constraintName,
      schemaName: parentRef.schemaName,
      pureName: parentRef.pureName,
      refSchemaName: refRef.schemaName,
      refTableName: refRef.pureName,
      updateAction: toForeignKeyAction(row.updateActionDesc),
      deleteAction: toForeignKeyAction(row.deleteActionDesc),
      isNotTrusted: row.isNotTrusted,
      isDisabled: row.isDisabled,
      columns: columnsByConstraint.get(row.objectId) ?? [],
    });
  }

  return { foreignKeys, diagnostics };
}

import type { MssqlColumnValue, MssqlConnection, MssqlRow } from '../../connection/types.js';
import type { MssqlColumn } from '../../model/column.js';
import { objectIdFilter } from './objectIdFilter.js';
import { toBigIntOrNull } from './common.js';

interface ColumnRow extends MssqlRow {
  readonly objectId: number;
  readonly columnId: number;
  readonly columnName: string;
  readonly dataType: string;
  readonly maxLength: number;
  readonly precision: number;
  readonly scale: number;
  readonly isNullable: boolean;
  readonly collationName: string | null;
  readonly isRowGuidCol: boolean;
  readonly isSparse: boolean;
  readonly isIdentity: boolean;
  /** Cast to `bigint` in SQL (`sys.identity_columns.seed_value` is `sql_variant`); narrowed to a safe `number` when mapped. */
  readonly identitySeed: MssqlColumnValue;
  readonly identityIncrement: MssqlColumnValue;
  readonly computedExpression: string | null;
  readonly isPersisted: boolean | null;
  readonly defaultConstraintName: string | null;
  readonly defaultExpression: string | null;
  readonly comment: string | null;
}

/** Character-typed data types whose `max_length` is a byte count, not a character count. */
const CHARACTER_TYPES = new Set(['char', 'varchar', 'nchar', 'nvarchar', 'binary', 'varbinary']);

function computeCharacterMaxLength(dataType: string, maxLength: number): number | null {
  if (!CHARACTER_TYPES.has(dataType)) {
    return null;
  }
  if (maxLength === -1) {
    return -1;
  }
  return dataType.startsWith('n') ? maxLength / 2 : maxLength;
}

/**
 * Loads every column of the given table `object_id`s in one bulk query
 * (`sys.columns` joined to `sys.types`, `sys.identity_columns`,
 * `sys.computed_columns`, and `sys.default_constraints`), grouped by
 * `object_id` in memory. Never queried per-table.
 */
export async function loadColumns(
  connection: MssqlConnection,
  tableObjectIds: readonly number[],
  signal?: AbortSignal,
): Promise<Map<number, MssqlColumn[]>> {
  const byObjectId = new Map<number, MssqlColumn[]>();
  if (tableObjectIds.length === 0) {
    return byObjectId;
  }

  const filter = objectIdFilter('c.object_id', 'tableIds', tableObjectIds);
  const result = await connection.query<ColumnRow>(
    {
      sql: `select
        c.object_id as objectId,
        c.column_id as columnId,
        c.name as columnName,
        ty.name as dataType,
        c.max_length as maxLength,
        c.precision as precision,
        c.scale as scale,
        c.is_nullable as isNullable,
        c.collation_name as collationName,
        c.is_rowguidcol as isRowGuidCol,
        c.is_sparse as isSparse,
        ic.is_identity as isIdentity,
        cast(ic.seed_value as bigint) as identitySeed,
        cast(ic.increment_value as bigint) as identityIncrement,
        cc.definition as computedExpression,
        cc.is_persisted as isPersisted,
        dc.name as defaultConstraintName,
        dc.definition as defaultExpression,
        cast(ep.value as nvarchar(max)) as comment
      from sys.columns c
      inner join sys.types ty on ty.user_type_id = c.user_type_id
      left join sys.identity_columns ic on ic.object_id = c.object_id and ic.column_id = c.column_id
      left join sys.computed_columns cc on cc.object_id = c.object_id and cc.column_id = c.column_id
      left join sys.default_constraints dc on dc.parent_object_id = c.object_id and dc.parent_column_id = c.column_id
      left join sys.extended_properties ep
        on ep.major_id = c.object_id and ep.minor_id = c.column_id and ep.class = 1 and ep.name = 'MS_Description'
      where ${filter.clause}
      order by c.object_id, c.column_id`,
      parameters: [filter.parameter],
    },
    signal,
  );

  for (const row of result.rows) {
    const column: MssqlColumn = {
      columnName: row.columnName,
      ordinalPosition: row.columnId,
      dataType: row.dataType,
      maxLength: row.maxLength,
      characterMaxLength: computeCharacterMaxLength(row.dataType, row.maxLength),
      precision: row.precision,
      scale: row.scale,
      isNullable: row.isNullable,
      isIdentity: row.isIdentity,
      // Kept at full bigint precision: the query already casts to `bigint`
      // and Tedious returns it as an exact decimal string, so narrowing here
      // would throw away precision the driver delivered intact.
      identitySeed: toBigIntOrNull(row.identitySeed),
      identityIncrement: toBigIntOrNull(row.identityIncrement),
      isComputed: row.computedExpression !== null,
      computedExpression: row.computedExpression,
      isPersisted: row.isPersisted,
      isSparse: row.isSparse,
      isRowGuidCol: row.isRowGuidCol,
      collationName: row.collationName,
      defaultConstraintName: row.defaultConstraintName,
      defaultExpression: row.defaultExpression,
      comment: row.comment,
    };
    const existing = byObjectId.get(row.objectId);
    if (existing) {
      existing.push(column);
    } else {
      byObjectId.set(row.objectId, [column]);
    }
  }

  return byObjectId;
}

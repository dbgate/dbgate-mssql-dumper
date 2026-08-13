import type { MssqlColumnValue, MssqlConnection, MssqlRow } from '../../connection/types.js';
import type { MssqlSequence } from '../../model/sequence.js';
import { toBigIntOrNull } from './common.js';

interface SequenceRow extends MssqlRow {
  readonly schemaName: string;
  readonly pureName: string;
  readonly dataType: string;
  /** Cast to `bigint` in SQL; kept as the connection's generic column-value type since drivers vary in how they surface a `bigint` column at runtime. */
  readonly startValue: MssqlColumnValue;
  readonly increment: MssqlColumnValue;
  readonly minValue: MssqlColumnValue;
  readonly maxValue: MssqlColumnValue;
  readonly isCycling: boolean;
  readonly currentValue: MssqlColumnValue;
  readonly cacheSize: number | null;
  readonly comment: string | null;
}

/**
 * Loads every `CREATE SEQUENCE` object. `sys.sequences`' numeric columns are
 * `sql_variant`, so they are cast to `bigint` in SQL rather than left for
 * the driver to interpret. `current_value` reflects the sequence's live
 * state without calling `NEXT VALUE FOR` (which would have a side effect).
 */
export async function loadSequences(
  connection: MssqlConnection,
  signal?: AbortSignal,
): Promise<MssqlSequence[]> {
  const result = await connection.query<SequenceRow>(
    {
      sql: `select
        sch.name as schemaName,
        seq.name as pureName,
        ty.name as dataType,
        cast(seq.start_value as bigint) as startValue,
        cast(seq.increment as bigint) as increment,
        cast(seq.minimum_value as bigint) as minValue,
        cast(seq.maximum_value as bigint) as maxValue,
        seq.is_cycling as isCycling,
        cast(seq.current_value as bigint) as currentValue,
        seq.cache_size as cacheSize,
        cast(ep.value as nvarchar(max)) as comment
      from sys.sequences seq
      inner join sys.schemas sch on sch.schema_id = seq.schema_id
      inner join sys.types ty on ty.user_type_id = seq.user_type_id
      left join sys.extended_properties ep
        on ep.major_id = seq.object_id and ep.minor_id = 0 and ep.class = 1 and ep.name = 'MS_Description'
      order by sch.name, seq.name`,
    },
    signal,
  );

  return result.rows.map(row => ({
    schemaName: row.schemaName,
    pureName: row.pureName,
    dataType: row.dataType,
    startValue: toBigIntOrNull(row.startValue),
    increment: toBigIntOrNull(row.increment),
    minValue: toBigIntOrNull(row.minValue),
    maxValue: toBigIntOrNull(row.maxValue),
    isCycling: row.isCycling,
    currentValue: toBigIntOrNull(row.currentValue),
    cacheSize: row.cacheSize,
    comment: row.comment,
  }));
}

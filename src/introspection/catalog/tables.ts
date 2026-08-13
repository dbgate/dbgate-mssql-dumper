import type { MssqlConnection, MssqlRow } from '../../connection/types.js';
import type { MssqlTable, MssqlTableDurability } from '../../model/table.js';

interface TableRow extends MssqlRow {
  readonly objectId: number;
  readonly schemaName: string;
  readonly pureName: string;
  readonly createDate: Date | null;
  readonly modifyDate: Date | null;
  readonly isMemoryOptimized: boolean;
  readonly durabilityDesc: string | null;
  readonly temporalTypeDesc: string;
  readonly historyTableSchemaName: string | null;
  readonly historyTablePureName: string | null;
  readonly comment: string | null;
}

function toDurability(desc: string | null): MssqlTableDurability | null {
  if (desc === 'SCHEMA_AND_DATA' || desc === 'SCHEMA_ONLY') {
    return desc === 'SCHEMA_AND_DATA' ? 'schema-and-data' : 'schema-only';
  }
  return null;
}

/**
 * Loads every ordinary user table in the database (`sys.tables`), without
 * columns — those are loaded separately and joined in memory by
 * `object_id`. Deliberately unfiltered by schema/table selection: the
 * caller filters this full list, so that a caller-supplied name is never
 * interpolated into this query.
 */
export async function loadTables(
  connection: MssqlConnection,
  signal?: AbortSignal,
): Promise<MssqlTable[]> {
  const result = await connection.query<TableRow>(
    {
      sql: `select
        t.object_id as objectId,
        s.name as schemaName,
        t.name as pureName,
        t.create_date as createDate,
        t.modify_date as modifyDate,
        t.is_memory_optimized as isMemoryOptimized,
        t.durability_desc as durabilityDesc,
        t.temporal_type_desc as temporalTypeDesc,
        ht_s.name as historyTableSchemaName,
        ht.name as historyTablePureName,
        cast(ep.value as nvarchar(max)) as comment
      from sys.tables t
      inner join sys.schemas s on s.schema_id = t.schema_id
      left join sys.tables ht on ht.object_id = t.history_table_id
      left join sys.schemas ht_s on ht_s.schema_id = ht.schema_id
      left join sys.extended_properties ep
        on ep.major_id = t.object_id and ep.minor_id = 0 and ep.class = 1 and ep.name = 'MS_Description'
      where t.is_ms_shipped = 0
      order by s.name, t.name`,
    },
    signal,
  );

  return result.rows.map(row => ({
    schemaName: row.schemaName,
    pureName: row.pureName,
    objectId: row.objectId,
    createDate: row.createDate,
    modifyDate: row.modifyDate,
    comment: row.comment,
    isMemoryOptimized: row.isMemoryOptimized,
    durability: toDurability(row.durabilityDesc),
    isSystemVersioned: row.temporalTypeDesc === 'SYSTEM_VERSIONED_TEMPORAL_TABLE',
    historyTableSchemaName: row.historyTableSchemaName,
    historyTablePureName: row.historyTablePureName,
    columns: [],
  }));
}

import type { MssqlConnection, MssqlRow } from '../../connection/types.js';
import type { MssqlDiagnostic } from '../../model/diagnostics.js';

interface IndexedViewRow extends MssqlRow {
  readonly schemaName: string;
  readonly pureName: string;
  readonly indexName: string;
  readonly isClustered: boolean;
}

/**
 * Reports indexes defined on **views** (materialized/"indexed" views).
 *
 * This package models and renders indexes on tables only, so an indexed view's
 * index would otherwise vanish from the dump with no trace: the restored view is
 * still created and still returns the right rows, but it is no longer
 * materialized. Query plans and performance change silently, and — because a
 * unique clustered index is what makes the view materialized in the first place —
 * so does the object's nature.
 *
 * Silent omission is exactly what this package's diagnostics contract forbids,
 * so each such index is reported as a warning naming the view and the index.
 * One bulk query, no per-object loop.
 */
export async function loadIndexedViewDiagnostics(
  connection: MssqlConnection,
  signal?: AbortSignal,
): Promise<MssqlDiagnostic[]> {
  const result = await connection.query<IndexedViewRow>(
    {
      sql: `select
        s.name as schemaName,
        v.name as pureName,
        vi.name as indexName,
        cast(case when vi.type = 1 then 1 else 0 end as bit) as isClustered
      from sys.indexes vi
      inner join sys.views v on v.object_id = vi.object_id
      inner join sys.schemas s on s.schema_id = v.schema_id
      where vi.name is not null and v.is_ms_shipped = 0
      order by s.name, v.name, vi.name`,
    },
    signal,
  );

  return result.rows.map(row => ({
    severity: 'warning' as const,
    code: 'indexed-view-index-not-exported',
    message: `View "${row.schemaName}"."${row.pureName}" has ${row.isClustered ? 'a unique clustered' : 'an'} index "${row.indexName}" (an indexed/materialized view). This package renders indexes on tables only, so the index is not exported and the restored view will not be materialized — recreate it manually after restoring.`,
    objectReference: { kind: 'view' as const, schemaName: row.schemaName, name: row.pureName },
  }));
}

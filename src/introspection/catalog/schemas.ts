import type { MssqlConnection, MssqlRow } from '../../connection/types.js';
import type { MssqlSchema } from '../../model/schema.js';

interface SchemaRow extends MssqlRow {
  readonly schemaName: string;
  readonly ownerName: string | null;
}

/**
 * Loads every schema in the database, including the built-in ones (`sys`,
 * `INFORMATION_SCHEMA`, the fixed database-role schemas). Selection
 * filtering happens later, in memory, against this full list — never by
 * narrowing this query itself — so that a caller-supplied schema name never
 * has to be interpolated into catalog SQL.
 */
export async function loadSchemas(
  connection: MssqlConnection,
  signal?: AbortSignal,
): Promise<MssqlSchema[]> {
  const result = await connection.query<SchemaRow>(
    {
      sql: `select
        s.name as schemaName,
        dp.name as ownerName
      from sys.schemas s
      left join sys.database_principals dp on dp.principal_id = s.principal_id
      order by s.name`,
    },
    signal,
  );
  return result.rows.map(row => ({ schemaName: row.schemaName, ownerName: row.ownerName }));
}

import type { MssqlConnection, MssqlRow } from '../../connection/types.js';

export interface DatabaseIdentity {
  readonly databaseName: string;
  readonly collationName: string | null;
  readonly compatibilityLevel: number | null;
}

interface DatabaseIdentityRow extends MssqlRow {
  readonly databaseName: string;
  readonly collationName: string | null;
  readonly compatibilityLevel: number | null;
}

/**
 * Reads the current database's name, default collation, and compatibility
 * level. `sys.databases.compatibility_level` (not `SERVERPROPERTY`) is the
 * source for compatibility level: it is a per-database setting, unlike the
 * server-wide version detected separately by `detectMssqlVersion()`.
 */
export async function loadDatabaseIdentity(
  connection: MssqlConnection,
  signal?: AbortSignal,
): Promise<DatabaseIdentity> {
  const result = await connection.query<DatabaseIdentityRow>(
    {
      sql: `select
        DB_NAME() as databaseName,
        cast(DATABASEPROPERTYEX(DB_NAME(), 'Collation') as nvarchar(128)) as collationName,
        (select d.compatibility_level from sys.databases d where d.name = DB_NAME()) as compatibilityLevel`,
    },
    signal,
  );
  const row = result.rows[0];
  return {
    databaseName: row?.databaseName ?? 'unknown',
    collationName: row?.collationName ?? null,
    compatibilityLevel: row?.compatibilityLevel ?? null,
  };
}

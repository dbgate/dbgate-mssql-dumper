import type { MssqlConnection, MssqlRow } from '../connection/types.js';
import { engineEditionFromServerProperty, parseMssqlProductVersion } from './types.js';
import type { MssqlVersion } from './types.js';

interface ServerPropertyRow extends MssqlRow {
  readonly productVersion: string | null;
  readonly productLevel: string | null;
  readonly engineEdition: number | null;
}

/**
 * Detects the SQL Server product version and engine edition of the server
 * behind a live connection, using `SERVERPROPERTY(...)` only (no
 * `xp_msver`/`@@VERSION` string parsing, which is locale-dependent).
 */
export async function detectMssqlVersion(
  connection: MssqlConnection,
  signal?: AbortSignal,
): Promise<MssqlVersion> {
  const result = await connection.query<ServerPropertyRow>(
    {
      sql: `select
        cast(SERVERPROPERTY('ProductVersion') as nvarchar(128)) as productVersion,
        cast(SERVERPROPERTY('ProductLevel') as nvarchar(128)) as productLevel,
        cast(SERVERPROPERTY('EngineEdition') as int) as engineEdition`,
    },
    signal,
  );

  const row = result.rows[0];
  if (!row || !row.productVersion) {
    throw new Error('Unable to detect SQL Server version: SERVERPROPERTY query returned no data');
  }

  const engineEdition = engineEditionFromServerProperty(row.engineEdition);
  const { majorVersion, minorVersion, buildNumber, revision } = parseMssqlProductVersion(
    row.productVersion,
  );

  return {
    productVersion: row.productVersion,
    majorVersion,
    minorVersion,
    buildNumber,
    revision,
    engineEdition,
    productLevel: row.productLevel ?? undefined,
    isAzure:
      engineEdition === 'azure-sql-database' ||
      engineEdition === 'azure-synapse-analytics' ||
      engineEdition === 'azure-sql-managed-instance' ||
      engineEdition === 'azure-sql-edge' ||
      engineEdition === 'azure-synapse-serverless',
  };
}

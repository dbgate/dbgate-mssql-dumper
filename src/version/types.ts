/**
 * SQL Server engine edition, derived from `SERVERPROPERTY('EngineEdition')`.
 *
 * See https://learn.microsoft.com/sql/t-sql/functions/serverproperty-transact-sql
 * for the canonical numeric mapping (1=Personal/Desktop, 2=Standard,
 * 3=Enterprise, 4=Express, 5=Azure SQL Database, 6=Azure Synapse Analytics,
 * 8=Azure SQL Managed Instance, 9=Azure SQL Edge, 11=Azure Synapse serverless).
 */
export type MssqlEngineEdition =
  | 'personal'
  | 'standard'
  | 'enterprise'
  | 'express'
  | 'azure-sql-database'
  | 'azure-synapse-analytics'
  | 'azure-sql-managed-instance'
  | 'azure-sql-edge'
  | 'azure-synapse-serverless'
  | 'unknown';

/** Normalized SQL Server product version. */
export interface MssqlVersion {
  /** Raw `SERVERPROPERTY('ProductVersion')` string, e.g. `"16.0.1000.6"`. */
  readonly productVersion: string;
  readonly majorVersion: number;
  readonly minorVersion: number;
  readonly buildNumber: number;
  readonly revision: number;
  readonly engineEdition: MssqlEngineEdition;
  /** `SERVERPROPERTY('ProductLevel')`, e.g. `"RTM"`, `"SP2"`. */
  readonly productLevel?: string;
  readonly isAzure: boolean;
}

/**
 * Capabilities derived once from {@link MssqlVersion}. These describe what
 * the *source* server exposes structurally; they say nothing about what a
 * restore target can accept (see the `compatibility` module for that).
 */
export interface SourceCapabilities {
  /** `CREATE SEQUENCE`; SQL Server 2012 (11.x) and later. */
  readonly supportsSequences: boolean;
  /** Memory-optimized (Hekaton) tables; SQL Server 2014 (12.x) and later. */
  readonly supportsMemoryOptimizedTables: boolean;
  /** System-versioned temporal tables; SQL Server 2016 (13.x) and later. */
  readonly supportsTemporalTables: boolean;
  /** Native JSON functions (`FOR JSON`, `JSON_VALUE`, ...); SQL Server 2016+. */
  readonly supportsJsonFunctions: boolean;
  /** Always Encrypted column metadata; SQL Server 2016 (13.x) and later. */
  readonly supportsAlwaysEncrypted: boolean;
  /** `NODE`/`EDGE` graph tables; SQL Server 2017 (14.x) and later. */
  readonly supportsGraphTables: boolean;
  /** Native `JSON` data type; SQL Server 2025 (17.x) and later. */
  readonly supportsNativeJsonType: boolean;
  /** `sys.extended_properties` (`MS_Description`); all supported versions. */
  readonly supportsExtendedProperties: boolean;
}

export function isAzureEngineEdition(engineEdition: MssqlEngineEdition): boolean {
  return (
    engineEdition === 'azure-sql-database' ||
    engineEdition === 'azure-synapse-analytics' ||
    engineEdition === 'azure-sql-managed-instance' ||
    engineEdition === 'azure-sql-edge' ||
    engineEdition === 'azure-synapse-serverless'
  );
}

export function engineEditionFromServerProperty(
  value: number | null | undefined,
): MssqlEngineEdition {
  switch (value) {
    case 1:
      return 'personal';
    case 2:
      return 'standard';
    case 3:
      return 'enterprise';
    case 4:
      return 'express';
    case 5:
      return 'azure-sql-database';
    case 6:
      return 'azure-synapse-analytics';
    case 8:
      return 'azure-sql-managed-instance';
    case 9:
      return 'azure-sql-edge';
    case 11:
      return 'azure-synapse-serverless';
    default:
      return 'unknown';
  }
}

/**
 * Parses a `SERVERPROPERTY('ProductVersion')` string such as
 * `"16.0.1000.6"` into its numeric components. Throws on malformed input
 * rather than guessing, since callers rely on these numbers for capability
 * gating.
 */
export function parseMssqlProductVersion(productVersion: string): {
  majorVersion: number;
  minorVersion: number;
  buildNumber: number;
  revision: number;
} {
  const parts = productVersion.trim().split('.');
  if (parts.length < 2 || parts.some(part => part.length === 0 || Number.isNaN(Number(part)))) {
    throw new Error(`Cannot parse SQL Server product version: "${productVersion}"`);
  }
  const [major, minor, build, revision] = parts;
  return {
    majorVersion: Number(major),
    minorVersion: Number(minor),
    buildNumber: build !== undefined ? Number(build) : 0,
    revision: revision !== undefined ? Number(revision) : 0,
  };
}

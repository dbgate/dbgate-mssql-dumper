/**
 * Caller-facing schema/table selection. Names are exact SQL Server
 * identifiers: they are matched case-sensitively against catalog names as
 * reported by the server, never lowercased and never treated as wildcard
 * patterns. This preserves mixed-case identifiers created with a
 * case-sensitive collation.
 */
export interface DumpSelection {
  /** Exact schema names to include. When omitted, all non-excluded schemas are included. */
  readonly schemas?: readonly string[];
  /** Exact schema names to exclude, applied after `schemas`. */
  readonly excludeSchemas?: readonly string[];
  /** Exact `schema.table` pairs to include. When omitted, all tables in selected schemas are included. */
  readonly tables?: readonly DumpTableSelector[];
  /** Exact `schema.table` pairs to exclude, applied after `tables`. */
  readonly excludeTables?: readonly DumpTableSelector[];
  /**
   * Include the built-in `sys` and `INFORMATION_SCHEMA` schemas and the
   * fixed database-role schemas (`db_owner`, `db_datareader`, ...).
   * Defaults to `false`.
   */
  readonly includeSystemSchemas?: boolean;
}

export interface DumpTableSelector {
  readonly schemaName: string;
  readonly pureName: string;
}

export interface NormalizedDumpSelection {
  readonly schemas?: ReadonlySet<string>;
  readonly excludeSchemas: ReadonlySet<string>;
  readonly tables?: ReadonlySet<string>;
  readonly excludeTables: ReadonlySet<string>;
  readonly includeSystemSchemas: boolean;
}

/**
 * Fixed SQL Server schemas that exist in every database and are excluded by
 * default: the catalog view schema, the compatibility view schema, and the
 * schemas SQL Server auto-creates for each fixed database role.
 */
export const DEFAULT_EXCLUDED_SCHEMAS: readonly string[] = [
  'sys',
  'INFORMATION_SCHEMA',
  'guest',
  'db_owner',
  'db_accessadmin',
  'db_securityadmin',
  'db_ddladmin',
  'db_backupoperator',
  'db_datareader',
  'db_datawriter',
  'db_denydatareader',
  'db_denydatawriter',
];

export function tableSelectorKey(selector: DumpTableSelector): string {
  return `${selector.schemaName}.${selector.pureName}`;
}

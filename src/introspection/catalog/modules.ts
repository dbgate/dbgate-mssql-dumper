import type { MssqlConnection, MssqlRow } from '../../connection/types.js';
import type { MssqlDiagnostic } from '../../model/diagnostics.js';
import type { MssqlObjectKind } from '../../model/reference.js';
import { objectIdFilter } from './objectIdFilter.js';

export interface ModuleInfo {
  readonly definition: string | null;
  readonly usesAnsiNulls: boolean | null;
  readonly usesQuotedIdentifier: boolean | null;
  readonly isEncrypted: boolean;
  /** `sys.sql_modules.is_schema_bound`; only meaningful for procedures/functions, which have no equivalent column on `sys.objects` itself. */
  readonly isSchemaBound: boolean | null;
}

interface ModuleRow extends MssqlRow {
  readonly objectId: number;
  readonly definition: string | null;
  readonly usesAnsiNulls: boolean | null;
  readonly usesQuotedIdentifier: boolean | null;
  readonly isEncrypted: boolean;
  readonly isSchemaBound: boolean | null;
}

/**
 * Loads `sys.sql_modules` for the given object IDs in one bulk query,
 * shared by views/procedures/functions/triggers rather than queried
 * per-kind. `OBJECTPROPERTY(..., 'IsEncrypted')` is read explicitly rather
 * than inferred from `definition IS NULL`: a `WITH ENCRYPTION` module and a
 * CLR-backed one with no `sys.sql_modules` row at all both leave
 * `definition` unavailable, but only the former is actually encryption —
 * callers use this distinction to choose between an
 * `encrypted-module-definition-unavailable` and a
 * `module-definition-not-found` diagnostic.
 */
export async function loadModules(
  connection: MssqlConnection,
  objectIds: readonly number[],
  signal?: AbortSignal,
): Promise<Map<number, ModuleInfo>> {
  const byObjectId = new Map<number, ModuleInfo>();
  if (objectIds.length === 0) {
    return byObjectId;
  }

  const filter = objectIdFilter('m.object_id', 'objectIds', objectIds);
  const result = await connection.query<ModuleRow>(
    {
      sql: `select
        m.object_id as objectId,
        m.definition as definition,
        m.uses_ansi_nulls as usesAnsiNulls,
        m.uses_quoted_identifier as usesQuotedIdentifier,
        cast(OBJECTPROPERTY(m.object_id, 'IsEncrypted') as bit) as isEncrypted,
        m.is_schema_bound as isSchemaBound
      from sys.sql_modules m
      where ${filter.clause}`,
      parameters: [filter.parameter],
    },
    signal,
  );

  for (const row of result.rows) {
    byObjectId.set(row.objectId, {
      definition: row.definition,
      usesAnsiNulls: row.usesAnsiNulls,
      usesQuotedIdentifier: row.usesQuotedIdentifier,
      isEncrypted: row.isEncrypted,
      isSchemaBound: row.isSchemaBound,
    });
  }
  return byObjectId;
}

/** Default metadata for an object that has no `sys.sql_modules` row at all (e.g. a CLR-backed routine). */
export const MISSING_MODULE_INFO: ModuleInfo = {
  definition: null,
  usesAnsiNulls: null,
  usesQuotedIdentifier: null,
  isEncrypted: false,
  isSchemaBound: null,
};

/**
 * Reports why `info.definition` is `null` for one object, when it is.
 * Never invents SQL text in either case: the caller is left with
 * `definition: null` and this structured diagnostic instead.
 */
export function moduleUnavailableDiagnostic(
  info: ModuleInfo,
  kind: MssqlObjectKind,
  schemaName: string,
  name: string,
  parentName?: string,
): MssqlDiagnostic | undefined {
  if (info.definition !== null) {
    return undefined;
  }
  if (info.isEncrypted) {
    return {
      severity: 'warning',
      code: 'encrypted-module-definition-unavailable',
      message: `"${schemaName}"."${name}" was created WITH ENCRYPTION; SQL Server does not expose its definition, so it cannot be dumped`,
      objectReference: { kind, schemaName, name, parentName },
    };
  }
  return {
    severity: 'warning',
    code: 'module-definition-not-found',
    message: `"${schemaName}"."${name}" has no sys.sql_modules row (for example, a CLR-backed object); its definition is unavailable`,
    objectReference: { kind, schemaName, name, parentName },
  };
}

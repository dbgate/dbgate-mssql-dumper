import type { MssqlConnection, MssqlRow } from '../../connection/types.js';
import type { MssqlDiagnostic } from '../../model/diagnostics.js';
import type { MssqlRoutine, MssqlRoutineKind } from '../../model/routine.js';
import { MISSING_MODULE_INFO, loadModules, moduleUnavailableDiagnostic } from './modules.js';
import type { ModuleInfo } from './modules.js';

interface RoutineHeaderRow extends MssqlRow {
  readonly objectId: number;
  readonly schemaName: string;
  readonly pureName: string;
  /** `sys.objects.type`: `'P'`, `'FN'`, `'IF'`, or `'TF'`. */
  readonly objectType: string;
  readonly comment: string | null;
}

export interface RoutinesResult {
  readonly routines: MssqlRoutine[];
  readonly diagnostics: MssqlDiagnostic[];
}

function toRoutineKind(objectType: string): MssqlRoutineKind {
  switch (objectType) {
    case 'FN':
      return 'scalar-function';
    case 'IF':
      return 'inline-table-function';
    case 'TF':
      return 'table-function';
    default:
      return 'procedure';
  }
}

/**
 * Loads every stored procedure and user-defined function (scalar, inline
 * table-valued, and multi-statement table-valued) via one `sys.objects`
 * query, plus their bodies/session settings from the shared
 * `sys.sql_modules` bulk query.
 */
export async function loadRoutines(
  connection: MssqlConnection,
  signal?: AbortSignal,
): Promise<RoutinesResult> {
  const headerResult = await connection.query<RoutineHeaderRow>(
    {
      sql: `select
        o.object_id as objectId,
        s.name as schemaName,
        o.name as pureName,
        o.type as objectType,
        cast(ep.value as nvarchar(max)) as comment
      from sys.objects o
      inner join sys.schemas s on s.schema_id = o.schema_id
      left join sys.extended_properties ep
        on ep.major_id = o.object_id and ep.minor_id = 0 and ep.class = 1 and ep.name = 'MS_Description'
      where o.type in ('P', 'FN', 'IF', 'TF') and o.is_ms_shipped = 0
      order by s.name, o.name`,
    },
    signal,
  );

  if (headerResult.rows.length === 0) {
    return { routines: [], diagnostics: [] };
  }

  const modules = await loadModules(
    connection,
    headerResult.rows.map(row => row.objectId),
    signal,
  );

  const routines: MssqlRoutine[] = [];
  const diagnostics: MssqlDiagnostic[] = [];

  for (const row of headerResult.rows) {
    const kind = toRoutineKind(row.objectType);
    const module: ModuleInfo = modules.get(row.objectId) ?? MISSING_MODULE_INFO;
    const diagnosticKind = kind === 'procedure' ? 'procedure' : 'scalar-function';
    const diagnostic = moduleUnavailableDiagnostic(
      module,
      diagnosticKind,
      row.schemaName,
      row.pureName,
    );
    if (diagnostic) {
      diagnostics.push(diagnostic);
    }
    routines.push({
      kind,
      schemaName: row.schemaName,
      pureName: row.pureName,
      objectId: row.objectId,
      definition: module.definition,
      isSchemaBound: module.isSchemaBound ?? false,
      usesAnsiNulls: module.usesAnsiNulls,
      usesQuotedIdentifier: module.usesQuotedIdentifier,
      isEncrypted: module.isEncrypted,
      parameters: [],
      comment: row.comment,
    });
  }

  return { routines, diagnostics };
}

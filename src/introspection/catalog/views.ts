import type { MssqlConnection, MssqlRow } from '../../connection/types.js';
import type { MssqlDiagnostic } from '../../model/diagnostics.js';
import type { MssqlView } from '../../model/view.js';
import { MISSING_MODULE_INFO, loadModules, moduleUnavailableDiagnostic } from './modules.js';
import type { ModuleInfo } from './modules.js';

interface ViewHeaderRow extends MssqlRow {
  readonly objectId: number;
  readonly schemaName: string;
  readonly pureName: string;
  readonly comment: string | null;
}

export interface ViewsResult {
  readonly views: MssqlView[];
  readonly diagnostics: MssqlDiagnostic[];
}

/**
 * Loads every view header (`sys.views`) plus its definition/session-setting
 * metadata from the shared `sys.sql_modules` bulk query.
 */
export async function loadViews(
  connection: MssqlConnection,
  signal?: AbortSignal,
): Promise<ViewsResult> {
  const headerResult = await connection.query<ViewHeaderRow>(
    {
      sql: `select
        v.object_id as objectId,
        s.name as schemaName,
        v.name as pureName,
        cast(ep.value as nvarchar(max)) as comment
      from sys.views v
      inner join sys.schemas s on s.schema_id = v.schema_id
      left join sys.extended_properties ep
        on ep.major_id = v.object_id and ep.minor_id = 0 and ep.class = 1 and ep.name = 'MS_Description'
      where v.is_ms_shipped = 0
      order by s.name, v.name`,
    },
    signal,
  );

  if (headerResult.rows.length === 0) {
    return { views: [], diagnostics: [] };
  }

  const modules = await loadModules(
    connection,
    headerResult.rows.map(row => row.objectId),
    signal,
  );

  const views: MssqlView[] = [];
  const diagnostics: MssqlDiagnostic[] = [];

  for (const row of headerResult.rows) {
    const module: ModuleInfo = modules.get(row.objectId) ?? MISSING_MODULE_INFO;
    const diagnostic = moduleUnavailableDiagnostic(module, 'view', row.schemaName, row.pureName);
    if (diagnostic) {
      diagnostics.push(diagnostic);
    }
    views.push({
      schemaName: row.schemaName,
      pureName: row.pureName,
      objectId: row.objectId,
      definition: module.definition,
      // `sys.views` has no schema-binding column of its own — the flag lives
      // on `sys.sql_modules`, which `loadModules` already read above.
      isSchemaBound: module.isSchemaBound ?? false,
      usesAnsiNulls: module.usesAnsiNulls,
      usesQuotedIdentifier: module.usesQuotedIdentifier,
      isEncrypted: module.isEncrypted,
      comment: row.comment,
    });
  }

  return { views, diagnostics };
}

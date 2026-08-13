import type { MssqlConnection, MssqlRow } from '../../connection/types.js';
import type { MssqlDiagnostic } from '../../model/diagnostics.js';
import type { MssqlTrigger, MssqlTriggerEvent } from '../../model/trigger.js';
import type { ObjectRef } from './common.js';
import { MISSING_MODULE_INFO, loadModules, moduleUnavailableDiagnostic } from './modules.js';
import type { ModuleInfo } from './modules.js';
import { objectIdFilter } from './objectIdFilter.js';

interface TriggerHeaderRow extends MssqlRow {
  readonly objectId: number;
  readonly parentId: number;
  readonly triggerName: string;
  readonly isDisabled: boolean;
  readonly isInsteadOf: boolean;
  readonly isInsertTrigger: boolean;
  readonly isUpdateTrigger: boolean;
  readonly isDeleteTrigger: boolean;
}

export interface TriggersResult {
  readonly triggers: MssqlTrigger[];
  readonly diagnostics: MssqlDiagnostic[];
}

/**
 * Loads every table/view-level trigger (`sys.triggers` with
 * `parent_class = 1`, excluding database-level triggers) whose parent is
 * in `parentObjectIds`, plus definitions/session settings from the shared
 * `sys.sql_modules` bulk query.
 */
export async function loadTriggers(
  connection: MssqlConnection,
  parentObjectIds: readonly number[],
  parentRefs: ReadonlyMap<number, ObjectRef>,
  signal?: AbortSignal,
): Promise<TriggersResult> {
  if (parentObjectIds.length === 0) {
    return { triggers: [], diagnostics: [] };
  }

  const filter = objectIdFilter('tr.parent_id', 'parentIds', parentObjectIds);
  const headerResult = await connection.query<TriggerHeaderRow>(
    {
      sql: `select
        tr.object_id as objectId,
        tr.parent_id as parentId,
        tr.name as triggerName,
        tr.is_disabled as isDisabled,
        tr.is_instead_of_trigger as isInsteadOf,
        cast(OBJECTPROPERTY(tr.object_id, 'ExecIsInsertTrigger') as bit) as isInsertTrigger,
        cast(OBJECTPROPERTY(tr.object_id, 'ExecIsUpdateTrigger') as bit) as isUpdateTrigger,
        cast(OBJECTPROPERTY(tr.object_id, 'ExecIsDeleteTrigger') as bit) as isDeleteTrigger
      from sys.triggers tr
      where tr.is_ms_shipped = 0 and tr.parent_class = 1 and ${filter.clause}
      order by tr.name`,
      parameters: [filter.parameter],
    },
    signal,
  );

  if (headerResult.rows.length === 0) {
    return { triggers: [], diagnostics: [] };
  }

  const modules = await loadModules(
    connection,
    headerResult.rows.map(row => row.objectId),
    signal,
  );

  const triggers: MssqlTrigger[] = [];
  const diagnostics: MssqlDiagnostic[] = [];

  for (const row of headerResult.rows) {
    const parentRef = parentRefs.get(row.parentId);
    if (!parentRef) {
      continue;
    }
    const module: ModuleInfo = modules.get(row.objectId) ?? MISSING_MODULE_INFO;
    const diagnostic = moduleUnavailableDiagnostic(
      module,
      'trigger',
      parentRef.schemaName,
      row.triggerName,
      parentRef.pureName,
    );
    if (diagnostic) {
      diagnostics.push(diagnostic);
    }
    const events: MssqlTriggerEvent[] = [];
    if (row.isInsertTrigger) events.push('INSERT');
    if (row.isUpdateTrigger) events.push('UPDATE');
    if (row.isDeleteTrigger) events.push('DELETE');

    triggers.push({
      triggerName: row.triggerName,
      objectId: row.objectId,
      schemaName: parentRef.schemaName,
      parentName: parentRef.pureName,
      definition: module.definition,
      isDisabled: row.isDisabled,
      isInsteadOf: row.isInsteadOf,
      events,
      usesAnsiNulls: module.usesAnsiNulls,
      usesQuotedIdentifier: module.usesQuotedIdentifier,
      isEncrypted: module.isEncrypted,
    });
  }

  return { triggers, diagnostics };
}

import { acquireMssqlConnection } from '../connection/acquire.js';
import { beginMssqlSession } from '../connection/session.js';
import type { MssqlConnection, MssqlConnectionInput } from '../connection/types.js';
import { buildObjectRefMap } from './catalog/common.js';
import type { ObjectRef } from './catalog/common.js';
import { loadCheckConstraints } from './catalog/checkConstraints.js';
import { loadColumns } from './catalog/columns.js';
import { loadDatabaseIdentity } from './catalog/database.js';
import { loadDefaultConstraints } from './catalog/defaultConstraints.js';
import { loadForeignKeys } from './catalog/foreignKeys.js';
import { loadIndexes } from './catalog/indexes.js';
import { loadIndexedViewDiagnostics } from './catalog/indexedViews.js';
import { loadKeyConstraints } from './catalog/keyConstraints.js';
import { loadProgrammableDependencies } from './catalog/programmableDependencies.js';
import type { ResolvableObject } from './catalog/programmableDependencies.js';
import { loadRoutines } from './catalog/routines.js';
import { loadSchemas } from './catalog/schemas.js';
import { loadSequences } from './catalog/sequences.js';
import { loadTables } from './catalog/tables.js';
import { loadTriggers } from './catalog/triggers.js';
import { loadViews } from './catalog/views.js';
import type { MssqlDatabase } from '../model/database.js';
import type { MssqlDiagnostic } from '../model/diagnostics.js';
import {
  isSchemaSelected,
  isTableSelected,
  normalizeDumpSelection,
} from '../selection/normalize.js';
import { detectSourceCapabilities } from '../version/capabilities.js';
import { detectMssqlVersion } from '../version/detect.js';
import type { DumpSelection } from '../selection/types.js';
import type { IntrospectMssqlOptions, MssqlIntrospectionResult } from './types.js';

/**
 * Detects the source server's version/capabilities and loads a normalized
 * `MssqlDatabase` model: schemas, tables (with columns), primary/unique/
 * check/default constraints, foreign keys, independent indexes, sequences,
 * views, routines (procedures and functions), and table/view triggers.
 *
 * Every catalog view is read in a small, fixed number of bulk queries —
 * never one query per table/object — and relationships (which column
 * belongs to which table, which index row belongs to which index, ...) are
 * assembled afterward in memory by matching `object_id`s already returned
 * from a previous query. Selection filtering happens the same way: schemas/
 * tables/views/routines/sequences are always read in full first, then
 * filtered in memory against the normalized selection, so a caller-supplied
 * schema or table name is never interpolated into catalog SQL — only
 * previously-read, trusted `object_id` integers are, and only through a
 * bound `OPENJSON` parameter (see `catalog/objectIdFilter.ts`), never as
 * literal text.
 *
 * A foreign key's referenced table is included in the returned
 * `database.tables` even when it falls outside the selection (with its
 * columns, but not its own constraints/indexes) — mirroring, and required
 * by, `inspectDumpArchive()`'s own dependency-inclusion logic, which looks
 * up referenced tables by name in this same array.
 *
 * `database.objectDependencies` additionally carries discovered view/
 * routine/trigger cross-references (`sys.sql_expression_dependencies`),
 * which `inspectDumpArchive()` uses to order programmable objects by their
 * actual references instead of a fixed guess.
 */
export async function introspectMssql(
  input: MssqlConnectionInput,
  options: IntrospectMssqlOptions = {},
  signal?: AbortSignal,
): Promise<MssqlIntrospectionResult> {
  const selection = normalizeDumpSelection(options.selection);
  const acquired = await acquireMssqlConnection(input, signal);
  const connection: MssqlConnection = acquired.connection;

  try {
    const session = await beginMssqlSession(
      connection,
      {
        transactionMode: options.transactionMode ?? 'none',
        isolationLevel: options.isolationLevel,
      },
      signal,
    );

    try {
      const version = await detectMssqlVersion(connection, signal);
      const capabilities = detectSourceCapabilities(version);
      const identity = await loadDatabaseIdentity(connection, signal);

      const diagnostics: MssqlDiagnostic[] = [];

      const allSchemas = await loadSchemas(connection, signal);
      const schemas = allSchemas.filter(schema => isSchemaSelected(schema.schemaName, selection));

      const allTables = await loadTables(connection, signal);
      const allTableRefs = buildObjectRefMap(allTables);
      const selectedTableIds = new Set(
        allTables
          .filter(table => isTableSelected(table.schemaName, table.pureName, selection))
          .map(t => t.objectId),
      );

      diagnostics.push(...unmatchedSelectorDiagnostics(options.selection, allSchemas, allTables));

      const allViews = await loadViews(connection, signal);
      diagnostics.push(...allViews.diagnostics);
      // Indexes on views are not modelled; report them rather than dropping them.
      diagnostics.push(...(await loadIndexedViewDiagnostics(connection, signal)));
      const selectedViews = allViews.views.filter(view =>
        isSchemaSelected(view.schemaName, selection),
      );

      const allRoutines = await loadRoutines(connection, signal);
      diagnostics.push(...allRoutines.diagnostics);
      const routines = allRoutines.routines.filter(routine =>
        isSchemaSelected(routine.schemaName, selection),
      );

      const allSequences = await loadSequences(connection, signal);
      const sequences = allSequences.filter(sequence =>
        isSchemaSelected(sequence.schemaName, selection),
      );

      let finalTableIds = selectedTableIds;
      let foreignKeys: MssqlDatabase['foreignKeys'] = [];

      if (selectedTableIds.size > 0) {
        const foreignKeysResult = await loadForeignKeys(
          connection,
          [...selectedTableIds],
          allTableRefs,
          signal,
        );
        foreignKeys = foreignKeysResult.foreignKeys;
        diagnostics.push(...foreignKeysResult.diagnostics);

        const objectIdByTableKey = new Map<string, number>();
        for (const [objectId, ref] of allTableRefs) {
          objectIdByTableKey.set(`${ref.schemaName}.${ref.pureName}`, objectId);
        }

        const dependencyTableIds = new Set(selectedTableIds);
        for (const fk of foreignKeys) {
          const refId = objectIdByTableKey.get(`${fk.refSchemaName}.${fk.refTableName}`);
          if (refId !== undefined) {
            dependencyTableIds.add(refId);
          }
        }
        finalTableIds = dependencyTableIds;
      }

      const finalTableIdList = [...finalTableIds];
      const columnsByTable = await loadColumns(connection, finalTableIdList, signal);

      const selectedTableIdList = [...selectedTableIds];
      // Sequential, not `Promise.all`: every catalog query in this run shares
      // one physical session, and TDS cannot interleave two requests on a
      // single connection — a real driver rejects the second one outright
      // ("Requests can only be made in the LoggedIn state"). There is nothing
      // to gain from overlapping them either, since the server executes
      // statements on one connection serially regardless.
      const defaultConstraints = await loadDefaultConstraints(
        connection,
        selectedTableIdList,
        allTableRefs,
        signal,
      );
      // `finalTableIdList`, not `selectedTableIdList`: a table pulled in only as
      // a foreign-key target still needs its PRIMARY KEY / UNIQUE constraint
      // loaded, or the archive cannot emit the key the FK references and the
      // dump is unrestorable. The archive planner decides which of these to
      // actually emit (see `keyBearingTableKeys`).
      const keyConstraints = await loadKeyConstraints(
        connection,
        finalTableIdList,
        allTableRefs,
        signal,
      );
      const checkConstraints = await loadCheckConstraints(
        connection,
        selectedTableIdList,
        allTableRefs,
        signal,
      );
      // Also `finalTableIdList`: a unique index is a legal foreign-key target,
      // so a dependency table's unique indexes must be available to the planner.
      const indexes = await loadIndexes(connection, finalTableIdList, allTableRefs, signal);

      const tables = allTables
        .filter(table => finalTableIds.has(table.objectId))
        .map(table => ({ ...table, columns: columnsByTable.get(table.objectId) ?? [] }));

      const triggerParentIds = [...selectedTableIds, ...selectedViews.map(v => v.objectId)];
      const triggerParentRefs = new Map<number, ObjectRef>([
        ...[...selectedTableIds].map((id): [number, ObjectRef] => [id, allTableRefs.get(id)!]),
        ...selectedViews.map((v): [number, ObjectRef] => [
          v.objectId,
          { schemaName: v.schemaName, pureName: v.pureName },
        ]),
      ]);
      const triggersResult = await loadTriggers(
        connection,
        triggerParentIds,
        triggerParentRefs,
        signal,
      );
      diagnostics.push(...triggersResult.diagnostics);

      const resolvableObjects: ResolvableObject[] = [
        ...allTables.map(table => ({
          objectId: table.objectId,
          schemaName: table.schemaName,
          name: table.pureName,
          kind: 'table' as const,
        })),
        ...allViews.views.map(view => ({
          objectId: view.objectId,
          schemaName: view.schemaName,
          name: view.pureName,
          kind: 'view' as const,
        })),
        ...allRoutines.routines.map(routine => ({
          objectId: routine.objectId,
          schemaName: routine.schemaName,
          name: routine.pureName,
          kind: routine.kind,
        })),
      ];
      const referencingObjectIds = [
        ...selectedViews.map(view => view.objectId),
        ...routines.map(routine => routine.objectId),
        ...triggersResult.triggers.map(trigger => trigger.objectId),
      ];
      const programmableDependencies = await loadProgrammableDependencies(
        connection,
        referencingObjectIds,
        resolvableObjects,
        signal,
      );
      diagnostics.push(...programmableDependencies.diagnostics);

      const database: MssqlDatabase = {
        databaseName: identity.databaseName,
        collationName: identity.collationName,
        compatibilityLevel: identity.compatibilityLevel,
        schemas,
        tables,
        views: selectedViews,
        routines,
        triggers: triggersResult.triggers,
        sequences,
        primaryKeys: keyConstraints.primaryKeys,
        uniqueConstraints: keyConstraints.uniqueConstraints,
        foreignKeys,
        checkConstraints,
        defaultConstraints,
        indexes,
        objectDependencies: programmableDependencies.dependencies,
      };

      await session.commit(signal);
      return { database, version, capabilities, diagnostics };
    } catch (error) {
      await session.rollback().catch(() => {});
      throw error;
    }
  } finally {
    await acquired.release();
  }
}

/**
 * Reports every selector that matched no catalog object.
 *
 * Selection is exact and case-sensitive by design, so a single typo — `Sales`
 * for `sales`, or a singular table name — otherwise yields a dump containing
 * nothing but the header, reported as a complete success with no warnings. A
 * caller can believe they hold a backup they do not have, which is the worst
 * possible failure mode for this library.
 */
function unmatchedSelectorDiagnostics(
  selection: DumpSelection | undefined,
  allSchemas: readonly { readonly schemaName: string }[],
  allTables: readonly { readonly schemaName: string; readonly pureName: string }[],
): MssqlDiagnostic[] {
  if (!selection) {
    return [];
  }
  const schemaNames = new Set(allSchemas.map(schema => schema.schemaName));
  const tableKeys = new Set(allTables.map(table => `${table.schemaName}.${table.pureName}`));
  const diagnostics: MssqlDiagnostic[] = [];

  const reportSchema = (schemaName: string, option: string): void => {
    if (!schemaNames.has(schemaName)) {
      diagnostics.push({
        severity: 'warning',
        code: 'selection-matched-nothing',
        message: `selection.${option} names schema "${schemaName}", which does not exist in this database; names are matched exactly and are case-sensitive`,
        objectReference: { kind: 'schema', schemaName, name: schemaName },
      });
    }
  };
  const reportTable = (
    selector: { readonly schemaName: string; readonly pureName: string },
    option: string,
  ): void => {
    if (!tableKeys.has(`${selector.schemaName}.${selector.pureName}`)) {
      diagnostics.push({
        severity: 'warning',
        code: 'selection-matched-nothing',
        message: `selection.${option} names table "${selector.schemaName}"."${selector.pureName}", which does not exist in this database; names are matched exactly and are case-sensitive`,
        objectReference: {
          kind: 'table',
          schemaName: selector.schemaName,
          name: selector.pureName,
        },
      });
    }
  };

  for (const schemaName of selection.schemas ?? []) reportSchema(schemaName, 'schemas');
  for (const schemaName of selection.excludeSchemas ?? []) {
    reportSchema(schemaName, 'excludeSchemas');
  }
  for (const selector of selection.tables ?? []) reportTable(selector, 'tables');
  for (const selector of selection.excludeTables ?? []) reportTable(selector, 'excludeTables');

  return diagnostics;
}

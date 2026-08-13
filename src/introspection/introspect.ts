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

      const allViews = await loadViews(connection, signal);
      diagnostics.push(...allViews.diagnostics);
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
      const [defaultConstraints, keyConstraints, checkConstraints, indexes] = await Promise.all([
        loadDefaultConstraints(connection, selectedTableIdList, allTableRefs, signal),
        loadKeyConstraints(connection, selectedTableIdList, allTableRefs, signal),
        loadCheckConstraints(connection, selectedTableIdList, allTableRefs, signal),
        loadIndexes(connection, selectedTableIdList, allTableRefs, signal),
      ]);

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

import type { MssqlConnection, MssqlRow } from '../../connection/types.js';
import type { MssqlDiagnostic } from '../../model/diagnostics.js';
import type { MssqlObjectDependency } from '../../model/objectDependency.js';
import type { MssqlObjectKind } from '../../model/reference.js';
import { objectIdFilter } from './objectIdFilter.js';

/** Anything a dependency edge can point at or from: every table/view/routine this introspection run knows about. */
export interface ResolvableObject {
  readonly objectId: number;
  readonly schemaName: string;
  readonly name: string;
  readonly kind: MssqlObjectKind;
}

interface DependencyRow extends MssqlRow {
  readonly referencingObjectId: number;
  readonly isSchemaBoundReference: boolean;
  readonly referencedObjectId: number | null;
  readonly referencedSchemaName: string | null;
  readonly referencedEntityName: string | null;
}

export interface ProgrammableDependenciesResult {
  readonly dependencies: MssqlObjectDependency[];
  readonly diagnostics: MssqlDiagnostic[];
}

/**
 * Loads `sys.sql_expression_dependencies` for the given referencing object
 * IDs (views/procedures/functions/triggers) in one bulk query, and resolves
 * each referenced object against `resolvable` — every table/view/routine
 * this introspection run already knows about, by `object_id` and by exact
 * schema-qualified name.
 *
 * `referenced_id` is SQL Server's own resolution and is tried first; it is
 * documented to be `NULL` whenever SQL Server itself could not bind the
 * reference (dynamic SQL, or occasionally a same-batch/forward reference).
 * This loader then retries by exact `(referenced_schema_name,
 * referenced_entity_name)` against the same known-object set, which
 * recovers many of those cases deterministically without guessing. Anything
 * still unresolved — a system function, a reference outside the
 * introspected selection, or a genuinely dynamic/ambiguous one — is
 * reported as an `unresolved-programmable-dependency` diagnostic and
 * produces no dependency edge; it is never invented.
 */
export async function loadProgrammableDependencies(
  connection: MssqlConnection,
  referencingObjectIds: readonly number[],
  resolvable: readonly ResolvableObject[],
  signal?: AbortSignal,
): Promise<ProgrammableDependenciesResult> {
  if (referencingObjectIds.length === 0) {
    return { dependencies: [], diagnostics: [] };
  }

  const byObjectId = new Map<number, ResolvableObject>(resolvable.map(o => [o.objectId, o]));
  const byQualifiedName = new Map<string, ResolvableObject>(
    resolvable.map(o => [`${o.schemaName}.${o.name}`, o]),
  );

  const filter = objectIdFilter('d.referencing_id', 'objectIds', referencingObjectIds);
  const result = await connection.query<DependencyRow>(
    {
      sql: `select
        d.referencing_id as referencingObjectId,
        d.is_schema_bound_reference as isSchemaBoundReference,
        d.referenced_id as referencedObjectId,
        d.referenced_schema_name as referencedSchemaName,
        d.referenced_entity_name as referencedEntityName
      from sys.sql_expression_dependencies d
      where d.referenced_class_desc = 'OBJECT_OR_COLUMN' and ${filter.clause}
      order by d.referencing_id, d.referenced_id, d.referenced_schema_name, d.referenced_entity_name`,
      parameters: [filter.parameter],
    },
    signal,
  );

  const dependencies: MssqlObjectDependency[] = [];
  const diagnostics: MssqlDiagnostic[] = [];
  const seenEdges = new Set<string>();

  for (const row of result.rows) {
    const from = byObjectId.get(row.referencingObjectId);
    if (!from) {
      continue;
    }

    const to =
      (row.referencedObjectId !== null ? byObjectId.get(row.referencedObjectId) : undefined) ??
      (row.referencedSchemaName !== null && row.referencedEntityName !== null
        ? byQualifiedName.get(`${row.referencedSchemaName}.${row.referencedEntityName}`)
        : undefined);

    if (!to) {
      diagnostics.push({
        severity: 'info',
        code: 'unresolved-programmable-dependency',
        message: `"${from.schemaName}"."${from.name}" references "${row.referencedSchemaName ?? '?'}"."${row.referencedEntityName ?? '?'}", which could not be resolved to a known table/view/routine (it may be a system object, a dynamic reference, or outside the introspected selection)`,
        objectReference: { kind: from.kind, schemaName: from.schemaName, name: from.name },
      });
      continue;
    }

    if (from.schemaName === to.schemaName && from.name === to.name) {
      continue; // a routine referencing itself (recursion) is not archive-relevant
    }

    const edgeKey = `${from.schemaName}.${from.name}->${to.schemaName}.${to.name}`;
    if (seenEdges.has(edgeKey)) {
      continue;
    }
    seenEdges.add(edgeKey);

    dependencies.push({
      fromKind: from.kind,
      fromSchemaName: from.schemaName,
      fromName: from.name,
      toKind: to.kind,
      toSchemaName: to.schemaName,
      toName: to.name,
      isSchemaBoundReference: row.isSchemaBoundReference,
    });
  }

  return { dependencies, diagnostics };
}

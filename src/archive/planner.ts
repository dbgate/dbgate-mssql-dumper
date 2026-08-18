import type { MssqlDatabase } from '../model/database.js';
import type { MssqlDiagnostic } from '../model/diagnostics.js';
import type { MssqlObjectDependency } from '../model/objectDependency.js';
import { archiveObjectTypeToKind } from '../model/reference.js';
import type { MssqlObjectKind } from '../model/reference.js';
import {
  isSchemaSelected,
  isTableSelected,
  normalizeDumpSelection,
} from '../selection/normalize.js';
import type { NormalizedDumpSelection } from '../selection/types.js';
import { createDumpId } from '../utils/hash.js';
import { createArchiveIdentity } from './identity.js';
import { archiveObjectPriority, assignDumpSection, dumpSectionPriority } from './sectionRules.js';
import type {
  ArchiveCycle,
  ArchiveDependency,
  ArchiveEntry,
  ArchiveObjectType,
  ArchiveSelectionState,
  BrokenPreferenceEdge,
  DumpArchiveInspection,
  DumpMode,
} from './types.js';

export interface InspectDumpArchiveOptions {
  readonly mode?: DumpMode;
  readonly selection?: NormalizedDumpSelection;
  /**
   * When `true`, a hard dependency that would otherwise pull in a
   * table/schema outside the selection is rejected (an error diagnostic,
   * `valid: false`) instead of being included automatically. Mirrors
   * `dbgate-pg-dumper`'s strict selection mode.
   */
  readonly strictSelection?: boolean;
  /**
   * Discovered view/routine/trigger cross-references. Defaults to
   * `database.objectDependencies`; pass this explicitly to supply
   * dependencies for a hand-built `MssqlDatabase` (as tests do) without
   * needing a real introspection run.
   */
  readonly dependencies?: readonly MssqlObjectDependency[];
}

interface MutableEntry {
  dumpId: string;
  identity: string;
  objectType: ArchiveObjectType;
  section: ArchiveEntry['section'];
  schemaName: string;
  name: string;
  parentName?: string;
  dependsOn: ArchiveDependency[];
  selectionState: ArchiveSelectionState;
}

/**
 * Converts a normalized {@link MssqlDatabase} into an ordered, dependency-
 * validated set of {@link ArchiveEntry} objects. This is independent of SQL
 * text, output streams, and archive-file formats: it only decides *what*
 * exists and in *what order* it must be restored.
 */
export function inspectDumpArchive(
  database: MssqlDatabase,
  options: InspectDumpArchiveOptions = {},
): DumpArchiveInspection {
  const mode = options.mode ?? 'full';
  const selection = options.selection ?? normalizeDumpSelection();
  const diagnostics: MssqlDiagnostic[] = [];
  const entries = new Map<string, MutableEntry>();
  let hasStrictViolation = false;

  function addEntry(
    objectType: ArchiveObjectType,
    schemaName: string,
    name: string,
    parentName?: string,
    extraParts?: readonly string[],
  ): string {
    const identity = createArchiveIdentity({
      objectType,
      schemaName,
      name,
      parentName,
      extraParts,
    });
    const dumpId = createDumpId(identity);
    const existing = entries.get(dumpId);
    if (existing) {
      diagnostics.push({
        severity: 'error',
        code: 'duplicate-archive-identity',
        message: `Duplicate archive identity for ${objectType} "${schemaName}"."${name}"`,
        objectReference: {
          kind: archiveObjectTypeToKind(objectType),
          schemaName,
          name,
          parentName,
        },
      });
      return dumpId;
    }
    entries.set(dumpId, {
      dumpId,
      identity,
      objectType,
      section: assignDumpSection(objectType),
      schemaName,
      name,
      parentName,
      dependsOn: [],
      selectionState: 'selected',
    });
    return dumpId;
  }

  function addDependency(
    fromDumpId: string,
    toDumpId: string,
    strength: ArchiveDependency['strength'],
  ): void {
    const entry = entries.get(fromDumpId);
    if (!entry || fromDumpId === toDumpId) {
      return;
    }
    const existingEdge = entry.dependsOn.find(dep => dep.targetDumpId === toDumpId);
    if (existingEdge) {
      // A hard requirement always wins over a mere preference discovered elsewhere for the same pair.
      if (strength === 'hard' && existingEdge.strength === 'preference') {
        entry.dependsOn = entry.dependsOn.filter(dep => dep.targetDumpId !== toDumpId);
        entry.dependsOn.push({ targetDumpId: toDumpId, strength: 'hard' });
      }
      return;
    }
    entry.dependsOn.push({ targetDumpId: toDumpId, strength });
  }

  function pushDependencyInclusionDiagnostic(
    kind: MssqlObjectKind,
    schemaName: string,
    name: string,
    label: string,
  ): void {
    if (options.strictSelection) {
      hasStrictViolation = true;
      diagnostics.push({
        severity: 'error',
        code: 'strict-selection-violation',
        message: `${label} "${schemaName}"."${name}" is outside the selection but a selected object depends on it; strictSelection rejects automatic inclusion instead of allowing it`,
        objectReference: { kind, schemaName, name },
      });
      return;
    }
    diagnostics.push({
      severity: 'info',
      code: 'included-as-dependency',
      message: `${label} "${schemaName}"."${name}" is outside the selection but included because a selected object depends on it`,
      objectReference: { kind, schemaName, name },
    });
  }

  const schemaDumpId = new Map<string, string>();
  const tableDumpId = new Map<string, string>();
  const selectedTableKeys = new Set<string>();
  /**
   * Every table/view/sequence/procedure/function/trigger dumpId, keyed by
   * `schemaName.name` — SQL Server shares one object namespace per schema
   * across all of these kinds, so one qualified name is always unambiguous.
   * Used only to resolve `objectDependencies` edges below; unrelated to
   * `tableDumpId`, which backs the separate FK/constraint dependency-pull
   * logic further down.
   */
  const objectDumpIdByQualifiedName = new Map<string, string>();

  for (const schema of database.schemas) {
    if (!isSchemaSelected(schema.schemaName, selection)) {
      continue;
    }
    schemaDumpId.set(schema.schemaName, addEntry('schema', schema.schemaName, schema.schemaName));
  }

  function ensureSchemaEntry(schemaName: string): string {
    const existing = schemaDumpId.get(schemaName);
    if (existing) {
      return existing;
    }
    const dumpId = addEntry('schema', schemaName, schemaName);
    schemaDumpId.set(schemaName, dumpId);
    const entry = entries.get(dumpId);
    if (entry) {
      entry.selectionState = 'dependency';
    }
    pushDependencyInclusionDiagnostic('schema', schemaName, schemaName, 'Schema');
    return dumpId;
  }

  for (const table of database.tables) {
    if (!isTableSelected(table.schemaName, table.pureName, selection)) {
      continue;
    }
    const key = `${table.schemaName}.${table.pureName}`;
    selectedTableKeys.add(key);
    const dumpId = addEntry('table', table.schemaName, table.pureName);
    tableDumpId.set(key, dumpId);
    objectDumpIdByQualifiedName.set(key, dumpId);
    addDependency(dumpId, ensureSchemaEntry(table.schemaName), 'hard');
  }

  function ensureTableEntry(schemaName: string, pureName: string): string | undefined {
    const key = `${schemaName}.${pureName}`;
    const existing = tableDumpId.get(key);
    if (existing) {
      return existing;
    }
    const model = database.tables.find(t => t.schemaName === schemaName && t.pureName === pureName);
    if (!model) {
      return undefined;
    }
    const dumpId = addEntry('table', schemaName, pureName);
    tableDumpId.set(key, dumpId);
    objectDumpIdByQualifiedName.set(key, dumpId);
    const entry = entries.get(dumpId);
    if (entry) {
      entry.selectionState = 'dependency';
    }
    addDependency(dumpId, ensureSchemaEntry(schemaName), 'hard');
    pushDependencyInclusionDiagnostic('table', schemaName, pureName, 'Table');
    return dumpId;
  }

  for (const view of database.views) {
    if (!isSchemaSelected(view.schemaName, selection)) {
      continue;
    }
    const dumpId = addEntry('view', view.schemaName, view.pureName);
    objectDumpIdByQualifiedName.set(`${view.schemaName}.${view.pureName}`, dumpId);
    addDependency(dumpId, ensureSchemaEntry(view.schemaName), 'hard');
  }

  for (const routine of database.routines) {
    if (!isSchemaSelected(routine.schemaName, selection)) {
      continue;
    }
    const objectType: ArchiveObjectType = routine.kind === 'procedure' ? 'procedure' : 'function';
    const dumpId = addEntry(objectType, routine.schemaName, routine.pureName);
    objectDumpIdByQualifiedName.set(`${routine.schemaName}.${routine.pureName}`, dumpId);
    addDependency(dumpId, ensureSchemaEntry(routine.schemaName), 'hard');
  }

  const sequenceDumpId = new Map<string, string>();
  for (const sequence of database.sequences) {
    if (!isSchemaSelected(sequence.schemaName, selection)) {
      continue;
    }
    const key = `${sequence.schemaName}.${sequence.pureName}`;
    const dumpId = addEntry('sequence', sequence.schemaName, sequence.pureName);
    sequenceDumpId.set(key, dumpId);
    objectDumpIdByQualifiedName.set(key, dumpId);
    addDependency(dumpId, ensureSchemaEntry(sequence.schemaName), 'hard');
  }

  /**
   * Tables that will be pulled into the archive purely to satisfy a selected
   * table's foreign key.
   *
   * Such a table needs its PRIMARY KEY / UNIQUE constraint (and any unique
   * index) emitted too, or the very foreign key that pulled it in cannot be
   * created: `ALTER TABLE ... ADD FOREIGN KEY` fails with "There are no primary
   * or candidate keys in the referenced table ... that match the referencing
   * column list". Everything else about a dependency table — check and default
   * constraints, non-unique indexes, its data — stays out, since it is present
   * only as a reference target.
   */
  const foreignKeyTargetKeys = new Set<string>();
  for (const fk of database.foreignKeys) {
    if (selectedTableKeys.has(`${fk.schemaName}.${fk.pureName}`)) {
      foreignKeyTargetKeys.add(`${fk.refSchemaName}.${fk.refTableName}`);
    }
  }
  const keyBearingTableKeys = new Set([...selectedTableKeys, ...foreignKeyTargetKeys]);

  for (const pk of database.primaryKeys) {
    if (!keyBearingTableKeys.has(`${pk.schemaName}.${pk.pureName}`)) {
      continue;
    }
    const dumpId = addEntry('primaryKey', pk.schemaName, pk.constraintName, pk.pureName);
    const tableId = ensureTableEntry(pk.schemaName, pk.pureName);
    if (tableId) {
      addDependency(dumpId, tableId, 'hard');
    }
  }

  for (const uq of database.uniqueConstraints) {
    if (!keyBearingTableKeys.has(`${uq.schemaName}.${uq.pureName}`)) {
      continue;
    }
    const dumpId = addEntry('uniqueConstraint', uq.schemaName, uq.constraintName, uq.pureName);
    const tableId = ensureTableEntry(uq.schemaName, uq.pureName);
    if (tableId) {
      addDependency(dumpId, tableId, 'hard');
    }
  }

  /**
   * Functions a `CHECK`/`DEFAULT` expression may call.
   *
   * SQL Server validates that a function exists at the moment the constraint is
   * added — unlike procedures and triggers, which get deferred name resolution —
   * so the function must be created first. The section priorities already place
   * functions before constraints, but that is only a *tie-break*: a function
   * carrying its own incoming edge (a schema-bound reference to a view, say) is
   * not ready when post-data begins, so Kahn's algorithm emits the constraints
   * first and the restore fails with "Cannot find either column ... or the
   * user-defined function or aggregate".
   *
   * Matching is textual on the function's bare name, which is what the stored
   * constraint definition contains. Conservative by design: a spurious edge is
   * harmless (a function can never depend on a constraint, so this cannot create
   * a cycle), and a miss just leaves the previous tie-break behaviour.
   */
  const functionEntries: { readonly pattern: RegExp; readonly dumpId: string }[] = [];
  for (const routine of database.routines) {
    if (routine.kind === 'procedure') {
      continue;
    }
    const dumpId = objectDumpIdByQualifiedName.get(`${routine.schemaName}.${routine.pureName}`);
    if (!dumpId) {
      continue;
    }
    const escaped = routine.pureName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    functionEntries.push({
      pattern: new RegExp(`(^|[^A-Za-z0-9_@#$])${escaped}([^A-Za-z0-9_@#$]|$)`, 'i'),
      dumpId,
    });
  }

  function addConstraintFunctionDependencies(dumpId: string, definition: string | null): void {
    if (!definition) {
      return;
    }
    for (const fn of functionEntries) {
      if (fn.pattern.test(definition)) {
        addDependency(dumpId, fn.dumpId, 'hard');
      }
    }
  }

  for (const check of database.checkConstraints) {
    if (!selectedTableKeys.has(`${check.schemaName}.${check.pureName}`)) {
      continue;
    }
    const dumpId = addEntry(
      'checkConstraint',
      check.schemaName,
      check.constraintName,
      check.pureName,
    );
    const tableId = ensureTableEntry(check.schemaName, check.pureName);
    if (tableId) {
      addDependency(dumpId, tableId, 'hard');
    }
    addConstraintFunctionDependencies(dumpId, check.definition);
  }

  for (const def of database.defaultConstraints) {
    if (!selectedTableKeys.has(`${def.schemaName}.${def.pureName}`)) {
      continue;
    }
    const dumpId = addEntry('defaultConstraint', def.schemaName, def.constraintName, def.pureName);
    const tableId = ensureTableEntry(def.schemaName, def.pureName);
    if (tableId) {
      addDependency(dumpId, tableId, 'hard');
    }
    addConstraintFunctionDependencies(dumpId, def.definition);
  }

  for (const index of database.indexes) {
    const indexTableKey = `${index.schemaName}.${index.pureName}`;
    // A dependency table contributes only its *unique* indexes, which are legal
    // foreign-key targets in SQL Server just as a constraint is.
    const isNeededForForeignKey = foreignKeyTargetKeys.has(indexTableKey) && index.isUnique;
    if (!selectedTableKeys.has(indexTableKey) && !isNeededForForeignKey) {
      continue;
    }
    const dumpId = addEntry('index', index.schemaName, index.indexName, index.pureName);
    const tableId = ensureTableEntry(index.schemaName, index.pureName);
    if (tableId) {
      addDependency(dumpId, tableId, 'hard');
    }
  }

  // Foreign keys must never block table creation or data loading: each FK entry depends only on
  // its own table and the referenced table (both pre-data), never on another FK, so bulk-loading
  // table data ahead of every FK (guaranteed by the data(1) < post-data(2) section order below) is
  // always safe regardless of how the individual FKs relate to each other.
  for (const fk of database.foreignKeys) {
    if (!selectedTableKeys.has(`${fk.schemaName}.${fk.pureName}`)) {
      continue;
    }
    const dumpId = addEntry('foreignKey', fk.schemaName, fk.constraintName, fk.pureName);
    const tableId = ensureTableEntry(fk.schemaName, fk.pureName);
    if (tableId) {
      addDependency(dumpId, tableId, 'hard');
    }
    const refTableId = ensureTableEntry(fk.refSchemaName, fk.refTableName);
    if (refTableId) {
      addDependency(dumpId, refTableId, 'hard');
    } else {
      diagnostics.push({
        severity: 'warning',
        code: 'unresolved-foreign-key-target',
        message: `Foreign key "${fk.constraintName}" references "${fk.refSchemaName}"."${fk.refTableName}", which is not present in the introspected model`,
        objectReference: {
          kind: 'foreignKey',
          schemaName: fk.schemaName,
          name: fk.constraintName,
          parentName: fk.pureName,
        },
      });
    }
  }

  for (const trigger of database.triggers) {
    const key = `${trigger.schemaName}.${trigger.parentName}`;
    if (!selectedTableKeys.has(key) && !isSchemaSelected(trigger.schemaName, selection)) {
      continue;
    }
    const dumpId = addEntry('trigger', trigger.schemaName, trigger.triggerName, trigger.parentName);
    objectDumpIdByQualifiedName.set(`${trigger.schemaName}.${trigger.triggerName}`, dumpId);
    const tableId = ensureTableEntry(trigger.schemaName, trigger.parentName);
    if (tableId) {
      addDependency(dumpId, tableId, 'hard');
    } else {
      addDependency(dumpId, ensureSchemaEntry(trigger.schemaName), 'hard');
    }
  }

  // Real cross-references, where SQL Server's own catalog metadata could establish them. A
  // schema-bound reference is enforced by SQL Server (the referenced object cannot be dropped or
  // incompatibly altered while it exists), so it becomes a hard requirement; an ordinary reference
  // is not enforced or guaranteed accurate, so it becomes only an ordering preference — safe to
  // discard if honoring it would create a cycle. A reference to an object outside this archive
  // (excluded by selection, or never introspected) cannot become an edge at all; it is reported
  // instead of silently ignored or guessed at.
  const objectDependencies = options.dependencies ?? database.objectDependencies ?? [];
  for (const dependency of objectDependencies) {
    const fromDumpId = objectDumpIdByQualifiedName.get(
      `${dependency.fromSchemaName}.${dependency.fromName}`,
    );
    if (!fromDumpId) {
      continue;
    }
    const toDumpId = objectDumpIdByQualifiedName.get(
      `${dependency.toSchemaName}.${dependency.toName}`,
    );
    if (!toDumpId) {
      // Two very different situations share this branch, and they deserve
      // different severities:
      //
      //  - the target was never introspected (dynamic SQL, a system object, a
      //    hand-built test model): nothing is knowably wrong, so `info`.
      //  - the target exists in the model but selection removed it: the
      //    referencing module WILL fail to restore. `CREATE VIEW` and
      //    `CREATE FUNCTION` have no deferred name resolution, so the batch
      //    errors with "Invalid object name" — that is a `warning` at least,
      //    and a strict-selection violation when the caller asked for strict.
      const targetKey = `${dependency.toSchemaName}.${dependency.toName}`;
      // The target may still be in the model when the caller built one by hand;
      // for a real introspection run the excluded object is already gone from
      // it, so the caller's own explicit exclusions are the reliable signal.
      // Only explicit exclusions are consulted, never a mere absence, so a
      // reference to a system object (never in the archive, never excluded by
      // the caller) stays at `info` instead of producing a false alarm.
      const targetExistsInModel =
        database.tables.some(t => `${t.schemaName}.${t.pureName}` === targetKey) ||
        database.views.some(v => `${v.schemaName}.${v.pureName}` === targetKey) ||
        database.routines.some(r => `${r.schemaName}.${r.pureName}` === targetKey) ||
        database.sequences.some(s => `${s.schemaName}.${s.pureName}` === targetKey);
      const excludedBySelection =
        targetExistsInModel ||
        selection.excludeTables.has(targetKey) ||
        selection.excludeSchemas.has(dependency.toSchemaName);
      if (excludedBySelection && options.strictSelection) {
        hasStrictViolation = true;
      }
      diagnostics.push({
        severity: excludedBySelection ? (options.strictSelection ? 'error' : 'warning') : 'info',
        code: excludedBySelection
          ? 'dependency-excluded-by-selection'
          : 'unresolved-programmable-dependency',
        message: excludedBySelection
          ? `"${dependency.fromSchemaName}"."${dependency.fromName}" references "${dependency.toSchemaName}"."${dependency.toName}", which this selection excludes; the referencing object will fail to restore because SQL Server resolves names for it eagerly`
          : `"${dependency.fromSchemaName}"."${dependency.fromName}" references "${dependency.toSchemaName}"."${dependency.toName}", which is not part of this archive (excluded by selection, or not introspected)`,
        objectReference: {
          kind: dependency.fromKind,
          schemaName: dependency.fromSchemaName,
          name: dependency.fromName,
        },
      });
      continue;
    }
    addDependency(fromDumpId, toDumpId, dependency.isSchemaBoundReference ? 'hard' : 'preference');
  }

  if (mode !== 'schema-only') {
    const dataDumpIdByTableKey = new Map<string, string>();
    for (const key of selectedTableKeys) {
      const tableId = tableDumpId.get(key);
      const table = database.tables.find(t => `${t.schemaName}.${t.pureName}` === key);
      if (!tableId || !table) {
        continue;
      }
      const dataDumpId = addEntry('tableData', table.schemaName, table.pureName, table.pureName);
      dataDumpIdByTableKey.set(key, dataDumpId);
      addDependency(dataDumpId, tableId, 'hard');
    }

    // Order row loads parent-before-child along foreign keys.
    //
    // In `full` mode this is redundant — every foreign key is post-data, so no
    // constraint exists while data loads. `data-only` removes that protection:
    // the target already has the foreign keys, so inserting a child row before
    // its parent fails with "The INSERT statement conflicted with the FOREIGN
    // KEY constraint". Without an edge the fallback is alphabetical, which puts
    // `dbo.Orders` before `dbo.Users`.
    //
    // `preference`, not `hard`, so mutually referencing or cyclic foreign keys
    // are resolved by the existing edge-peeling pass instead of invalidating the
    // archive — such a cycle genuinely cannot be satisfied by ordering alone.
    for (const fk of database.foreignKeys) {
      const childDataId = dataDumpIdByTableKey.get(`${fk.schemaName}.${fk.pureName}`);
      const parentDataId = dataDumpIdByTableKey.get(`${fk.refSchemaName}.${fk.refTableName}`);
      if (childDataId && parentDataId) {
        addDependency(childDataId, parentDataId, 'preference');
      }
    }

    for (const sequence of database.sequences) {
      const key = `${sequence.schemaName}.${sequence.pureName}`;
      const seqDumpId = sequenceDumpId.get(key);
      if (!seqDumpId) {
        continue;
      }
      const stateDumpId = addEntry(
        'sequenceState',
        sequence.schemaName,
        sequence.pureName,
        sequence.pureName,
      );
      addDependency(stateDumpId, seqDumpId, 'hard');
    }
  }

  const allowedSections = new Set(
    mode === 'data-only'
      ? (['data'] as const)
      : mode === 'schema-only'
        ? (['pre-data', 'post-data'] as const)
        : (['pre-data', 'data', 'post-data'] as const),
  );

  const included = new Map<string, MutableEntry>();
  for (const entry of entries.values()) {
    if (allowedSections.has(entry.section)) {
      included.set(entry.dumpId, entry);
    }
  }

  for (const entry of included.values()) {
    entry.dependsOn = entry.dependsOn.filter(dep => included.has(dep.targetDumpId));
  }

  const compare = (a: MutableEntry, b: MutableEntry): number => {
    const sectionDiff = dumpSectionPriority(a.section) - dumpSectionPriority(b.section);
    if (sectionDiff !== 0) return sectionDiff;
    const priorityDiff = archiveObjectPriority(a.objectType) - archiveObjectPriority(b.objectType);
    if (priorityDiff !== 0) return priorityDiff;
    if (a.schemaName !== b.schemaName) return a.schemaName < b.schemaName ? -1 : 1;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.dumpId < b.dumpId ? -1 : a.dumpId > b.dumpId ? 1 : 0;
  };

  const { sorted, hardCycles, droppedPreferenceEdges } = resolveCyclesAndSort(included, compare);

  for (const broken of droppedPreferenceEdges) {
    diagnostics.push({
      severity: 'info',
      code: 'preference-cycle-broken',
      message: `Dropped a non-essential ordering preference from "${broken.fromDumpId}" to "${broken.toDumpId}" to resolve a dependency cycle`,
    });
  }

  if (hardCycles.length > 0) {
    for (const cycle of hardCycles) {
      diagnostics.push({
        severity: 'error',
        code: 'archive-dependency-cycle',
        message: `Hard dependency cycle detected among archive entries: ${cycle.memberDumpIds.join(', ')}`,
      });
    }
    const fallback = [...included.values()].sort(compare);
    const result: ArchiveEntry[] = fallback.map(entry => toArchiveEntry(entry));
    return {
      valid: false,
      entries: result,
      diagnostics,
      cycles: hardCycles,
      droppedPreferenceEdges,
    };
  }

  // A strict-selection violation makes the archive invalid, and
  // `ArchiveEntry.sequenceNumber` is documented as absent for an invalid
  // archive ("no such order exists") — the same contract the unresolved-cycle
  // path already honours. Without this, a caller testing
  // `sequenceNumber === undefined` to detect an unusable archive is misled.
  const result: ArchiveEntry[] = sorted.map((entry, index) =>
    toArchiveEntry(entry, hasStrictViolation ? undefined : index),
  );

  return {
    valid: !hasStrictViolation,
    entries: result,
    diagnostics,
    cycles: [],
    droppedPreferenceEdges,
  };
}

function toArchiveEntry(entry: MutableEntry, sequenceNumber?: number): ArchiveEntry {
  return {
    dumpId: entry.dumpId,
    identity: entry.identity,
    objectType: entry.objectType,
    section: entry.section,
    schemaName: entry.schemaName,
    name: entry.name,
    parentName: entry.parentName,
    dependsOn: entry.dependsOn,
    selectionState: entry.selectionState,
    sequenceNumber,
  };
}

interface Edge {
  readonly to: string;
  strength: ArchiveDependency['strength'];
}

/**
 * Resolves dependency cycles before sorting, differentiating hard
 * dependencies from ordering preferences:
 *
 * 1. Find every strongly connected component (Tarjan's algorithm) of size
 *    greater than one, or a self-loop, in the current edge set.
 * 2. For each such component, if any of its *internal* edges are
 *    preference-strength, drop all of them — breaking a cycle by removing
 *    an edge that carries no correctness requirement is always safe — and
 *    recompute.
 * 3. Repeat until either no non-trivial component remains (success) or an
 *    iteration finds only hard-only components left (failure: report them
 *    as unresolved cycles rather than silently dropping a hard edge, which
 *    would misrepresent a real restore-ordering requirement).
 *
 * Only after this converges does Kahn's algorithm run, so it can assume an
 * acyclic graph and never has to guess which edge "caused" a cycle itself.
 */
function resolveCyclesAndSort(
  included: Map<string, MutableEntry>,
  compare: (a: MutableEntry, b: MutableEntry) => number,
): {
  sorted: MutableEntry[];
  hardCycles: ArchiveCycle[];
  droppedPreferenceEdges: BrokenPreferenceEdge[];
} {
  const edgesByNode = new Map<string, Edge[]>();
  for (const entry of included.values()) {
    edgesByNode.set(
      entry.dumpId,
      entry.dependsOn.map(dep => ({ to: dep.targetDumpId, strength: dep.strength })),
    );
  }

  const droppedPreferenceEdges: BrokenPreferenceEdge[] = [];
  const hardCycles: ArchiveCycle[] = [];

  while (true) {
    const components = computeStronglyConnectedComponents(included, edgesByNode);
    const nonTrivial = components.filter(
      component => component.length > 1 || hasSelfEdge(component[0]!, edgesByNode),
    );
    if (nonTrivial.length === 0) {
      break;
    }

    let removedAny = false;
    for (const component of nonTrivial) {
      const memberSet = new Set(component);
      for (const nodeId of component) {
        const edges = edgesByNode.get(nodeId) ?? [];
        const remaining: Edge[] = [];
        for (const edge of edges) {
          if (edge.strength === 'preference' && memberSet.has(edge.to)) {
            droppedPreferenceEdges.push({ fromDumpId: nodeId, toDumpId: edge.to });
            removedAny = true;
          } else {
            remaining.push(edge);
          }
        }
        edgesByNode.set(nodeId, remaining);
      }
    }

    if (!removedAny) {
      for (const component of nonTrivial) {
        hardCycles.push({ memberDumpIds: [...component].sort() });
      }
      break;
    }
  }

  if (hardCycles.length > 0) {
    return { sorted: [], hardCycles, droppedPreferenceEdges };
  }

  for (const entry of included.values()) {
    entry.dependsOn = (edgesByNode.get(entry.dumpId) ?? []).map(edge => ({
      targetDumpId: edge.to,
      strength: edge.strength,
    }));
  }

  const { sorted, remaining } = kahnSort(included, compare);
  if (remaining.length > 0) {
    // Should be unreachable: the graph was already made acyclic above. Surfaced as a hard cycle
    // rather than silently truncating the output, in case this invariant is ever violated.
    hardCycles.push({ memberDumpIds: remaining.sort() });
    return { sorted: [], hardCycles, droppedPreferenceEdges };
  }

  return { sorted, hardCycles: [], droppedPreferenceEdges };
}

function hasSelfEdge(nodeId: string, edgesByNode: Map<string, Edge[]>): boolean {
  return (edgesByNode.get(nodeId) ?? []).some(edge => edge.to === nodeId);
}

/** Tarjan's strongly-connected-components algorithm over the current (possibly edge-reduced) graph. */
function computeStronglyConnectedComponents(
  included: Map<string, MutableEntry>,
  edgesByNode: Map<string, Edge[]>,
): string[][] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const components: string[][] = [];

  function strongConnect(v: string): void {
    indices.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const edge of edgesByNode.get(v) ?? []) {
      const w = edge.to;
      if (!included.has(w)) {
        continue;
      }
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      components.push(component);
    }
  }

  for (const nodeId of included.keys()) {
    if (!indices.has(nodeId)) {
      strongConnect(nodeId);
    }
  }
  return components;
}

/** Kahn's algorithm, assuming an already-acyclic graph. `remaining` is non-empty only if that assumption was violated. */
function kahnSort(
  included: Map<string, MutableEntry>,
  compare: (a: MutableEntry, b: MutableEntry) => number,
): { sorted: MutableEntry[]; remaining: string[] } {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const entry of included.values()) {
    indegree.set(entry.dumpId, 0);
    dependents.set(entry.dumpId, []);
  }
  for (const entry of included.values()) {
    for (const dep of entry.dependsOn) {
      indegree.set(entry.dumpId, (indegree.get(entry.dumpId) ?? 0) + 1);
      dependents.get(dep.targetDumpId)?.push(entry.dumpId);
    }
  }

  let ready = [...included.values()].filter(entry => (indegree.get(entry.dumpId) ?? 0) === 0);
  ready.sort(compare);

  const sorted: MutableEntry[] = [];
  const remaining = new Set(included.keys());

  while (ready.length > 0) {
    const next = ready.shift();
    if (!next) break;
    remaining.delete(next.dumpId);
    sorted.push(next);
    const newlyReady: MutableEntry[] = [];
    for (const dependentId of dependents.get(next.dumpId) ?? []) {
      const remainingIndegree = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, remainingIndegree);
      if (remainingIndegree === 0) {
        const dependentEntry = included.get(dependentId);
        if (dependentEntry) {
          newlyReady.push(dependentEntry);
        }
      }
    }
    if (newlyReady.length > 0) {
      newlyReady.sort(compare);
      ready = mergeSorted(ready, newlyReady, compare);
    }
  }

  return { sorted, remaining: [...remaining] };
}

function mergeSorted<T>(a: T[], b: T[], compare: (x: T, y: T) => number): T[] {
  const merged: T[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    merged.push(compare(a[i]!, b[j]!) <= 0 ? a[i++]! : b[j++]!);
  }
  while (i < a.length) merged.push(a[i++]!);
  while (j < b.length) merged.push(b[j++]!);
  return merged;
}

import type { MssqlDiagnostic } from '../model/diagnostics.js';

/**
 * Every kind of entry the archive planner can produce. Unlike the model
 * layer, columns are not independent entries: a T-SQL `CREATE TABLE`
 * statement always carries its columns inline, so there is no restore
 * ordering question for them to answer.
 */
export type ArchiveObjectType =
  | 'schema'
  | 'sequence'
  | 'table'
  | 'view'
  | 'procedure'
  | 'function'
  | 'primaryKey'
  | 'uniqueConstraint'
  | 'defaultConstraint'
  | 'checkConstraint'
  | 'index'
  | 'foreignKey'
  | 'trigger'
  | 'tableData'
  /**
   * A sequence's *current* value, as opposed to its static `sequence`
   * definition (`START WITH`). Lives in the `data` section, separately
   * from the pre-data `sequence` entry it depends on — the same split
   * `dbgate-pg-dumper` uses between a sequence's definition and its
   * `OWNED BY` ownership, applied here to definition vs. runtime state.
   */
  | 'sequenceState';

/**
 * Restore-order sections, in emission order. Unlike `pg_dump`, SQL Server has
 * no native archive-section concept; this is purely a planning abstraction
 * for this package.
 */
export type DumpSection = 'pre-data' | 'data' | 'post-data';

export type ArchiveDependencyStrength = 'hard' | 'preference';

/** One directed edge from an entry to another entry it depends on. */
export interface ArchiveDependency {
  readonly targetDumpId: string;
  readonly strength: ArchiveDependencyStrength;
}

/**
 * One immutable, restore-orderable unit of the archive. Entries carry no SQL
 * text; rendering derives text from the model object identified by
 * `schemaName`/`name`/`parentName` at render time.
 */
/**
 * Whether an entry is present because the caller's selection named it
 * directly, or only because some selected entry hard-depends on it (most
 * commonly: a selected table's foreign key targets a table outside the
 * selection). `'dependency'` entries are never dropped silently — see
 * `InspectDumpArchiveOptions.strictSelection` to reject them instead.
 */
export type ArchiveSelectionState = 'selected' | 'dependency';

export interface ArchiveEntry {
  readonly dumpId: string;
  readonly identity: string;
  readonly objectType: ArchiveObjectType;
  readonly section: DumpSection;
  readonly schemaName: string;
  readonly name: string;
  /** Owning table/view name, for column-, constraint-, index-, trigger-, and data-like entries. */
  readonly parentName?: string;
  readonly dependsOn: readonly ArchiveDependency[];
  readonly selectionState: ArchiveSelectionState;
  /**
   * This entry's 0-based position in {@link DumpArchiveInspection.entries}.
   * Redundant with the array index when read from there directly, but
   * carried on the entry itself so a caller holding one `ArchiveEntry` out
   * of context (a diagnostic, a test assertion, a log line) can still see
   * where it landed without re-deriving the whole order. Omitted when
   * `valid` is `false`, since no such order exists.
   */
  readonly sequenceNumber?: number;
}

/** A set of entries mutually blocking each other via *hard* dependencies only; no valid order exists. */
export interface ArchiveCycle {
  readonly memberDumpIds: readonly string[];
}

/**
 * A non-essential ordering-preference edge dropped to resolve a cycle.
 * Reported for transparency; dropping it never affects correctness, only
 * the tie-break order among entries with no real ordering requirement
 * relative to each other.
 */
export interface BrokenPreferenceEdge {
  readonly fromDumpId: string;
  readonly toDumpId: string;
}

export interface DumpArchiveInspection {
  readonly valid: boolean;
  /**
   * Topologically sorted (with `sequenceNumber` set) when `valid` is
   * `true`. When `valid` is `false`, still contains every entry that would
   * have been in the archive, but only in a deterministic fallback order
   * (by section, then object priority, then name) — never a claim of a
   * valid restore order, since none exists.
   */
  readonly entries: readonly ArchiveEntry[];
  readonly diagnostics: readonly MssqlDiagnostic[];
  /** Unresolved hard-dependency cycles. Always present; empty when `valid` is `true`. */
  readonly cycles: readonly ArchiveCycle[];
  /** Ordering-preference edges dropped to resolve a cycle. Always present, possibly empty. */
  readonly droppedPreferenceEdges: readonly BrokenPreferenceEdge[];
}

export type DumpMode = 'full' | 'schema-only' | 'data-only';

import type { ArchiveObjectType, DumpSection } from './types.js';

/**
 * Section/priority assignment for SQL Server, not a copy of `pg_dump`'s
 * pre-data/data/post-data split. Every deviation from the "obvious" order
 * below is deliberate; see the comment next to it.
 *
 * - **pre-data**: `schema`, `sequence`, `table`. Nothing here needs
 *   anything outside pre-data — sequences and tables need only their
 *   schema, which is why this stays the conventional "structure first"
 *   set.
 * - **data**: `tableData`, `sequenceState`. Runtime state, not structure.
 * - **post-data**: everything else, including `view`/`function`/
 *   `procedure`/`trigger` — **not** pre-data. Two independent reasons:
 *   1. Triggers must not fire while table data is being bulk-loaded (an
 *      `AFTER INSERT` trigger firing per row during data load is exactly
 *      the performance/correctness hazard `pg_dump` avoids by keeping
 *      triggers in post-data; the same reasoning applies verbatim to SQL
 *      Server).
 *   2. Grouping functions/procedures/views with triggers in one
 *      "programmable objects" band, ordered after data, means one
 *      consistent rule ("behavior after structure and data") instead of
 *      views/functions in one section and procedures/triggers in another
 *      for no functional reason.
 *   Real cross-references among these four kinds (via
 *   `MssqlDatabase.objectDependencies`, from `sys.sql_expression_dependencies`)
 *   still take priority over this default ordering — see `planner.ts` — so
 *   this list only matters as the tie-break when no such reference was
 *   discovered.
 */
const SECTION_BY_OBJECT_TYPE: Record<ArchiveObjectType, DumpSection> = {
  schema: 'pre-data',
  sequence: 'pre-data',
  table: 'pre-data',
  tableData: 'data',
  sequenceState: 'data',
  primaryKey: 'post-data',
  uniqueConstraint: 'post-data',
  function: 'post-data',
  defaultConstraint: 'post-data',
  checkConstraint: 'post-data',
  index: 'post-data',
  foreignKey: 'post-data',
  view: 'post-data',
  procedure: 'post-data',
  trigger: 'post-data',
};

const SECTION_PRIORITY: Record<DumpSection, number> = {
  'pre-data': 0,
  data: 1,
  'post-data': 2,
};

/**
 * Priority relative to other entries in the *same* section; lower sorts
 * first. Only used as a tie-break among entries with no discovered
 * dependency relationship to each other (see the module doc above).
 *
 * Two orderings here are load-bearing, not arbitrary:
 *
 * - `index` (4) sorts before `foreignKey` (7). A foreign key's referenced
 *   columns need a `PRIMARY KEY`, a `UNIQUE` constraint, **or** a
 *   standalone unique index to already exist — SQL Server accepts any of
 *   the three as a valid `REFERENCES` target. Putting a foreign key before
 *   the standalone unique index it might rely on would make the restore
 *   fail outright, so this package does not just mirror a source tool's
 *   "constraints, then foreign keys, then indexes" listing order where
 *   that would put indexes *after* foreign keys.
 * - `function` (2) sorts before `defaultConstraint`/`checkConstraint`
 *   (3, 4). A `CHECK`/`DEFAULT` expression may call a scalar UDF
 *   (`CHECK (dbo.IsValidCode(Code) = 1)`), and SQL Server validates that
 *   the function exists at the moment the constraint is added — unlike
 *   stored procedures/triggers, which get deferred name resolution.
 *   `procedure` has no such requirement (nothing about to be created here
 *   is validated against a stored procedure's existence), so it stays
 *   later, alongside `view`, closer to `trigger`.
 */
const OBJECT_PRIORITY_WITHIN_SECTION: Record<ArchiveObjectType, number> = {
  schema: 0,
  sequence: 1,
  table: 2,
  tableData: 0,
  sequenceState: 1,
  primaryKey: 0,
  uniqueConstraint: 1,
  function: 2,
  defaultConstraint: 3,
  checkConstraint: 4,
  index: 5,
  foreignKey: 6,
  view: 7,
  procedure: 8,
  trigger: 9,
};

export function assignDumpSection(objectType: ArchiveObjectType): DumpSection {
  return SECTION_BY_OBJECT_TYPE[objectType];
}

export function dumpSectionPriority(section: DumpSection): number {
  return SECTION_PRIORITY[section];
}

export function archiveObjectPriority(objectType: ArchiveObjectType): number {
  return OBJECT_PRIORITY_WITHIN_SECTION[objectType];
}

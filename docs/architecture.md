# Architecture

`dbgate-mssql-dumper` is a standalone, client-agnostic SQL Server dump/restore
library for Node.js. It is architecturally modeled on `dbgate-pg-dumper`
(connection abstraction, normalized model, archive planning, plain-SQL
rendering as separate layers) but every layer is redesigned for SQL Server's
own catalog, object model, and restore semantics rather than adapted from
PostgreSQL concepts that don't apply. It does not import any DbGate runtime
package; the optional `dbgate-mssql-dumper/tedious` entry point is the only
place a Node.js SQL Server driver is referenced.

## Pipeline overview

```
MssqlConnection(Input)
        │
        ▼
introspectMssql()          → MssqlIntrospectionResult { database, version, capabilities, diagnostics }
        │
        ▼
inspectDumpArchive()        → DumpArchiveInspection { entries (topo-sorted), diagnostics, cycles, droppedPreferenceEdges }
        │
        ▼
renderPlainSql()             → PlainSqlRenderResult { bytesWritten, renderedDumpIds, skippedDumpIds, warnings }
        │
        ▼
DumpWriter (Stream/String)
```

`dumpMssql()` in `src/api/` composes exactly this pipeline, acquiring **one**
physical connection up front and passing it to both `introspectMssql` and
data export (see "Why one physical session" below) rather than letting each
stage acquire its own. Each stage is still independently usable and
independently testable: `renderPlainSql` is a pure function of a
`MssqlDatabase` model and a `DumpArchiveInspection`, and never touches the
network; `inspectDumpArchive` is a pure function of a `MssqlDatabase` and a
selection; only `introspectMssql` (and the data-export and restore
functions) require a live `MssqlConnection`.

Table row data is planned by the archive (`tableData` entries) but streamed
by a separate function, `exportTableDataAsInserts` (in `src/data/`), which
requires a live connection. Calling `renderPlainSql` directly still only
renders schema objects from the static model and reports selected
`tableData`/`sequenceState` entries as warnings, so plain-SQL rendering
never implicitly requires a database round-trip mid-render; `dumpMssql`
bridges the two via `PlainSqlRenderRequest.onDataEntry` (see "Plain SQL
rendering" below), so its own output still interleaves real row data at
the correct position in the archive's topological order, not as a
separately-ordered second pass.

## Connection abstraction

The core package depends on `MssqlConnection` (`src/connection/types.ts`),
not on a particular driver:

- `query(query, signal?)` — buffered, parameterized query execution.
  `query.timeoutMs`, when set, applies a statement-level timeout; adapters
  that cannot honor it per-statement may ignore it.
- `stream(query, options?)` — async-iterable row streaming, for data export
  and any future large-result introspection query. `options.batchSize` is a
  backpressure high-water mark: adapters that support it (Tedious does)
  suspend the underlying result-set flow once this many rows are buffered
  ahead of the consumer and resume it once the buffer drains, so an
  unconsumed multi-million-row result never accumulates unboundedly in
  memory.
- `cancel()` — best-effort cancellation of the in-flight statement.
- `getTransactionStatus?(signal?)` — optional; SQL Server has no public
  session-level transaction-status API comparable to PostgreSQL's, so
  adapters that can approximate it (e.g. via `@@TRANCOUNT`/`XACT_STATE()`)
  implement it and callers must treat it as best-effort.
- `execBatch?(sql, signal?)` — optional; executes `sql` as one genuine T-SQL
  batch (no parameter binding), distinct from `query()`. On the Tedious
  adapter this is the difference between `execSqlBatch` (what `execBatch`
  calls) and `execSql` (what `query()` calls, routed through
  `sp_executesql`) — see "Execution" under "Restore" below for why
  `restoreSqlDump` specifically needs the former. Adapters that cannot
  distinguish the two may omit it; callers fall back to `query()`.

`MssqlConnectionSource` represents anything that must be _acquired_ to get one
physical connection (a pool). `acquireMssqlConnection()` normalizes a direct
connection or a source into one `{ connection, release }` pair; a direct
connection's `release` is a no-op, matching the rule that this library never
closes a connection it did not create.

### Why one physical session, not a pool interface directly

SQL Server settings (`SET` options), `@@TRANCOUNT`, temp tables, and
`SESSION_CONTEXT` are all connection-scoped. Introspection and any future
snapshot-consistent dump must run every statement against the same physical
session; routing through a generic pool `query()` could silently hand
different statements to different backend connections. This is the same
reasoning `dbgate-pg-dumper` documents for PostgreSQL, and it applies
identically here.

### Transaction/session lifecycle

`beginMssqlSession()` (`src/connection/session.ts`) is the SQL Server
analogue of `dbgate-pg-dumper`'s `DumpSessionManager`, built entirely on
plain `connection.query()` calls rather than dedicated interface methods —
`MssqlConnection` itself stays at four members. It supports the same three
`transactionMode`s as `dbgate-pg-dumper` (`managed`/`existing`/`none`), with
SQL Server-appropriate mechanics rather than assumed PostgreSQL semantics:

- **`managed`** (default) requires the connection to report `idle` (via
  `getTransactionStatus`, or `unknown` when unimplemented — refused for the
  same reason as an actually-unknown status, since a nested
  `BEGIN TRANSACTION` would be silently accepted by SQL Server and only the
  outermost `COMMIT`/`ROLLBACK` would actually end it), then issues
  `SET TRANSACTION ISOLATION LEVEL <level>;` followed by
  `BEGIN TRANSACTION;`, and owns the resulting `commit()`/`rollback()`.
- **`existing`** requires the connection to already report `in-transaction`
  and never issues `BEGIN`/`COMMIT`/`ROLLBACK` itself — ownership stays with
  the caller.
- **`none`** issues no transaction statements at all and provides no
  cross-query consistency guarantee.

SQL Server has no equivalent of PostgreSQL's `REPEATABLE READ READ ONLY`
transaction modifier or exported snapshot identifiers, so the isolation
level held for the session's duration is the only consistency lever
available. The default is `REPEATABLE READ`, which is always available and
takes shared read locks for the duration of the transaction; `SNAPSHOT`
(non-blocking, versioned reads — the closer analogue of PostgreSQL's
`REPEATABLE READ`) can be requested explicitly via `isolationLevel`, but
requires `ALLOW_SNAPSHOT_ISOLATION ON` at the database level, which this
library cannot assume or set on the caller's behalf. `commit()`/`rollback()`
are idempotent (a second call is a no-op) and take their own optional
`AbortSignal`, deliberately independent of the signal that triggered the
rollback in the first place — issuing `ROLLBACK TRANSACTION` through a
signal that is already aborted would make cleanup itself throw before the
rollback statement is ever sent.

### Tedious adapter

`dbgate-mssql-dumper/tedious` (`src/tedious.ts`) adapts a caller-owned,
already-connected `tedious.Connection`. It is the only file in the package
that imports `tedious`, and `tedious` is an optional peer dependency — nothing
in `dbgate-mssql-dumper`'s main entry point pulls it in. The adapter:

- maps `MssqlQueryParameter` values to `tedious.TYPES` (using an explicit
  `sqlType` name when given, otherwise inferring one from the JS value's
  type);
- turns tedious's event-based `Request` (`row`, `columnMetadata`, `error`,
  the completion callback) into a buffered `query()` promise or a `stream()`
  async generator, using an internal wake/queue pattern so `stream()` can be
  consumed with ordinary `for await`;
- applies `query.timeoutMs` via `request.setTimeout(...)`;
- wires `AbortSignal` to `connection.cancel()`;
- declares its own minimal structural types for `tedious`'s row/column-
  metadata shapes rather than importing them, because `tedious`'s own public
  `.d.ts` does not export a `ColumnMetadata`/row-column type — its `row`
  and `columnMetadata` listeners are typed effectively as `any`/internal at
  the package boundary.

**Streaming backpressure** uses `tedious.Request`'s own `pause()`/`resume()`
(a per-request control tedious exposes precisely for this purpose — pausing
stops the TDS row flow itself, tedious emits no further `row` events at all
while paused, rather than merely a hint) instead of buffering every row into
an array and instead of the `PassThrough`-stream approach
`dbgate-plugin-mssql`'s `tediousReadQuery` uses (a plain Node object-mode
stream gets Node's own backpressure via `Readable`/`Writable` water marks,
but tedious does not write into one in `tediousReadQuery`; it push- writes
every row into the `PassThrough` as fast as rows arrive and relies on the
stream's internal buffer, which is unbounded for object-mode streams unless
the reader is also draining it promptly). This adapter instead tracks its
own small in-memory queue directly against tedious's request-level flow
control: once the queue reaches `options.batchSize` (default 50) it calls
`request.pause()`; once the consumer has drained the queue back down to half
that, it calls `request.resume()`. If the consumer stops iterating early
(`break`, or an error unwinding the `for await`), the generator's `finally`
cancels the request outright and resumes it first if still paused, so
nothing is left in a stuck-paused state.

A pool-source adapter (comparable to `dbgate-pg-dumper`'s `PgPoolConnectionSource`)
is deliberately not included yet: `tedious` has no first-party pool, and
third-party pools (`tedious-connection-pool`, `generic-pool`) vary enough in
shape that wrapping one prematurely would bake in an unvalidated interface.
A minimal `connectTedious(config)` convenience creator is included instead —
it establishes one new `tedious.Connection`, adapts it, and returns a
`close()` alongside it. It lives entirely in the optional adapter module, so
it does not add a `tedious`-shaped concept to the core package's own API;
`fromTediousConnection()` (wrapping a connection the caller already
connected, and never closing it) remains the primary, dependency-light entry
point.

## Version and capabilities

`detectMssqlVersion()` reads `SERVERPROPERTY('ProductVersion'|'ProductLevel'|'EngineEdition')`
only — never `@@VERSION` string parsing, which is locale-dependent and not
machine-parseable across editions. `EngineEdition` is mapped to a closed
`MssqlEngineEdition` union (`standard`, `enterprise`, `azure-sql-database`,
...) per Microsoft's documented numeric codes.

`detectSourceCapabilities()` derives a `SourceCapabilities` flag set once from
the numeric version: sequences (2012+), memory-optimized tables (2014+),
temporal tables/JSON functions/Always Encrypted (2016+), graph tables
(2017+), native `JSON` type (2025+). Azure SQL Database/Managed
Instance/Synapse/Edge are treated as always current, since Azure tracks the
latest on-premises feature set continuously rather than versioning by major
release.

`src/compatibility/` keeps _target_ capability checking (`checkTargetCompatibility`)
as a distinct concept from _source_ capability detection, even though both
are today pure functions of the same `MssqlVersion` shape: a source's
capabilities describe what its catalog may contain; a target's describe what
it can accept on restore. Keeping them separate avoids conflating "what did
we read" with "what can we write" as the two inevitably diverge (e.g. once
downgrade/compatibility-level transformations are added).

## Normalized model

`src/model/` defines the catalog shape independent of how it was obtained:
`MssqlDatabase` is a set of independent, flat collections (`schemas`,
`tables`, `views`, `routines`, `triggers`, `sequences`, `primaryKeys`,
`uniqueConstraints`, `foreignKeys`, `checkConstraints`, `defaultConstraints`,
`indexes`) rather than a nested tree. This mirrors SQL Server's own catalog
views (`sys.tables`, `sys.columns`, `sys.foreign_keys`, ...), which are
themselves flat and joined by `object_id`/`schema_id`, and keeps archive
planning free of implicit parent/child traversal — exactly the design
`dbgate-pg-dumper` uses for the same reason.

Columns are **not** independent archive entries (unlike `dbgate-pg-dumper`,
where PostgreSQL's `ADD COLUMN`-based catalog encourages it): a T-SQL
`CREATE TABLE` always carries its full column list inline, so there is no
restore-ordering question for individual columns to answer. Constraints,
indexes, triggers, and table data are independent entries because SQL Server
restore scripts conventionally add them via separate `ALTER TABLE`/`CREATE
INDEX`/`CREATE TRIGGER` statements after the table exists.

## Catalog introspection

`introspectMssql()` (`src/introspection/introspect.ts`) loads schemas,
tables (with columns), primary/unique/check/default constraints, foreign
keys, independent indexes, sequences, views, routines, and triggers. Each
catalog concern lives in its own module under `src/introspection/catalog/`
(`tables.ts`, `columns.ts`, `foreignKeys.ts`, ...); `introspect.ts` only
orchestrates them. Each module targets independent SQL Server system
catalogs (`sys.tables`, `sys.columns`, `sys.types`, `sys.identity_columns`,
`sys.computed_columns`, `sys.default_constraints`, `sys.key_constraints`,
`sys.check_constraints`, `sys.foreign_keys`, `sys.foreign_key_columns`,
`sys.indexes`, `sys.index_columns`, `sys.sequences`, `sys.views`,
`sys.sql_modules`, `sys.triggers`, plus a handful of `OBJECTPROPERTY`/
`SERVERPROPERTY` calls) written independently for this package — no DbGate
runtime code is imported or reused, though `dbgate-plugin-mssql`'s
`MsSqlAnalyser.js` and its SQL files were read as prior art for which
catalogs answer which questions.

### Bulk queries, not per-table loops

Every catalog module issues a small, fixed number of queries regardless of
how many tables/objects exist: one (or two, for a header-plus-detail shape
like foreign keys or indexes) bulk `SELECT`, never one query per table. Row
relationships — which column belongs to which table, which index row
belongs to which index — are assembled afterward in memory by matching
`object_id`s (and `index_id`s, for index columns) that a previous query
already returned, the same "bounded bulk queries, assembled in memory"
approach `dbgate-pg-dumper` uses for PostgreSQL.

### Selection is applied in memory, never in SQL text

Schemas, tables, views, routines, and sequences are always read from their
catalog view in full first (every schema, every table, regardless of
selection), and _then_ filtered in memory with the exact same
`isSchemaSelected`/`isTableSelected` functions the archive planner uses.
A caller-supplied schema or table name is therefore never interpolated into
catalog SQL at all — selection never reaches SQL text. The only values that
do scope a query are `object_id` integers the package already read back
from a previous catalog query in the same run; even those are never
string-formatted into the query. They travel as one bound parameter (a
JSON-encoded array), unpacked server-side with `OPENJSON` and cast to
`int`, via `objectIdFilter()` in `catalog/objectIdFilter.ts`:

```sql
WHERE t.object_id IN (SELECT CAST(value AS int) FROM OPENJSON(@tableIds))
```

This is what keeps column/constraint/index/trigger loading a single bulk
query scoped to "the tables that matter" instead of either a per-table loop
or an always-unfiltered full-database scan.

### Foreign-key dependency closure

A selected table's foreign key can reference a table outside the selection
entirely (a different, excluded schema, for instance). `introspectMssql()`
resolves `refSchemaName`/`refTableName` from an **unfiltered** table
`object_id` map (built before selection is applied), so the reference is
always named correctly; it then adds that referenced table's `object_id` to
the set of tables whose columns get loaded, so the returned
`database.tables` includes it — with columns, but not its own constraints or
indexes, which stay scoped to the originally-selected set. This is
required for, and mirrors, `inspectDumpArchive()`'s own
`includedAsDependency` handling: the planner looks up a foreign key's target
by name in `database.tables`, and that lookup needs to succeed even when the
target was never independently selected.

### Session settings and encrypted/unavailable modules

Views, routines (procedures and functions), and triggers all share one
`loadModules()` call (`catalog/modules.ts`) against `sys.sql_modules`,
scoped to the combined `object_id`s of whichever objects are being loaded.
Besides `definition`, it reads `uses_ansi_nulls` and `uses_quoted_identifier`
directly from `sys.sql_modules` — the exact session settings SQL Server
itself recorded at creation time — onto the model
(`MssqlModuleMetadata`, shared by `MssqlView`/`MssqlRoutine`/`MssqlTrigger`),
rather than assuming a fixed `SET ANSI_NULLS ON` preamble for every object as
a renderer-side default.

`OBJECTPROPERTY(object_id, 'IsEncrypted')` is read explicitly and is the only
signal treated as encryption. A `null` `definition` can also mean the object
has no `sys.sql_modules` row at all (a CLR-backed routine, for example) —
that is a different, non-encryption reason to have no SQL text. Whichever
it is, `introspectMssql()` never invents replacement SQL: `moduleUnavailableDiagnostic()`
reports one of two distinct diagnostic codes —
`encrypted-module-definition-unavailable` or `module-definition-not-found`
— and the model's `definition` stays `null`.

### Programmable object dependencies

`loadProgrammableDependencies()` (`catalog/programmableDependencies.ts`)
reads `sys.sql_expression_dependencies` — restricted to
`referenced_class_desc = 'OBJECT_OR_COLUMN'` — for every selected view,
routine, and trigger in one bulk query, and resolves each row's target
against a combined table/view/routine lookup built earlier in the same
introspection run: first by `referenced_id` (SQL Server's own resolution),
then, since that catalog view is documented to leave `referenced_id` `NULL`
whenever it could not bind the reference (dynamic SQL, some forward
references), by an exact `(referenced_schema_name, referenced_entity_name)`
match against the same lookup. Either resolution path produces one
`MssqlObjectDependency` on `MssqlDatabase.objectDependencies`, carrying
`is_schema_bound_reference` through unchanged — the archive planner (see
"Hard dependencies vs. ordering preferences" above) is what turns that flag
into a hard edge or a mere ordering preference, not this loader. A
reference that resolves to neither path — a system function, something
outside the current selection, or genuinely dynamic SQL — produces an
`unresolved-programmable-dependency` info diagnostic instead of a guessed
edge.

### What is not yet introspected

Procedure/function parameters (`sys.parameters`) are not loaded yet —
`MssqlRoutine.parameters` is always `[]`. Temporal/memory-optimized
table-level flags that are cheap to read alongside the main table query
(`is_memory_optimized`, `durability_desc`, `temporal_type_desc`, the history
table reference) are populated, but there is no separate introspection of
period columns, retention policy, or memory-optimized-specific index/bucket
metadata. Always Encrypted column metadata is not read. These are narrower
gaps than "full catalog introspection is not implemented" (the previous
phase's honest limitation) — the normalized model and every object family
listed above are now real, catalog-backed data.

## Selection

`src/selection/` matches exact, case-sensitive SQL Server identifiers —
never lowercased, never treated as wildcard patterns — because SQL Server
identifier casing is collation-dependent and this library must not guess at
it. By default, `sys`, `INFORMATION_SCHEMA`, `guest`, and the fixed
database-role schemas (`db_owner`, `db_datareader`, ...) are excluded, since
none of them are ever meaningful dump targets. `includeSystemSchemas: true`
opts back in.

## Archive planning

`inspectDumpArchive()` (`src/archive/`) converts a `MssqlDatabase` into
immutable, ordered `ArchiveEntry` objects, independent of SQL text and output
streams — the same separation of concerns `dbgate-pg-dumper` uses. Every
entry carries a deterministic identity and stable `dumpId`, its object type
and section, its dependency edges, its `selectionState` (`'selected'` or
`'dependency'`), and — once a valid order exists — a `sequenceNumber`
recording where it landed. Diagnostics are reported at the inspection level
rather than embedded per-entry, since several diagnostic kinds (a cycle, a
duplicate identity) legitimately concern more than one entry, or none in
particular; each still names the specific entry it concerns through its
`objectReference` where one exists.

Every entry has a canonical identity built from length-prefixed
`(objectType, schemaName, name, parentName, ...extraParts)`
(`createArchiveIdentity`/`createCanonicalIdentity`); a truncated SHA-256
digest of that identity is the entry's stable `dumpId`
(`createDumpId`). Duplicate canonical identities are reported as a
structured `duplicate-archive-identity` diagnostic rather than silently
overwriting an entry.

### Sections, and why views/functions/procedures/triggers are _not_ pre-data

Three sections, in emission order — `pre-data`, `data`, `post-data` — with a
centralized `assignDumpSection`/`dumpSectionPriority`/`archiveObjectPriority`
mapping in `sectionRules.ts`. This is a planning abstraction specific to this
package; SQL Server itself has no archive-section concept.

- **pre-data**: schemas, sequences, tables (with columns inline). Nothing
  here needs anything outside pre-data.
- **data**: `tableData`, and `sequenceState` (a sequence's _current_ value,
  kept separate from its `sequence` pre-data definition — the same split
  `dbgate-pg-dumper` uses between a PostgreSQL sequence's definition and its
  `OWNED BY` ownership, applied here to definition vs. runtime state).
- **post-data**: primary/unique constraints, functions, default/check
  constraints, independent indexes, foreign keys, views, procedures,
  triggers.

A source tool's own object listing order is not treated as authoritative
here, and two placements deliberately depart from the "obvious" pre-data/
post-data split a naive port of `pg_dump`'s section names might suggest:

1. **Views, functions, procedures, and triggers all live in post-data, not
   pre-data.** Two independent reasons converge on this: an `AFTER INSERT`
   trigger firing per row while table data is being bulk-loaded is exactly
   the hazard `pg_dump` avoids by keeping triggers in post-data, and the same
   reasoning applies verbatim to SQL Server; and grouping all four
   "programmable object" kinds into one band ordered after data gives one
   consistent rule ("behavior after structure and data") instead of an
   arbitrary split with no functional basis.
2. **Independent indexes sort before foreign keys within post-data.** SQL
   Server accepts a `PRIMARY KEY`, a `UNIQUE` constraint, _or_ a standalone
   unique index as a valid `REFERENCES` target — not only a named
   constraint. Ordering a foreign key ahead of the standalone unique index
   its target might actually rely on would make the restore fail outright,
   so this package does not mirror a source ordering that lists constraints,
   then foreign keys, then indexes.
3. **Functions sort before default/check constraints within post-data.** A
   `CHECK`/`DEFAULT` expression may call a scalar UDF, and SQL Server
   validates that the function already exists at the moment the constraint
   is added — unlike stored procedures and triggers, which get deferred name
   resolution. Procedures have no such requirement and stay later, next to
   views and triggers.

These three points, and the full priority table, are documented at the
`SECTION_BY_OBJECT_TYPE`/`OBJECT_PRIORITY_WITHIN_SECTION` declarations in
`sectionRules.ts` — read there for the exact numbers. They matter only as
the **tie-break** among entries with no discovered dependency relationship;
a real edge (see below) always takes priority over this default order.

### Foreign keys never block table creation or data loading

Every foreign-key entry depends only on its own table and the referenced
table (both pre-data), never on another foreign-key entry — so no foreign
key can ever end up depending, even transitively, on another post-data
entry. Combined with `data` sorting before `post-data`, this guarantees
every foreign key is created only after all table data has already loaded,
and that mutually referencing foreign keys (`Orders` → `Customers` and
`Customers` → `Orders`) are trivially safe: each depends only on tables, so
there is no cycle to resolve in the first place. A single self-referencing
foreign key (`Employees.ManagerId` → `Employees.Id`) is likewise never a
cycle: both its "own table" and "referenced table" edges resolve to the same
table entry, and `addDependency` only ever records that pair once.

### Hard dependencies vs. ordering preferences

`ArchiveDependency.strength` is `'hard'` (required for a valid restore) or
`'preference'` (a nicer default order, never a correctness requirement).
Structural edges — table→schema, constraint/index/trigger→table, foreign
key→both tables, `tableData`→table, `sequenceState`→sequence,
view/routine/sequence→schema — are always hard.

Cross-references discovered between views, procedures, functions, and
triggers (`MssqlDatabase.objectDependencies`, from
`sys.sql_expression_dependencies` — see "Catalog introspection") get their
strength from SQL Server's own guarantee about the reference:

- **`is_schema_bound_reference = 1`** (`WITH SCHEMABINDING`, or an
  otherwise-enforced reference): SQL Server itself blocks a `DROP` or
  incompatible `ALTER` of the referenced object while the dependent exists.
  Trustworthy enough to be a **hard** edge.
- **`is_schema_bound_reference = 0`** (an ordinary reference): not enforced
  or validated after creation — the target could be renamed, dropped, or the
  reference could be to dynamic SQL that this catalog view mis-resolves.
  Used only as an **ordering preference**.

This is the "deterministic fallback" for incomplete SQL Server dependency
metadata the archive layer is responsible for: `sys.sql_expression_dependencies`
is documented to leave `referenced_id` `NULL` when it cannot bind a
reference (dynamic SQL, certain forward references). The introspection
loader (`catalog/programmableDependencies.ts`) retries by exact
schema-qualified name against every table/view/routine/trigger it already
knows about before giving up; anything still unresolved becomes an
`unresolved-programmable-dependency` diagnostic there. The archive planner
adds a second, independent check for the same failure mode at its own
layer: a discovered dependency whose _target_ was resolved by
introspection but excluded from _this particular archive_ (by selection, or
because the source database simply has no matching entry in a hand-built
test model) also produces an `unresolved-programmable-dependency`
diagnostic and no edge — it is never invented at either layer.

### Cycle detection and resolution

Cycles are resolved _before_ any topological sort runs, so the sort itself
never has to guess which edge "caused" a cycle:

1. Find every strongly connected component (Tarjan's algorithm) of size
   greater than one, or a self-loop, in the current edge set.
2. For each such component, if any of its _internal_ edges are
   preference-strength, drop all of them — removing an edge that carries no
   correctness requirement can never make a restore invalid — and recompute
   from step 1.
3. Repeat until either no non-trivial component remains (success) or an
   iteration finds only hard-only components left (failure).

A hard-only component is reported as an `ArchiveCycle` (member `dumpId`s)
and an `archive-dependency-cycle` error diagnostic; the inspection is
`valid: false`, and — matching `dbgate-pg-dumper`'s "no executable order for
an invalid archive" rule — `entries` still lists every would-be entry, but
in a deterministic fallback order (by section, then object priority, then
name) with no `sequenceNumber`, never a claim of a valid restore order.
Each preference edge actually dropped is reported as a
`BrokenPreferenceEdge` and a `preference-cycle-broken` info diagnostic, even
when the overall result is valid — dropping one is always safe, but it is
never silent.

Once the graph is acyclic, Kahn's algorithm produces the final order; ties
among simultaneously ready entries are broken by `(section, objectPriority,
schemaName, name, dumpId)`, so array/object iteration order in the input
`MssqlDatabase` never affects the output — the same determinism guarantee
`dbgate-pg-dumper` provides, verified here by a test that runs the same
model through twice with several of its arrays reversed and checks for an
identical `dumpId` sequence.

### Selection outside the archive: dependency inclusion and strict mode

A selection can exclude a table that a selected object still hard-depends on
(most commonly: an included table's foreign key references an excluded
table). By default, the planner pulls the missing schema/table entry in
anyway, sets its `selectionState` to `'dependency'`, and emits an
`included-as-dependency` info diagnostic — so restoring the selected subset
never produces a dangling `ALTER TABLE ... ADD CONSTRAINT FOREIGN KEY`
against an object that was never created. Passing `strictSelection: true`
changes this from an automatic inclusion into a rejection: the same
situation instead produces a `strict-selection-violation` **error**
diagnostic and `valid: false`, matching `dbgate-pg-dumper`'s strict
selection mode — the entry is still present (so the diagnostic can point at
something concrete), but the caller must resolve the conflict rather than
have it silently resolved for them.

### Mode and section filtering

`full` (default), `schema-only`, and `data-only` filter which _sections_ are
included after the full dependency graph is built, then drop any dependency
edge pointing outside the retained set (a `data-only` render assumes its
tables and sequences already exist on the target, so it does not need
`pre-data` in the graph at all). This mirrors `dbgate-pg-dumper`'s
explicit-section-boundary rule: mode boundaries are hard, so a `data-only`
archive never silently pulls in schema definitions.

## Plain SQL rendering

`renderPlainSql()` (`src/renderer/`) is a pure function: `(database, archive
inspection, writer, options) → result`. It never queries the database. For
each entry in `archive.entries` (already topologically sorted), it looks the
matching model object up by `(schemaName, name[, parentName])` via
`buildRenderLookups`, and dispatches to a per-object-type renderer
(`renderTableCreate`, `renderForeignKeyCreate`, `renderIndexCreate`, ...).

Column types are formatted with `formatColumnDataType`: character types
render `(n)`/`(max)`, `decimal`/`numeric` render `(precision,scale)`,
`datetime2`/`datetimeoffset`/`time` render `(precision)`. Views, procedures,
functions, and triggers already carry a full stored definition text (the
introspection equivalent of PostgreSQL's `pg_get_viewdef`/`pg_get_functiondef`)
and are emitted verbatim after a `SET ANSI_NULLS .../SET QUOTED_IDENTIFIER
...` preamble built from that _specific object's_ `uses_ansi_nulls`/
`uses_quoted_identifier` flags (`MssqlModuleMetadata`, read from
`sys.sql_modules` at introspection time — see "Session settings and
encrypted/unavailable modules" above), not a hardcoded `ON`/`ON` assumed for
every object. A `null` flag (no `sys.sql_modules` row was found) still
defaults to `ON`, matching every supported SQL Server version's own default
and what SSMS itself scripts.

Every statement is followed by a `GO` batch separator — required because
`CREATE VIEW`/`CREATE PROCEDURE`/`CREATE FUNCTION`/`CREATE TRIGGER` must be
the only statement in their batch in T-SQL.

`includeDropStatements` emits `DROP ... IF EXISTS` in **reverse** archive
order before creation. Every drop form used (`DROP TABLE/VIEW/PROCEDURE/
FUNCTION/TRIGGER/SEQUENCE/SCHEMA/INDEX IF EXISTS`, `ALTER TABLE ... DROP
CONSTRAINT IF EXISTS`) requires SQL Server 2016 or later; this is the
renderer's implicit minimum target today. `CREATE SCHEMA` has no native
`IF NOT EXISTS` form at all (unlike `DROP SCHEMA IF EXISTS`), so schema
creation is wrapped in an explicit `IF NOT EXISTS (SELECT ... FROM
sys.schemas ...) BEGIN EXEC('CREATE SCHEMA ...') END` guard instead — `CREATE
SCHEMA` cannot be the non-first statement of a conditional block directly, so
it must run through `EXEC` of a string.

`unsupportedFeaturePolicy` (`error` default, or `warn-omit`) governs both a
render function throwing (e.g. a view with no stored definition) and a
renderer returning `null` for a structurally out-of-scope object — today,
that is any index whose `indexType` is not `CLUSTERED`/`NONCLUSTERED`
(columnstore, XML, spatial). `warn-omit` skips the entry and records a
`MssqlDiagnostic`; `error` throws immediately.

### Interleaving real row data via `onDataEntry`

`renderPlainSql` itself is still a pure, connection-free function of the
static model, but `PlainSqlRenderRequest.onDataEntry` lets a caller that
_does_ have a live connection stream a `data`-section entry's real content
at exactly the position the archive's topological order already put it —
after the owning table's definition, before any post-data object that
depends on the table's data being present. When `onDataEntry` is absent, or
returns `false` for an entry it does not handle, that entry falls back to a
`data-not-rendered` warning and is skipped, exactly as before this hook
existed; `dumpMssql` is the only built-in caller that supplies it today (see
"Data export" below), so calling `renderPlainSql` directly and standalone
(as most of this package's own tests do) is unaffected. This keeps
`renderPlainSql`'s "pure function of the model" character intact — it never
imports `connection/` or `data/` types — while still letting the full
`dumpMssql` pipeline produce one continuous, correctly ordered plain-SQL
output instead of two separately-ordered passes (schema, then all data, which
would violate the archive's own post-data-after-data ordering guarantee).

### Header

Every dump starts with the literal marker line `isDumperSqlDump()` checks
for (never changes), followed by whatever source metadata is available and
safe to disclose: database name, collation, compatibility level, source
product version/engine edition (from `PlainSqlRenderRequest.sourceVersion`),
and dump mode (`PlainSqlRenderRequest.mode`) — each line omitted individually
when its value is unavailable, so calling `renderPlainSql` without version/
mode info (as most unit tests do) still produces a valid, if shorter,
header. A timestamp line is added only when `includeTimestamp: true`, for
determinism. Nothing here can leak a secret: `MssqlDatabase` and
`MssqlVersion` never carry connection strings or credentials in the first
place, so there is nothing sensitive reachable from this header's inputs.

Determinism: no timestamps are written unless `includeTimestamp: true`;
identifier quoting, keyword-case, indentation, and line endings are all
explicit renderer options, never environment/locale-dependent.

## Identifier quoting and literals (`src/security/`)

SQL Server identifiers are bracket-quoted (`[name]`, with `]` doubled to
escape it), not double-quoted as in PostgreSQL, and quoting does not affect
case-folding the way it does in PostgreSQL (SQL Server never folds unquoted
identifiers to a canonical case; case sensitivity is purely a collation
property). `quoteIdentifier` leaves an identifier unquoted only when it
matches the plain regular-identifier grammar and is not one of the T-SQL
reserved keywords; `quoteAllIdentifiers` forces bracketing everywhere.

String literals use ordinary `'...'` or Unicode `N'...'` (doubling embedded
`'`); `renderSqlLiteral` always emits the `N'...'` form for JS strings, since
it is unconditionally valid regardless of the target column's Unicode-ness
and safe for any non-ASCII content irrespective of the database's code page
— unlike PostgreSQL, SQL Server has no single "always correct" string
literal form independent of column type, so this package picks the one that
is always accepted rather than trying to infer per-column Unicode-ness at
literal-rendering time. Binary values render as `0x`-prefixed hex; dates
render as ISO-8601 `'...'` strings, which SQL Server parses unambiguously
regardless of session `LANGUAGE`/`DATEFORMAT` settings.

`src/security/sensitive.ts` provides `isSensitiveOptionName`/
`redactSensitiveText`/`redactSensitiveSubstring` for keeping connection
secrets (passwords, tokens, connection strings) out of diagnostics and error
messages; this is deliberately simpler than `dbgate-pg-dumper`'s
async `protectSensitiveValue` — no encryption/hashing is performed today,
only masking.

## Data export

`exportTableDataAsInserts()` (`src/data/insertExport.ts`) requires a live
connection and streams one table's rows through `connection.stream()`,
never buffering the full table — at most one batch's worth of rendered row
tuples is held in memory at a time (see "Batching" below). `dumpMssql`
supplies it (via `PlainSqlRenderRequest.onDataEntry`) for every `tableData`
archive entry when `mode` is `'full'` or `'data-only'`; `sequenceState`
entries are not yet handled this way and still fall back to the renderer's
default warning (see "What is intentionally out of scope" below).

### Column planning: computed, generated, and unsupported columns

When `request.table: MssqlTable` is supplied (as `dumpMssql` always does,
since it already has one from introspection), `classifyColumnForExport()`
(`src/data/columnValueRenderer.ts`) partitions every column before the
first row is even fetched:

- **`computed`** — never a valid `INSERT` target; SQL Server derives the
  value itself.
- **`generated`** (`rowversion`/`timestamp`) — server-maintained; `INSERT`
  rejects an explicit value for these outright.
- **`unsupported`** (`sql_variant`, `xml`, `geography`, `geometry`,
  `hierarchyid`) — excluded defensively rather than risking a corrupted or
  misleading literal: `sql_variant`'s runtime type is not known without an
  extra query per value, and the others need type-specific constructor
  syntax (`geography::STGeomFromText(...)`, etc.) this package does not
  generate. Each exclusion produces an `unsupported-column-type` warning
  diagnostic naming the column — never silent data loss.
- everything else is **`insertable`**.

Only `insertable` columns are selected from the source table at all
(`SELECT [col1], [col2], ... FROM ...`, not `SELECT *`) and only they appear
in the generated `INSERT`'s column list. If a table has _no_ insertable
columns (every column computed/generated/unsupported), there is nothing to
select or bind — a plain `SELECT COUNT(*)` supplies the row count instead,
and the table's data becomes that many `INSERT INTO ... DEFAULT VALUES;`
statements, which is valid T-SQL for exactly this case and still recreates
the right number of rows.

Without a `table` model, `exportTableDataAsInserts` falls back to a plain
`SELECT *` with column order taken from the first streamed row's own keys
(relying on `MssqlConnection`'s contract that every selected column is
present as a key on every row) and the JS-runtime-type-only
`renderSqlLiteral` for every value — no column is excluded and no
type-specific formatting applies. This fallback exists so data export never
strictly _requires_ introspection to have run, but callers that have a
table model should always supply it.

### Type-aware value rendering

`renderColumnValue()` renders each `insertable` column's value using its
actual SQL Server type rather than only the JS runtime type, so it can make
distinctions `renderSqlLiteral` structurally cannot:

- `char`/`varchar`/`text` use plain `'...'` quoting; `nchar`/`nvarchar`/
  `ntext` use `N'...'` — both correctly handle embedded `'`, embedded CR/LF,
  and Unicode content; only the unicode-prefix choice differs.
- Exact numeric types (`decimal`/`numeric`/`money`/`smallmoney`, and the
  integer family) and approximate numeric types (`float`/`real`) all render
  through `formatFiniteNumber()`, which expands JS's exponential notation
  (used for magnitudes `>= 1e21` or `< 1e-6`) into a plain digit string —
  T-SQL's exact-numeric literal grammar does not accept exponential
  notation at all, so this is a correctness fix, not cosmetic. A
  driver-supplied numeric **string** (safe, digit-only text) is emitted
  verbatim and unquoted rather than parsed into a JS number first — the
  only representation that can carry more precision than an IEEE 754 double
  without this package reintroducing loss of its own; a string that is
  _not_ safe numeric text falls back to being quoted, defensively.
- `date` uses only the ISO date portion; `datetime`/`smalldatetime` use the
  existing millisecond-precision ISO literal; `datetime2`/`time`/
  `datetimeoffset` use `quoteHighPrecisionDateTimeLiteral()`, which recovers
  sub-millisecond precision from a non-enumerable `nanosecondsDelta`
  property the Tedious adapter's value parser attaches to `Date` objects
  for these types (up to 7 fractional digits total), instead of silently
  truncating to JS `Date`'s native millisecond precision.
- `binary`/`varbinary`/`image` render as `0x`-prefixed hex;
  `uniqueidentifier` as a quoted GUID string.
- Any value/type combination this function does not specifically recognize
  falls back to the generic `renderSqlLiteral` rather than throwing — a
  classification gap degrades gracefully instead of aborting an export
  partway through a table.

### Known driver limitations, reported rather than hidden

Two SQL Server type behaviors cannot be fully recovered through the
Tedious adapter, and `columnExportDiagnostics()` reports both explicitly
instead of exporting a value that looks correct but is not:

- **`decimal`/`numeric` above ~15 significant digits.** Tedious's value
  parser divides by `10^scale` in floating point (`readNumeric()` in
  `tedious/lib/value-parser.js`), always producing a JS `number` (an IEEE
  754 double). This package's own rendering introduces no _additional_
  rounding beyond what the driver already applied, but it cannot recover
  precision the driver has already lost. A `possible-precision-loss`
  warning is emitted once per affected column.
- **`datetimeoffset` always loses its original UTC offset.** Tedious's
  `readDateTimeOffset()` reads the offset bytes off the wire but discards
  the parsed value, constructing the returned `Date` via `Date.UTC(...)`
  unconditionally. The point in time is preserved exactly; the _originally
  stored display offset_ is not recoverable at all through this adapter.
  Exported values are rendered with an explicit `+00:00` suffix — honest
  about being that UTC instant, not a claim about the source row's original
  offset — and a `datetimeoffset-normalized-to-utc` warning is emitted once
  per such column.

### Batching

Data export batches at two nested levels, because a statement and a batch
cost different things when the dump is restored.

Rows are first accumulated into one multi-row `INSERT INTO ... (cols) VALUES
(...), (...), ...;` statement (`TableDataExportOptions.maxRowsPerStatement`,
default 100) rather than one `INSERT` per row, subject to two independent
caps: row count, clamped to SQL Server's own hard limit of 1000 rows per
`VALUES` table-value-constructor regardless of what is requested (exceeding
it would produce a statement that fails at restore time), and rendered
byte size (`maxStatementBytes`, default 4,000,000), so a run of unusually
wide rows cannot produce one unreasonably large statement even while under
the row-count cap. Only the current statement's tuples are held in memory —
the underlying `connection.stream()` call is never collected into an array
first.

Those statements are then packed into `GO`-terminated batches
(`maxRowsPerBatch`, default 10,000 rows; `maxBatchBytes`, default 8,000,000
bytes of batch text), rather than one `GO` per statement. The two levels map
onto the two costs a restore pays:

- **A statement is an implicit transaction.** Its size sets how many
  transaction-log commits the table costs — a million rows is 10,000 commits
  at the default, a million at `maxRowsPerStatement: 1`. Counter-intuitively,
  raising it does _not_ pay: measured against SQL Server 2022 (200k narrow
  rows, restore timed end to end, repeated and interleaved), 1000-row
  statements restored consistently slower than 100-row ones — packed into
  batches or not — because a large `VALUES` table-value-constructor costs
  more to compile and materialize than the commits it saves. Hence a default
  well below the 1000-row ceiling.
- **A batch is a client/server round trip.** `restoreSqlDump` executes
  batches strictly sequentially (see "Restore" below), so batch count is a
  latency multiplier, and on a remote server it dominates restore time. This
  is where the savings actually were: packing statements into batches cut a
  50k-row restore's median wall time by about a third even against a _local_
  server (500 batches down to 5), with no change to the statements
  themselves.

Both batch caps are checked _before_ a statement is written rather than
after, so they are genuine upper bounds and not limits a batch may overshoot
by one statement; a batch always holds at least one statement, however large
that single statement is on its own. `maxBatchBytes` is exact (the byte
accounting includes the separators and terminators actually written, and is
computed from parts already measured — never by re-scanning assembled
statement text) and defaults to an eighth of the 64 MiB
`SqlBatchParserOptions.maxBatchBytes` a restore accepts. `SET IDENTITY_INSERT`
statements ride along in whatever batch is open without counting toward its
row cap, and the final batch is closed once, after the closing `OFF` — a
table that emitted no statements at all produces no stray `GO`.

### Identity columns and error safety

An identity column present among the `insertable` set wraps the whole
export in `SET IDENTITY_INSERT [schema].[table] ON;` / `... OFF;`. If an
error occurs mid-export (a dropped connection, a cancelled signal), the
`OFF` statement is still emitted best-effort before the error propagates —
otherwise the _generated dump file_ itself would be left with an unbalanced
`ON` with no matching `OFF`, which would affect every unrelated `INSERT`
statement executed later in the same restore session, not just this table's.
A secondary failure while emitting that best-effort `OFF` (e.g. the output
stream itself is broken) is swallowed rather than masking the original
error.

### Progress

`onProgress` receives an `exporting-data` event after every row (`message`:
`"schema.table"`, `objectsProcessed`: the running row count for that table,
`bytesWritten`: the writer's cumulative byte count) — not only per batch —
so a caller can report "rows written" and "bytes so far" at row
granularity even though the underlying SQL is batched.

`COPY`/bulk-protocol-based data loading (SQL Server's `BULK INSERT`/`bcp`
equivalent of PostgreSQL's `COPY`) is intentionally not implemented: the
project requirements call for plain `.sql` output only at this stage, and
`INSERT` statements are portable across any SQL Server client, whereas `BULK
INSERT` requires server-side file access or a TDS bulk-load session tedious
itself would need to originate.

## Restore

`restoreSqlDump({ connection, source, options?, signal?, progress? })`
(`src/restore/`) restores a plain-SQL dump using only the `MssqlConnection`
abstraction — no `sqlcmd`, SMO, `bcp`, or external process is ever invoked.
It is a real lexer over `GO`-separated batches followed by sequential
execution, not a naive line-splitter: `GO` is only ever recognized as a
batch separator when it is genuinely standalone, outside every string,
bracketed/double-quoted identifier, and comment. `PRINT 'GO'` and a `GO`
inside a comment never split a batch, and neither does a `GO` inside a
multi-line string/bracket/comment — a case the previous, line-only
implementation could get wrong.

### The batch parser (`src/restore/batchParser.ts`)

`SqlBatchParser` is an incremental state machine: feed it text via `push()`
(any number of times, in any chunk size) and call `finish()` once at end of
input. It tracks one lexer mode — `normal`, inside a `'...'` string, inside
a `"..."` string/identifier, inside a `[...]` bracketed identifier, or
inside a (possibly nested — SQL Server, unlike ANSI SQL, allows `/* /* */
*/`) block comment — across line and chunk boundaries, correctly handling
doubled-quote (`''`, `]]`) escapes. Line comments (`--`) never need a
persisted mode since they always end at that physical line's own end. A
`GO` line is recognized only when the lexer is in `normal` mode _at the
start of that line_ and the line matches `^\s*GO(?:\s+(\d+))?\s*(?:--.*)?$`
(case-insensitive) — the same convention `sqlcmd`/SSMS use, including the
optional `GO <n>` repeat-count form.

`parseSqlBatches(sql, options?)` is a convenience wrapper over one
in-memory string; `streamSqlBatches(source, options?, signal?)` is the
streaming form `restoreSqlDump` actually uses, accepting a `string`, a
`Readable`, or any `AsyncIterable<string | Buffer | Uint8Array>` (`Buffer`/
`Uint8Array` chunks are decoded as UTF-8 through a persistent
`node:string_decoder` `StringDecoder`, so a multi-byte character split
across two chunks is never corrupted). At most one in-progress batch's
accumulated text, plus one pending partial line, is held in memory at a
time — the whole input is never buffered. A single batch must still be sent
to the server whole, so `options.maxBatchBytes` (default 64 MiB) bounds how
much of a pathological input with no `GO` lines at all the parser will
accumulate before giving up (`BatchTooLargeError`) rather than growing
unboundedly.

### Typed errors (`src/restore/errors.ts`)

Every error `restoreSqlDump`/the parser throws intentionally extends
`RestoreError`:

- **`SqlBatchParseError`** (parser errors) and its subclasses —
  **`MalformedSqlDumpError`** (a string/bracket/comment left open at end of
  input), **`InvalidGoRepeatCountError`** (`GO 0`, `GO abc`, or a count
  above `options.maxGoRepeatCount`, default 100,000), **`BatchTooLargeError`**,
  and **`UnsupportedSqlcmdDirectiveError`** — are always fatal and thrown
  out of `restoreSqlDump`: a parse failure means the batch boundaries
  themselves are not trustworthy, so nothing after the failure point can be
  safely executed either, regardless of `options.stopOnError`.
- **`RestoreExecutionError`** is scoped to one batch that parsed correctly
  but failed on the server. Unlike the parser errors, this is _not_ thrown
  from `restoreSqlDump` — its data (`batchIndex`, `location`, a redacted
  `sqlPreview`, and a redacted `message`) is what populates
  `SqlDumpRestoreResult.errors`, and — unless `options.stopOnError` (the
  default) — restoration continues with the next batch. This mirrors every
  other stage in this package (`dumpMssql`, `exportTableDataAsInserts`,
  `renderPlainSql`): a recoverable, per-item problem is returned as
  structured data, not thrown.
- Cancellation reuses the existing `OperationCancelledError` (`src/utils/errors.ts`):
  an aborted `AbortSignal` makes `restoreSqlDump` return
  `{ cancelled: true, ... }` with whatever partial counts had already
  accumulated, the same convention every long-running function in this
  package follows, rather than surfacing a thrown exception to distinguish
  from a crash.

### `sqlcmd` directives: detected and rejected, not implemented

`sqlcmd`/SSMS preprocess a script — expanding `:setvar`/`$(Variable)`
substitutions, running `:r` file includes, executing `!!`/`:!!` shell escapes —
_before_ any batch ever reaches SQL Server. `restoreSqlDump` executes
batches directly against the connection and implements no such
preprocessor. Rather than silently forwarding an unresolved
`$(Variable)` token or a `:setvar` line to the server (which would fail
with a confusing native syntax error, or in principle execute as
unintended T-SQL), the parser detects these constructs explicitly and
throws `UnsupportedSqlcmdDirectiveError`:

- A colon-prefixed directive (`:r`, `:setvar`, `:connect`, `:on error`,
  `:!!`, ...) or standard `!!` shell escape is recognized only when it starts in column 1 (no
  leading whitespace) — matching `sqlcmd` itself, and avoiding a false
  positive on indented T-SQL that happens to contain a colon (a `CASE`
  label, a `::` static method reference like `geography::STGeomFromText`).
- A `$(Variable)` token is recognized outside any string/comment/bracket —
  `$` is never a valid leading character of an unquoted T-SQL identifier,
  so this is unambiguous in practice, and a `$(...)`-shaped substring
  _inside_ a string literal (where it is just ordinary data) is correctly
  left alone.

### Supported subset

`restoreSqlDump` targets **plain T-SQL batches, `GO`-separated**: the exact
shape `renderPlainSql` produces, so a package-generated dump round-trips
correctly by construction (verified by the end-to-end test in
`dumpMssql.test.ts`/`restore.test.ts`). Ordinary hand-written SQL Server
scripts restore too, as long as they do not rely on `sqlcmd` scripting
(directives/variable substitution, detected and rejected above) or depend
on a `GO`-alone-on-its-line appearing legitimately inside an unterminated
multi-line string that was never meant to close before end of input (a
lexically pathological case this package has no way to distinguish from a
genuine mistake). This is a documented subset, not a claim of full
`sqlcmd` compatibility.

### Execution

Each batch is executed via `connection.execBatch()` when the adapter
provides it, falling back to `connection.query()` otherwise.
`execBatch` is deliberately distinct from `query()`: on the Tedious
adapter, `execBatch` calls `connection.execSqlBatch()` (a real TDS SQL
batch, matching `sqlcmd`/SSMS exactly), while `query()` calls
`connection.execSql()` (routed through `sp_executesql`). This matters for
restore specifically — `CREATE PROCEDURE`/`CREATE VIEW`/`CREATE FUNCTION`/
`CREATE TRIGGER` must be the only statement in their batch and can behave
differently (or be rejected) inside an `sp_executesql` wrapper, and
batch-scoped constructs (local temp tables, `SET` options meant to persist
for later batches on the same connection) rely on not being sandboxed
inside a nested execution context. `execBatch` also supports no parameter
binding, matching `execSqlBatch`'s own contract — batches from a restored
script are never parameterized. A `GO <n>` batch is executed `n` times in
sequence, each execution counted and tallied independently.

`SqlDumpRestoreResult.rowsRestored` sums `rowsAffected` across every
successfully executed batch. Tedious's own `Request.rowCount` already
accumulates across every `DONE`/`DONE_IN_PROC` token a batch produces (
confirmed by reading `tedious/lib/token/handler.js`), so a data batch
containing several `INSERT` statements — exactly what `dumpMssql`'s own
data batches look like — reports their combined row count without this
package needing to parse or count statements itself. This is a
straightforward sum, not a data-batch-specific heuristic: ordinary DDL
reports 0, so in practice the total reflects rows inserted, but a script
containing its own `UPDATE`/`DELETE` statements would contribute those rows
too.

### Safety: previews and redaction

`RestoreBatchError.sqlPreview` (via `safeSqlPreview`) is always truncated
(200 characters by default) and never a full, potentially large statement.
Both `sqlPreview` and the execution error's `message` are passed through
`redactSecrets()` before being recorded, which blanks the value side of
`PASSWORD =`/`PWD =`/`IDENTIFIED BY` clauses (`'...'` or `N'...'`) — a
failing `CREATE LOGIN`/`ALTER LOGIN`/`CREATE USER` statement, or a driver
error message that happens to echo the failing statement text back, can
therefore never leak the literal credential value into a diagnostic or
error. This is pattern-based, not a full parser, and protects the specific
clauses SQL Server itself uses for credentials — not arbitrary
"looks sensitive" text (see `src/security/sensitive.ts` for the equivalent
guard over connection _options_, as opposed to SQL _text_).

### Progress and cancellation

`progress` receives `parsing` events (one per batch as it is parsed, with
`batchIndex`) interleaved with `executing` events around each batch execution,
including each repetition of a `GO <n>` batch, with a running
`rowsRestored` total. Recognized generated INSERT batches additionally report
their `executionMode` (`bulk-insert` or `sql-fallback`), lifecycle state, schema,
and table so callers can aggregate concise table-level start/finish messages.
A final `finalizing` event closes the stream. `AbortSignal` is
checked before every batch execution and at every chunk boundary while
reading `source`; on cancellation, `restoreSqlDump` returns
`{ cancelled: true, ... }` with whatever had already executed, and the
acquired connection is always released via a `finally` block, regardless of
how the function returns.

`preflightRestore()` (`src/preflight/`) currently only detects the restore
target's version/capabilities ahead of running any statement. Existing-
object conflict detection, schema/role remapping, and dependency validation
against a specific archive (all present in `dbgate-pg-dumper`'s restore
pipeline) are explicitly future work — see below.

## Structured diagnostics, progress, and cancellation

Every stage that can produce a non-fatal problem returns it as a structured
`MssqlDiagnostic { severity, code, message, objectReference? }`
(`src/model/diagnostics.ts`) rather than throwing or logging text — callers
can filter/aggregate/display them without string-parsing. Progress is
reported through typed callbacks (`DumpProgressCallback`/
`RestoreProgressCallback`, `src/utils/progress.ts`) with a closed `phase`
union per operation, not free-form strings.

Every long-running function accepts an `AbortSignal` and, on cancellation,
returns its result shape with `cancelled: true` and whatever partial output/
counts had already been produced, rather than throwing — so a caller
cancelling a large dump/restore gets a well-formed, inspectable result
instead of having to distinguish "cancelled" from "crashed" by exception
type.

## What is intentionally out of scope for this phase

This phase is scaffolding: public interfaces, the connection abstraction,
the Tedious adapter, and working (but intentionally partial) dump/restore/
introspection pipelines. Explicitly deferred:

- **Procedure/function parameter introspection.** `sys.parameters` is not
  read yet; `MssqlRoutine.parameters` is always `[]` (see "Catalog
  introspection" above).
- **Non-`CLUSTERED`/`NONCLUSTERED` indexes.** Columnstore, XML, and spatial
  indexes are detected as unsupported and handled per
  `unsupportedFeaturePolicy`; they are not rendered (though `loadIndexes()`
  does report their `type_desc` verbatim in the model).
- **Deep temporal/memory-optimized/graph-table metadata, Always Encrypted
  column metadata.** The cheap table-level flags (`isSystemVersioned`,
  `historyTable*`, `isMemoryOptimized`, `durability`) are populated from
  `sys.tables`, but period columns, retention policy, memory-optimized
  index/bucket metadata, graph `NODE`/`EDGE` specifics, and Always Encrypted
  key metadata are not introspected.
- **Restore conflict detection and role/schema remapping.** `preflightRestore`
  does not yet check for existing objects on the target or offer schema/
  login remapping.
- **Bulk/native data loading.** Only `INSERT`-statement data export/restore
  is implemented, by design for this phase (see Data export, above).
- **Sequence current-value export.** `sequenceState` archive entries exist
  and are correctly ordered (see "Archive planning"), but `dumpMssql` does
  not yet stream a sequence's current value the way it does `tableData`;
  those entries still fall back to `renderPlainSql`'s default
  "not rendered" warning.
- **`sql_variant`, `xml`, `geography`, `geometry`, `hierarchyid` column
  data.** Detected and excluded from `INSERT` output with an
  `unsupported-column-type` diagnostic per column (see "Data export"
  above); never guessed at or serialized incorrectly.
- **A `tedious`-based connection pool source.** Only direct-connection
  wrapping (`fromTediousConnection`) exists today.
- **`sqlcmd` scripting.** `:setvar`/`$(Variable)` substitution, `:r` file
  includes, `:connect`, and shell escapes (`!!`/`:!!`) are detected and rejected
  with `UnsupportedSqlcmdDirectiveError`, never executed or expanded (see
  "Restore" above).

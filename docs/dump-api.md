# Dump API

```ts
dumpMssql(
  connection: MssqlConnectionInput,
  options: DumpMssqlOptions,
  output: Writable,
  onProgress?: DumpProgressCallback,
  signal?: AbortSignal,
): Promise<DumpResult>
```

Composes the whole pipeline against **one** acquired physical connection:
introspect → plan the archive → render schema objects → stream table data,
interleaved at the correct position in dependency order.

## Options

```ts
interface DumpMssqlOptions {
  mode?: 'full' | 'schema-only' | 'data-only'; // default 'full'
  selection?: DumpSelection;
  render?: PlainSqlRenderOptions;
  dataExport?: TableDataExportOptions;
}
```

### `mode`

| Mode             | Emits                                                   |
| ---------------- | ------------------------------------------------------- |
| `full` (default) | Schema objects and row data                             |
| `schema-only`    | Definitions only — no `INSERT`, no `IDENTITY_INSERT`    |
| `data-only`      | Row data only; assumes the target schema already exists |

Mode boundaries are hard: a `data-only` archive never silently pulls in schema
definitions, and vice versa.

### `selection`

Exact, case-sensitive identifiers — never lowercased, never wildcards, because
SQL Server identifier casing is collation-dependent and this library must not
guess at it.

```ts
{
  schemas?: string[];
  excludeSchemas?: string[];
  tables?: { schemaName: string; pureName: string }[];
  excludeTables?: { schemaName: string; pureName: string }[];
  includeSystemSchemas?: boolean;   // default false
}
```

`sys`, `INFORMATION_SCHEMA`, `guest` and the fixed database-role schemas
(`db_owner`, `db_datareader`, …) are excluded by default.

Selection is applied **in memory**, never interpolated into catalog SQL. If a
selected object hard-depends on an excluded one (a foreign key pointing at an
excluded table), the planner pulls the missing entry in with
`selectionState: 'dependency'` and an `included-as-dependency` diagnostic — so a
partial dump never produces a dangling reference. `strictSelection` turns that
into an error instead.

### `render`

```ts
{
  includeDropStatements?: boolean;   // reverse-order DROP ... IF EXISTS first
  includeTimestamp?: boolean;        // default false, for determinism
  quoteAllIdentifiers?: boolean;
  lineEnding?: '\n' | '\r\n';        // default '\n'
  indentation?: string;
  unsupportedFeaturePolicy?: 'error' | 'warn-omit';   // default 'error'
}
```

`includeDropStatements` requires SQL Server 2016+ (`DROP ... IF EXISTS`). No
`DROP SCHEMA` is emitted for `dbo`, which SQL Server refuses to drop.

### `dataExport`

```ts
{
  maxRowsPerStatement?: number;   // default 100, hard-clamped to 1000
  maxStatementBytes?: number;     // default 4_000_000
  maxRowsPerBatch?: number;       // default 10_000
  maxBatchBytes?: number;         // default 8_000_000
  streamBatchSize?: number;       // row-fetch backpressure high-water mark
  emitBatchSeparators?: boolean;  // default true
}
```

Data is written at two nested granularities, because each one costs something
different at restore time:

| Unit                           | Bounded by                                 | Costs, per unit          |
| ------------------------------ | ------------------------------------------ | ------------------------ |
| One `INSERT … VALUES (…), (…)` | `maxRowsPerStatement`, `maxStatementBytes` | one implicit transaction |
| One `GO`-terminated batch      | `maxRowsPerBatch`, `maxBatchBytes`         | one round trip           |

Rows are accumulated into multi-row `INSERT ... VALUES (…), (…);` statements,
and those statements are packed into `GO`-terminated batches. Each batch is one
round trip, since `restoreSqlDump` executes batches strictly sequentially: at
the defaults a million-row table restores as 100 round trips, against 10,000
with a `GO` after every statement.

`maxRowsPerStatement` is the one to leave alone. Larger statements commit less
often, so they look like the cheaper unit — measured, they are not: 1000-row
statements restored consistently slower than 100-row ones, packed or not, since
a large `VALUES` constructor costs more to compile than the commits it saves.
It is always clamped to SQL Server's own 1000-row `VALUES` limit regardless.

Only the current statement's tuples are held in memory; the underlying row
stream is never collected into an array, and a batch is streamed out statement
by statement rather than assembled.

`maxBatchBytes` is an exact bound on a batch's text and defaults well under the
64 MiB `restoreSqlDump` accepts (`maxBatchBytes` there), leaving room for
hand-editing; a single statement larger than it is still emitted, alone. Set
`maxRowsPerBatch: 1` for one statement per batch — the finest error attribution
a restore can report, since `RestoreBatchError` names a failing batch and not a
statement inside it — at a round trip per statement.

`emitBatchSeparators` emits the `GO` lines at all. Leave it on: without it, a
large table's data becomes one enormous batch that exceeds the restore parser's
batch bound and has to be buffered whole on the way back in.
`SET IDENTITY_INSERT` is session-scoped, so splitting data across batches is
safe.

## Result

```ts
interface DumpResult {
  bytesWritten: number;
  rowsExported: number;
  renderedDumpIds: readonly string[];
  skippedDumpIds: readonly string[];
  warnings: readonly MssqlDiagnostic[];
  cancelled: boolean;
}
```

Warnings are structured (`{ severity, code, message, objectReference? }`), never
log text. Codes you may see:

| Code                                                                      | Meaning                                                                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `datetimeoffset-normalized-to-utc`                                        | The original display offset is not recoverable through Tedious; the instant is preserved                            |
| `unsupported-column-type`                                                 | `sql_variant`/`xml`/`geography`/`geometry`/`hierarchyid` excluded from `INSERT` output                              |
| `data-not-rendered`                                                       | A selected `sequenceState` entry (sequence current value is not exported)                                           |
| `included-as-dependency`                                                  | An unselected object was pulled in to keep the dump restorable                                                      |
| `unresolved-programmable-dependency`                                      | A module reference the catalog could not bind (dynamic SQL, out-of-selection target)                                |
| `encrypted-module-definition-unavailable` / `module-definition-not-found` | No SQL text available; nothing is invented in its place                                                             |

## Progress

```ts
interface DumpProgressEvent {
  phase:
    | 'connecting'
    | 'detecting-version'
    | 'introspecting'
    | 'planning-archive'
    | 'rendering-schema'
    | 'exporting-data'
    | 'finalizing';
  message?: string; // "schema.table" during exporting-data
  objectsProcessed?: number; // running row count during exporting-data
  objectsTotal?: number;
  bytesWritten?: number;
}
```

`exporting-data` fires once **per row**, not per batch, so a caller can report
row-level progress even though the SQL is batched.

## Cancellation

Every long-running function takes an `AbortSignal` and, on cancellation,
returns its normal result shape with `cancelled: true` and whatever partial
output had already been produced — rather than throwing, so a caller does not
have to distinguish "cancelled" from "crashed" by exception type.

Cancelling mid-table still emits the closing `SET IDENTITY_INSERT … OFF`, so the
partial file is never left with an unbalanced `ON` that would affect unrelated
statements later in the same restore session.

## Determinism

Two dumps of the same database are byte-identical. This requires, and the
package guarantees:

- topological object order with `(section, objectPriority, schemaName, name, dumpId)`
  tie-breaking, so input iteration order cannot leak through
- row data read in primary-key order (`ORDER BY` on the PK) — without it SQL
  Server is free to reorder rows between scans
- explicit identifier quoting, keyword case, indentation and line endings
- no timestamp unless `includeTimestamp: true`
- codepoint sorting, never `localeCompare`

## Header and secrets

Every dump starts with the fixed marker line `isDumperSqlDump()` looks for,
followed by database name, collation, compatibility level, source product
version/engine edition and mode — each omitted when unavailable. Nothing
sensitive is reachable: `MssqlDatabase` and `MssqlVersion` never carry
connection strings or credentials.

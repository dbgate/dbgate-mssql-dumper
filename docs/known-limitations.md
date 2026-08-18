# Known limitations

Stated plainly, with the reason, so you can tell whether any of them matters for
your use. Nothing here is silently swallowed: each produces either a structured
diagnostic or a typed error.

## Driver-level fidelity

These come from the Tedious value parser and cannot be fixed at this layer. Each
is reported as a warning on `DumpResult.warnings` and pinned by an integration
test so it cannot regress unnoticed.

- **`datetimeoffset` loses its display offset.** `readDateTimeOffset()` reads the
  offset bytes and discards them. The instant is exact; the stored offset becomes
  `+00:00`. Warning: `datetimeoffset-normalized-to-utc`.
- **`decimal`/`numeric` beyond ~15 significant digits lose precision.**
  `readNumeric()` divides by `10^scale` in floating point. This package adds no
  further loss. Warning: `possible-precision-loss`.
- **`money`/`smallmoney` at the range extreme fail to restore.** The maximum
  `922337203685477.5807` rounds _up_ as a double to a value outside the type's
  range, so the `INSERT` overflows rather than storing an approximation. Warning:
  `possible-precision-loss`.

## Column data not exported

`sql_variant`, `xml`, `geography`, `geometry` and `hierarchyid` values are
excluded from `INSERT` output with an `unsupported-column-type` warning, rather
than being serialized incorrectly. Their column _definitions_ are dumped and
restored normally.

A `U+0000` inside a character column cannot be expressed in a T-SQL string
literal in a plain `.sql` file.

## Objects not generated

- **Sequence current value.** A restored sequence restarts at `START WITH`.
- **`CREATE TYPE` for user-defined alias/CLR types.** A column referencing one is
  rendered with the correct type name, but the target must already have the type.
- **Columnstore, XML and spatial indexes.** Detected as unsupported and handled
  per `unsupportedFeaturePolicy` (`error` by default, or `warn-omit`).
- **Routine parameters** (`sys.parameters`) are not introspected. This does not
  affect dump fidelity, since module definitions are emitted verbatim — it only
  means `MssqlRoutine.parameters` is empty in the model.
- **Deep temporal / memory-optimized / graph / Always Encrypted metadata.**
  Table-level flags are populated; period columns, retention policy, bucket
  counts and column encryption keys are not.
- **Logins, users, roles, permissions, server-level objects.** Out of scope.
- **Extended properties** other than `MS_Description` are not read, and none are
  emitted.

## Restore

- **No `sqlcmd` scripting.** `:setvar`, `$(Variable)` substitution, `:r`
  includes, `:connect`, `:on error` and `:!!` shell escapes are **detected and
  rejected** with `UnsupportedSqlcmdDirectiveError` — never expanded, never
  forwarded to the server. This is a documented subset of `sqlcmd`, not
  compatibility with it.
- **No transactional wrapper.** Batches execute sequentially and are not wrapped
  in a transaction — much of what a dump contains (`CREATE SCHEMA` via `EXEC`,
  module creation) is not usefully transactional anyway, and a multi-gigabyte
  data load inside one transaction would be a liability. A parse error stops the
  restore; it does not roll back what already ran.
- **No conflict detection or remapping.** `restoreSqlDump` executes the batches
  it is given. `preflightRestore` currently only detects target version and
  capabilities; existing-object checks and schema/login remapping are future
  work.
- **`data-only` into a schema that has triggers will fire them.** The dump's own
  ordering prevents this for a full restore (triggers are post-data), but
  applying a data-only dump to an already-complete schema will fire existing
  `AFTER INSERT` triggers for every row. Either drop/disable the triggers first
  or restrict the selection, as the integration suite does.
- **Row order is primary-key order, and a table with no primary key has no
  guaranteed row order.** Dumps of PK-less tables are still correct but not
  byte-reproducible.

## Connections

- **One request at a time per connection.** TDS cannot interleave requests on one
  session. The adapter detects an overlap and throws `connection-busy` naming
  both operations, rather than deadlocking or surfacing tedious's cryptic
  `EINVALIDSTATE`. Finish consuming a `stream()` before issuing another query;
  use separate connections for concurrency.
- **Reusing a connection immediately after cancellation.** Cancelling issues
  `connection.cancel()`, and tedious may still be settling the attention
  acknowledgement when the aborted call returns — a query issued right away can
  fail with "Requests can only be made in the LoggedIn state, not the
  SentAttention state". After cancelling, prefer a fresh connection. (Usually
  moot: a cancelled operation generally means you are done with that session.)
- **No bundled connection pool.** `tedious` has no first-party pool; implement
  `MssqlConnectionSource` over your own. See
  [tedious-adapter.md](tedious-adapter.md).
- **`SNAPSHOT` isolation requires database-level opt-in.** The default is
  `REPEATABLE READ`. `SNAPSHOT` needs `ALLOW_SNAPSHOT_ISOLATION ON`, which this
  library will not set on your behalf.

## Bulk loading

Only `INSERT`-statement data export is implemented. `BULK INSERT`/`bcp` require
server-side file access or a TDS bulk-load session, and the goal here is a
portable plain `.sql` file any SQL Server client can execute.

## Minimum target version

`includeDropStatements` emits `DROP … IF EXISTS`, which requires **SQL Server
2016 or later**. Everything else targets 2012+ (sequences).

## Selection caveats

- **A selector that matches nothing is reported, not silent.** Selection is exact
  and case-sensitive, so `schemas: ['Sales']` against a `sales` schema matches
  nothing. That now produces a `selection-matched-nothing` **warning** per
  unmatched selector — check `DumpResult.warnings`, because the dump itself would
  otherwise be a valid-looking file containing only a header.
- **A module referencing an excluded object cannot restore.** `CREATE VIEW` and
  `CREATE FUNCTION` resolve names eagerly, so a view over an excluded table fails
  at restore. This is reported as a `dependency-excluded-by-selection` warning
  (an error under `strictSelection`), but the dump is still produced — exclude
  the dependent module too, or widen the selection.
- **A table pulled in only as a foreign-key target** gets its columns, primary
  key and unique constraints/indexes — enough for the foreign key to be created —
  but not its check/default constraints, non-unique indexes, or data.

## Encrypted modules

A `WITH ENCRYPTION` module has no retrievable definition. Introspection reports
`encrypted-module-definition-unavailable` and never invents SQL. Under the
default `unsupportedFeaturePolicy: 'error'` the dump then **fails** when the
renderer reaches that object — after earlier output has already been written to
your stream, so the partial file must be discarded. Pass
`render: { unsupportedFeaturePolicy: 'warn-omit' }` to skip such objects with a
warning instead.

More generally: any render error leaves whatever was already emitted on the
output stream. A truncated file still starts with the package's marker line, so
`isDumperSqlDump()` returning `true` is not evidence of a complete dump — check
that the call resolved.

## Audit findings

The pre-v1 correctness/security audit is recorded as executable tests rather than
prose: `tests/hardening.test.ts` and `tests/hardeningOrdering.test.ts` each pin a
previously-broken behaviour. Between them they cover unbounded parser growth,
CR-in-string-data rewriting, isolation-level injection, schema-name escaping
inside `EXEC`, per-table index-name collisions, float-extreme literal expansion,
`bigint` string handling, surrogate-safe truncation, CRLF doubling, session
`SET` options leaking past a module, disabled constraints/indexes/triggers
restored enabled, `ALTER`-created module definitions, function-before-constraint
ordering, data-only foreign-key ordering, missing keys on dependency-included
tables, restore session hygiene, and batch location reporting.

Those are all fixed; the tests exist so they stay fixed.

Two behaviours worth knowing about because they were deliberately _kept_:

- **`SET IDENTITY_INSERT` and module `SET` options are restored on an early
  exit.** A restore that stops at a failing batch or is cancelled issues the
  matching `OFF`/`ON` statements before returning, so a pooled connection is
  never handed back with `IDENTITY_INSERT` still on. These run without the
  caller's `AbortSignal` (it is usually already aborted) and their failures are
  swallowed so they cannot mask the real result.
- **CHECK/DEFAULT-to-function ordering uses textual name matching.** SQL Server
  validates a UDF's existence when the constraint is added, so the function must
  come first. The edge is inferred by looking for the function's name in the
  constraint definition — conservative on purpose: a spurious edge is harmless
  (a function cannot depend on a constraint), and a miss falls back to the
  section tie-break, which is correct unless the function has its own incoming
  dependency.

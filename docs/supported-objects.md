# Supported objects

What the dumper introspects, renders, and restores. "Round-trip verified" means
the Docker-backed integration suite creates the object, dumps it, restores it
into an empty database, re-introspects, and compares the normalized model.

| Object                               | Introspected             | Rendered      | Round-trip verified | Notes                                                                                                                                                                |
| ------------------------------------ | ------------------------ | ------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema                               | ✅                       | ✅            | ✅                  | `CREATE SCHEMA` has no `IF NOT EXISTS`, so it is wrapped in a `sys.schemas` guard executed via `EXEC`. No `DROP SCHEMA` is emitted for `dbo` (SQL Server refuses it) |
| Table                                | ✅                       | ✅            | ✅                  | Columns inline; constraints/indexes/data are separate ordered entries                                                                                                |
| Column                               | ✅                       | ✅            | ✅                  | Type, nullability, collation, sparse, rowguidcol                                                                                                                     |
| Identity column                      | ✅                       | ✅            | ✅                  | `IDENTITY(seed,increment)` kept at full `bigint` precision; data wrapped in `SET IDENTITY_INSERT`                                                                    |
| Computed column                      | ✅                       | ✅            | ✅                  | `AS (…)` with `PERSISTED`; never dumped as an input value, and the recomputed result is compared                                                                     |
| Default constraint                   | ✅                       | ✅            | ✅                  | Always a separate `ALTER TABLE … ADD CONSTRAINT … DEFAULT … FOR …`, which is what preserves the original name. Never also emitted inline                             |
| Primary key                          | ✅                       | ✅            | ✅                  | Clustered/nonclustered, column order and direction                                                                                                                   |
| Unique constraint                    | ✅                       | ✅            | ✅                  |                                                                                                                                                                      |
| Check constraint                     | ✅                       | ✅            | ✅                  | Catalog definition verbatim; `WITH NOCHECK` when untrusted                                                                                                           |
| Foreign key                          | ✅                       | ✅            | ✅                  | `ON DELETE`/`ON UPDATE` actions; cascade, self-referencing and mutually referencing all verified                                                                     |
| Index — clustered / nonclustered     | ✅                       | ✅            | ✅                  |                                                                                                                                                                      |
| Index — unique                       | ✅                       | ✅            | ✅                  |                                                                                                                                                                      |
| Index — composite / descending       | ✅                       | ✅            | ✅                  |                                                                                                                                                                      |
| Index — `INCLUDE` columns            | ✅                       | ✅            | ✅                  |                                                                                                                                                                      |
| Index — filtered                     | ✅                       | ✅            | ✅                  | Filter predicate from the catalog                                                                                                                                    |
| Index — columnstore / XML / spatial  | ⚠️ type reported         | ❌            | —                   | Detected as unsupported and handled per `unsupportedFeaturePolicy`                                                                                                   |
| Sequence                             | ✅                       | ✅            | ✅                  | Type, start, increment, min/max, cycle, and all three caching states (`CACHE n` / `CACHE` / `NO CACHE`)                                                              |
| Sequence current value               | ✅ (in model)            | ❌            | —                   | Not exported; a restored sequence restarts at `START WITH`                                                                                                           |
| View                                 | ✅                       | ✅            | ✅                  | Stored definition verbatim, no appended `;`, so the restored text is byte-identical                                                                                  |
| View depending on a view             | ✅                       | ✅            | ✅                  | Ordered after its dependency                                                                                                                                         |
| Scalar function                      | ✅                       | ✅            | ✅                  |                                                                                                                                                                      |
| Scalar function `WITH SCHEMABINDING` | ✅                       | ✅            | ✅                  | Schema-bound references become **hard** ordering edges                                                                                                               |
| Inline table-valued function         | ✅                       | ✅            | ✅                  |                                                                                                                                                                      |
| Stored procedure                     | ✅                       | ✅            | ✅                  | Including one whose body contains standalone `GO` lines inside a string and a block comment                                                                          |
| DML trigger                          | ✅                       | ✅            | ✅                  | Emitted in post-data, so it does not fire during the data load — verified by comparing an audit table the trigger writes to                                          |
| Table data                           | ✅                       | ✅            | ✅                  | Streamed as batched multi-row `INSERT`s in primary-key order                                                                                                         |
| Routine parameters                   | ❌                       | —             | —                   | `sys.parameters` not read; `MssqlRoutine.parameters` is always `[]`. Does not affect fidelity — module definitions are emitted verbatim                              |
| User-defined alias / CLR types       | ⚠️ name only             | ⚠️ referenced | ❌                  | A column's type name is emitted correctly, but `CREATE TYPE` is not generated, so the target must already have the type                                              |
| Temporal / memory-optimized detail   | ⚠️ table-level flags     | ❌            | —                   | `isSystemVersioned`, `historyTable*`, `isMemoryOptimized`, `durability` are populated; period columns, retention and bucket metadata are not                         |
| Always Encrypted metadata            | ❌                       | —             | —                   |                                                                                                                                                                      |
| Graph (`NODE`/`EDGE`) tables         | ❌                       | —             | —                   |                                                                                                                                                                      |
| Logins, users, roles, permissions    | ❌                       | —             | —                   | Out of scope: this is a schema/data dumper, not a server-level one                                                                                                   |
| Extended properties                  | ⚠️ `MS_Description` only | ❌            | —                   | Read into `comment` fields; not emitted                                                                                                                              |

Legend: ✅ full support · ⚠️ partial · ❌ not implemented · — not applicable

## Restore ordering

Three sections are emitted in order — `pre-data`, `data`, `post-data`:

- **pre-data** — schemas, sequences, tables (columns inline)
- **data** — table rows
- **post-data** — primary/unique constraints, functions, default and check
  constraints, indexes, foreign keys, views, procedures, triggers

Two placements deliberately differ from a naive reading of that split, and both
are load-bearing:

1. **Views, functions, procedures and triggers are post-data, not pre-data.** A
   trigger that exists while data is loading would fire per row — the round-trip
   suite proves it does not by comparing an audit table the trigger populates.
2. **Indexes sort before foreign keys**, because SQL Server accepts a standalone
   unique index as a valid `REFERENCES` target, and **functions sort before
   check/default constraints**, because a constraint expression calling a scalar
   UDF is validated at the moment the constraint is added.

Foreign keys depend only on tables, never on other foreign keys, so mutually
referencing keys are trivially safe and always land after all data.

Dependency cycles among programmable objects are resolved by dropping
preference-strength edges only (never a hard, SQL Server-enforced one), and each
dropped edge is reported.

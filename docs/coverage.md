# Implementation coverage

`dump` — rendered into plain SQL · `restore` — executes correctly from a dump ·
`tested` — `unit`, `round-trip` (created → dumped → restored → re-introspected →
compared against a live SQL Server), or both.

Legend: ✅ full · ⚠️ partial · ❌ not implemented · — not applicable

## Objects

| Object / feature                               | dump    | restore | tested            | Limitations                                                                            |
| ---------------------------------------------- | ------- | ------- | ----------------- | -------------------------------------------------------------------------------------- |
| Schema (incl. Unicode, spaces, reserved words) | ✅      | ✅      | unit + round-trip | `CREATE SCHEMA` needs an `EXEC` guard (no `IF NOT EXISTS`); no `DROP SCHEMA` for `dbo` |
| Table                                          | ✅      | ✅      | unit + round-trip | —                                                                                      |
| Column (type, nullability, collation, sparse)  | ✅      | ✅      | unit + round-trip | —                                                                                      |
| Identity column                                | ✅      | ✅      | unit + round-trip | —                                                                                      |
| Computed column (incl. `PERSISTED`)            | ✅      | ✅      | unit + round-trip | Never exported as a value; recomputed by the target                                    |
| Default constraint (named + auto-named)        | ✅      | ✅      | unit + round-trip | Emitted only as a separate `ALTER TABLE`, never inline                                 |
| Primary key                                    | ✅      | ✅      | unit + round-trip | —                                                                                      |
| Unique constraint                              | ✅      | ✅      | unit + round-trip | —                                                                                      |
| Check constraint                               | ✅      | ✅      | unit + round-trip | —                                                                                      |
| Foreign key (+ `ON DELETE`/`ON UPDATE`)        | ✅      | ✅      | unit + round-trip | —                                                                                      |
| Self-referencing FK                            | ✅      | ✅      | round-trip        | —                                                                                      |
| Mutually referencing FKs                       | ✅      | ✅      | round-trip        | —                                                                                      |
| Index: clustered / nonclustered                | ✅      | ✅      | unit + round-trip | —                                                                                      |
| Index: unique / composite / descending         | ✅      | ✅      | unit + round-trip | —                                                                                      |
| Index: `INCLUDE`                               | ✅      | ✅      | unit + round-trip | —                                                                                      |
| Index: filtered                                | ✅      | ✅      | unit + round-trip | —                                                                                      |
| Index: columnstore / XML / spatial             | ❌      | —       | unit              | Type reported; rendering governed by `unsupportedFeaturePolicy`                        |
| Sequence (incl. all three cache states)        | ✅      | ✅      | unit + round-trip | Current value not exported — restarts at `START WITH`                                  |
| View                                           | ✅      | ✅      | unit + round-trip | Definition verbatim, byte-identical                                                    |
| View depending on a view                       | ✅      | ✅      | round-trip        | —                                                                                      |
| Scalar function                                | ✅      | ✅      | unit + round-trip | —                                                                                      |
| Scalar function `WITH SCHEMABINDING`           | ✅      | ✅      | round-trip        | Becomes a hard ordering edge                                                           |
| Inline table-valued function                   | ✅      | ✅      | round-trip        | —                                                                                      |
| Stored procedure                               | ✅      | ✅      | unit + round-trip | —                                                                                      |
| Module body containing standalone `GO`         | ✅      | ✅      | unit + round-trip | The case a naive splitter breaks                                                       |
| DML trigger                                    | ✅      | ✅      | unit + round-trip | Post-data, so it does not fire during the data load                                    |
| Table data                                     | ✅      | ✅      | unit + round-trip | PK-ordered; PK-less tables have no guaranteed order                                    |
| Routine parameters                             | —       | —       | ❌                | `sys.parameters` unread; does not affect fidelity                                      |
| User-defined alias / CLR type                  | ⚠️      | ⚠️      | unit              | Type _name_ rendered correctly; `CREATE TYPE` not generated                            |
| Temporal / memory-optimized detail             | ⚠️      | ❌      | unit              | Table-level flags only                                                                 |
| Always Encrypted / graph tables                | ❌      | —       | —                 | —                                                                                      |
| Logins / users / roles / permissions           | ❌      | —       | —                 | Out of scope                                                                           |
| Extended properties                            | ⚠️ read | ❌      | unit              | `MS_Description` into `comment`; not emitted                                           |

## Data types

| Type                                                         | dump    | restore | tested            | Limitations                                                               |
| ------------------------------------------------------------ | ------- | ------- | ----------------- | ------------------------------------------------------------------------- |
| `bit`, `tinyint`, `smallint`, `int`                          | ✅      | ✅      | unit + round-trip | Boundary values verified                                                  |
| `bigint`                                                     | ✅      | ✅      | unit + round-trip | Exact across the full 64-bit range                                        |
| `decimal`, `numeric`                                         | ✅      | ✅      | unit + round-trip | Exact across all 38 significant digits                                    |
| `money`, `smallmoney`                                        | ✅      | ✅      | unit + round-trip | Exact across the full ranges                                              |
| `float`, `real`                                              | ✅      | ✅      | unit + round-trip | Exponential notation retained (required at the double extremes)           |
| `char`, `varchar`, `text`                                    | ✅      | ✅      | unit + round-trip | —                                                                         |
| `nchar`, `nvarchar`, `ntext`                                 | ✅      | ✅      | unit + round-trip | `N'…'`; emoji/ZWJ verified                                                |
| `binary`, `varbinary`, `image`                               | ✅      | ✅      | unit + round-trip | `0x…`; zero bytes and empty verified                                      |
| `uniqueidentifier`                                           | ✅      | ✅      | unit + round-trip | —                                                                         |
| `date`, `time`, `datetime`, `smalldatetime`, `datetime2`     | ✅      | ✅      | unit + round-trip | Sub-ms precision recovered to 7 digits                                    |
| `datetimeoffset`                                             | ✅      | ⚠️      | unit + round-trip | Instant exact; display offset lost (`datetimeoffset-normalized-to-utc`)   |
| `rowversion` / `timestamp`                                   | —       | —       | unit + round-trip | Never inserted (server-maintained)                                        |
| `NULL`                                                       | ✅      | ✅      | unit + round-trip | —                                                                         |
| `sql_variant`, `xml`, `geography`, `geometry`, `hierarchyid` | ❌ data | —       | unit + round-trip | Column definition dumped; values excluded with `unsupported-column-type`  |
| `U+0000` in a character column                               | ❌      | —       | —                 | Not expressible in a T-SQL literal                                        |

## Pipeline capabilities

| Capability                                                             | Status       | tested            | Limitations                                                                         |
| ---------------------------------------------------------------------- | ------------ | ----------------- | ----------------------------------------------------------------------------------- |
| `mode: full` / `schema-only` / `data-only`                             | ✅           | unit + round-trip | `data-only` into a schema with triggers will fire them                              |
| Include/exclude selection                                              | ✅           | unit + round-trip | Exact names, case-sensitive, no wildcards                                           |
| Dependency closure for partial selections                              | ✅           | unit              | `strictSelection` rejects instead                                                   |
| `includeDropStatements` (reverse order)                                | ✅           | unit + round-trip | Requires SQL Server 2016+                                                           |
| Deterministic byte-identical output                                    | ✅           | unit + round-trip | Needs a PK for row order                                                            |
| dump → restore → dump stability                                        | ✅           | round-trip        | —                                                                                   |
| Bounded memory (dump)                                                  | ✅           | unit + round-trip | Only one row batch held                                                             |
| Bounded memory (restore)                                               | ✅           | unit              | Bounded by `maxBatchBytes` on every path                                            |
| Streaming backpressure                                                 | ✅           | unit + round-trip | Real `pause()`/`resume()`                                                           |
| `GO` lexer (strings, brackets, comments, nesting, CR/LF, chunk splits) | ✅           | unit + round-trip | —                                                                                   |
| `GO n` repeat counts                                                   | ✅           | unit + round-trip | Capped by `maxGoRepeatCount`                                                        |
| Batch execution semantics (`execSqlBatch`)                             | ✅           | unit + round-trip | Falls back to `query()` if unavailable                                              |
| `sqlcmd` directives                                                    | ❌ by design | unit + round-trip | Detected and rejected, never expanded                                               |
| Typed errors (parse / execution / cancel / malformed / bad `GO n`)     | ✅           | unit + round-trip | —                                                                                   |
| Progress (phase, batch index, rows, bytes, location)                   | ✅           | unit + round-trip | —                                                                                   |
| Cancellation (dump and restore)                                        | ✅           | unit + round-trip | Reuse a fresh connection afterwards                                                 |
| Structured diagnostics                                                 | ✅           | unit + round-trip | —                                                                                   |
| Credential redaction in errors/previews                                | ✅           | unit + round-trip | Pattern-based, SQL Server's credential clauses                                      |
| SQL injection resistance                                               | ✅           | unit              | Selection applied in memory; ids via bound `OPENJSON`; isolation level allow-listed |
| No DbGate dependency                                                   | ✅           | audit             | `tedious` only in `src/tedious.ts`                                                  |
| Restore preflight                                                      | ⚠️           | unit              | Version/capabilities only                                                           |
| Bulk (`BULK INSERT`/`bcp`) loading                                     | ❌ by design | —                 | Plain portable SQL is the goal                                                      |
| Transactional restore                                                  | ❌ by design | —                 | See known-limitations                                                               |

## Test counts

| Suite                          | Files | Tests |
| ------------------------------ | ----- | ----- |
| Unit (`tests/**`)              | 24    | 341   |
| Integration (`integration/**`) | 4     | 58    |

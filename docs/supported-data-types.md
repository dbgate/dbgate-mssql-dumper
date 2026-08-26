# Supported data types

How each SQL Server type is serialized into a plain-SQL dump, and whether it
round-trips exactly. "Round-trip verified" means the integration suite compares
the value **as SQL Server itself stringifies it** on both sides — not as the
driver returns it — so driver lossiness cannot mask a difference.

## Exactly round-trip verified

| Type                           | Rendered as                                                   | Notes                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `bit`                          | `0` / `1`                                                     |                                                                                                                                      |
| `tinyint`, `smallint`, `int`   | plain digits                                                  | Boundary values verified (`0`/`255`, `±32768`, `±2147483647`)                                                                        |
| `bigint`                       | plain digits                                                  | Read as server-converted text; full 64-bit range is exact, including `±9223372036854775807`                                          |
| `decimal`, `numeric`           | plain digits, never exponential                               | Read as server-converted text; all 38 significant digits are preserved                                                               |
| `money`, `smallmoney`          | plain digits with four fractional digits                      | Read as server-converted text with style 2; full ranges are preserved                                                                |
| `float`, `real`                | JS shortest round-trip form, **keeping** exponential notation | Required: expanding `1.79e308` to 309 plain digits yields a literal SQL Server parses as `decimal` (max precision 38) and rejects    |
| `char`, `varchar`, `text`      | `'…'`, `''`-escaped                                           |                                                                                                                                      |
| `nchar`, `nvarchar`, `ntext`   | `N'…'`, `''`-escaped                                          | Unicode, astral-plane emoji and ZWJ sequences verified                                                                               |
| `binary`, `varbinary`, `image` | `0x…` hex                                                     | Embedded zero bytes and empty (`0x`) verified                                                                                        |
| `uniqueidentifier`             | `'…'`                                                         |                                                                                                                                      |
| `date`                         | `'YYYY-MM-DD'`                                                | `0001-01-01` and `9999-12-31` verified                                                                                               |
| `time(n)`                      | `'…'` up to 7 fractional digits                               | Sub-millisecond precision recovered from Tedious's `nanosecondsDelta`                                                                |
| `datetime`                     | ISO-8601 literal                                              | 1/300s rounding is the type's own                                                                                                    |
| `smalldatetime`                | ISO-8601 literal                                              | Minute precision is the type's own                                                                                                   |
| `datetime2(n)`                 | `'…'` up to 7 fractional digits                               | Full scale preserved via `nanosecondsDelta`                                                                                          |
| `rowversion` / `timestamp`     | _(never inserted)_                                            | Server-maintained; `INSERT` rejects an explicit value. Excluded from the column list                                                 |
| computed columns               | _(never inserted)_                                            | Recomputed by the target from restored inputs; the suite compares the recomputed result                                              |
| `NULL`                         | `NULL`                                                        |                                                                                                                                      |

ISO-8601 with a `T` separator is used throughout because SQL Server parses it
unambiguously regardless of session `LANGUAGE`/`DATEFORMAT`.

### Exact numerics

`bigint`, `decimal`, `numeric`, `money` and `smallmoney` are converted to
`varchar(64)` by SQL Server in the export query. For money types, conversion
style 2 retains all four fractional digits. The JavaScript driver therefore
receives exact numeric text instead of a float64, and the dump writes that text
as an unquoted numeric literal. This preserves the full SQL Server ranges,
including all 38 decimal digits and the `money` range extremes.

## Round-trips with a documented caveat

### `datetimeoffset`

The **instant is preserved exactly**; the **original display offset is not.**

Tedious's `readDateTimeOffset()` reads the offset bytes off the wire and then
discards them, constructing the `Date` via `Date.UTC(...)` unconditionally. The
offset is therefore not recoverable at this layer at all. Values are rendered
with an explicit `+00:00` — honest about being that UTC instant rather than a
claim about the source row's offset — and every such column produces a
`datetimeoffset-normalized-to-utc` warning.

A source value of `2023-06-15T12:00:00+05:45` restores as
`2023-06-15T06:15:00+00:00`: same point in time, different stored offset. Both
directions of this are pinned by tests so it cannot regress silently.

## Collation

Character values are always written as `N'…'`, including for `char`/`varchar`/
`text`. An un-prefixed literal is typed in the **restoring database's default
collation**, and characters outside that code page are replaced with `?` before
the value ever reaches the column — verified against SQL Server, where
`'Привет'` under `SQL_Latin1_General_CP1_CI_AS` stores as `??????`.

A column whose collation differs from the database default also gets an explicit
`COLLATE` clause in `CREATE TABLE`. Both halves are required: without the clause
the restored column adopts the target's default collation and mangles the value
even though the literal was written correctly.

## Excluded from data export

Detected, excluded from the `INSERT` column list, and reported with an
`unsupported-column-type` warning — never guessed at:

| Type                    | Why                                                             |
| ----------------------- | --------------------------------------------------------------- |
| `sql_variant`           | Its runtime type is unknowable without an extra query per value |
| `xml`                   | Needs type-specific handling this package does not generate     |
| `geography`, `geometry` | Need constructor syntax (`geography::STGeomFromText(…)`)        |
| `hierarchyid`           | Needs constructor syntax                                        |

Their **column definitions** are still dumped and restored correctly — only the
row values are skipped. A table whose every column is excluded still restores the
right number of rows via `INSERT … DEFAULT VALUES`.

## Not representable in a plain-SQL literal

A `U+0000` (NUL) inside a character column cannot be written into a T-SQL string
literal in a plain `.sql` file. Store such data in a binary column, where it is
hex-encoded correctly.

## Type declarations in DDL

`formatColumnDataType` renders the declaration:

- `char`/`varchar`/`nchar`/`nvarchar`/`binary`/`varbinary` → `(n)` or `(max)`,
  with `nvarchar` byte length correctly halved to character length
- `decimal`/`numeric` → `(precision,scale)`
- `datetime2`/`datetimeoffset`/`time` → `(scale)` — **scale**, not precision.
  `sys.columns.precision` for these holds the total digit count (27, 34 and 16
  respectively at scale 7), so using it would emit `datetimeoffset(34)`, which
  SQL Server rejects
- user-defined alias/CLR types → the identifier verbatim, case preserved and
  quoted when needed, since a case-sensitive collation would fail to resolve a
  lowercased name. Note the type itself is not created by the dump — see
  [known-limitations.md](known-limitations.md)
- everything else → the bare type name

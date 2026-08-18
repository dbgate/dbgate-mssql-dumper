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
| `bigint`                       | plain digits                                                  | Tedious returns these as a decimal _string_; passed through verbatim so full 64-bit range is exact, including `±9223372036854775807` |
| `decimal`, `numeric`           | plain digits, never exponential                               | Exact up to ~15 significant digits — see below                                                                                       |
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

### `decimal` / `numeric` beyond ~15 significant digits

Tedious's `readNumeric()` divides by `10^scale` in floating point, always
producing a JS `number` (IEEE 754 double). Precision the driver has already
discarded cannot be recovered here.

This package introduces **no additional** loss: it never re-rounds and never
emits exponential notation for an exact-numeric target. If a value ever arrives
as a driver-supplied numeric _string_ it is passed through verbatim and
unquoted, which is lossless. Columns with precision > 15 get a
`possible-precision-loss` warning.

Concretely: `decimal(38,10)` holding
`1234567890123456789012345678.1234567890` restores with roughly the leading 17
digits intact and the remainder zeroed.

### `money` / `smallmoney`

Same float64 path (an integer divided by 10000), and with a harsher failure mode
at the extreme: `money`'s maximum `922337203685477.5807` rounds **up** to
`922337203685477.6` as a double, which is outside the type's range — so the
generated `INSERT` fails with an arithmetic overflow rather than storing an
approximation. Every `money`/`smallmoney` column therefore gets a
`possible-precision-loss` warning.

Values within ~15 significant digits round-trip exactly.

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

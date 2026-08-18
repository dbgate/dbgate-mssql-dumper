# Round-trip testing

Two independent suites:

| Command                    | What it runs                                               | Needs             |
| -------------------------- | ---------------------------------------------------------- | ----------------- |
| `npm test`                 | Unit tests (`tests/**`) — 310 tests                        | nothing           |
| `npm run test:integration` | Integration/round-trip tests (`integration/**`) — 57 tests | a live SQL Server |

`npm test` stays fast and hermetic: no Docker, no network, no server. All
connection behaviour is exercised through fakes.

## Running the integration suite

```sh
npm run docker:up            # SQL Server 2022 on 127.0.0.1:14330, waits until it accepts logins
npm run test:integration
npm run docker:down          # stop and remove the volume
```

Or in one step: `npm run test:integration:docker`.

Port 14330 is deliberately non-default so it cannot collide with a local SQL
Server install or another project's container.

### Pointing at your own server

| Variable              | Default                                          |
| --------------------- | ------------------------------------------------ |
| `MSSQL_TEST_HOST`     | `127.0.0.1`                                      |
| `MSSQL_TEST_PORT`     | `14330`                                          |
| `MSSQL_TEST_USER`     | `sa`                                             |
| `MSSQL_TEST_PASSWORD` | the compose file's password                      |
| `MSSQL_TEST_WAIT_MS`  | `30000` — how long to retry the first connection |
| `MSSQL_TEST_REQUIRED` | unset — see below                                |

The account needs `CREATE DATABASE`: each suite creates a uniquely-named source
and target database and drops both afterwards.

### Skip vs. fail

With no reachable server the suites **skip** themselves and print why, so
`npm run test:integration` is runnable on a machine without Docker.

**CI should set `MSSQL_TEST_REQUIRED=1`**, which turns "unreachable" into a hard
error. Without it a misconfigured pipeline would report green while testing
nothing.

If a hosted CI environment cannot run SQL Server containers, keep the integration
job separate and gated — the suite is fully runnable locally either way. Nothing
in `npm test`, `npm run lint`, `npm run typecheck` or `npm run build` depends on
it.

## What the round-trip actually verifies

The acceptance criterion is not "restore returned success":

```
source database
  → dumpMssql()                → plain .sql
  → empty target database
  → restoreSqlDump()
  → introspectMssql(target)
  → compare normalized schema  (deep equality)
  → compare row data           (server-stringified, per table)
  → dump the target again      → compare normalized SQL text
```

### Values are compared as SQL Server renders them, not as the driver returns them

This is the crux. Comparing driver-returned JS values would hide exactly the bugs
worth catching: two _different_ stored `decimal`s can arrive as the same float64,
and a `datetimeoffset`'s offset is gone before JS sees it. So each column is read
through a server-side conversion to text —
`convert(varchar, col, 121)` for date/time, style `3` for float, style `1` for
binary, `at time zone 'UTC'` for `datetimeoffset` — and the resulting strings are
compared. The comparison therefore sees what is actually stored on each side.

`rowversion` is excluded (server-generated, no user data). Computed columns are
_included_, because the target recomputes them from restored inputs — matching
proves both the inputs and the computed definition survived.

### Schema comparison

`normalizeDatabase()` projects the introspected model onto everything a correct
dump must reproduce, dropping only what legitimately differs between two
databases holding the same logical schema: the database name, `object_id`s,
create/modify timestamps, SQL Server's auto-generated constraint-name suffixes,
and sequence _current_ value. Every collection is sorted by a stable key, so
iteration order cannot affect the result.

An explicitly-named constraint is still compared exactly — preserving those names
is a documented guarantee.

### The fixture

`integration/fixture/` builds a database designed to break things:

- **schemas** — ordinary, Unicode (`Ünïcødé`), embedded space (`weird schema`),
  reserved word (`select`)
- **identifiers** — spaces, an embedded `]` (`Col]Bracket`), astral-plane emoji
  (`Ünïcødé Column 🚀`), reserved words (`from`, `where`, `group`, `table`)
- **types** — every common numeric/string/binary/date-time type, plus deprecated
  `text`/`ntext`/`image`, computed columns (persisted and not), identity, named
  and deliberately-unnamed defaults, `rowversion`
- **relationships** — PK, unique constraint, check constraint, FK with
  `ON DELETE CASCADE`, self-referencing FK, mutually referencing FKs
- **indexes** — clustered, nonclustered, unique, composite, descending,
  `INCLUDE`, filtered, and one on a bracket-containing column
- **sequences** — explicit `CACHE 20` and server-default caching
- **programmable objects** — view, view depending on a view, scalar function,
  `WITH SCHEMABINDING` scalar function, inline TVF, procedure, `AFTER INSERT`
  trigger
- **a batch-splitting trap** — `dbo.uspGoTrap`, whose body contains standalone
  `GO` lines inside both a string literal and a block comment
- **data** — embedded quotes, multiline text, Unicode/emoji/ZWJ sequences, binary
  with zero bytes, the exact boundary values of every integer type, non-UTC
  `datetimeoffset`, all-`NULL` rows, and 5000 rows for streaming

The fixture is created by a deliberately dumb statement-list executor, **never**
by this package's own batch parser — otherwise a splitting bug could corrupt the
fixture and mask itself.

Values the driver cannot carry losslessly live in a separate
`dbo.PrecisionLimits` table, excluded from strict comparison and asserted on
explicitly instead, so the documented limitations are pinned in both directions
rather than tolerated.

### Notable behavioural assertions

- **Trigger does not double-fire.** The trigger writes to an audit table; those
  rows are themselves dumped and restored. Equal counts prove the trigger did not
  also fire during the data load.
- **Naive splitting is genuinely destructive.** The suite runs a deliberately
  naive line-based `GO` splitter over the real dump and asserts it _tears
  `uspGoTrap` apart_, then asserts the real lexer keeps it in one batch and that
  the restored definition is byte-identical and executable.
- **Chunk-boundary independence.** The same dump is restored from a `Readable`
  delivering 7 bytes at a time, splitting identifiers, literals, CRLF pairs and
  `GO` lines across chunks.
- **Byte-identical repeat dumps**, and identical normalized SQL after a full
  dump → restore → dump cycle.
- **Cancellation** of both dump and restore leaves partial-but-well-formed output
  with balanced `SET IDENTITY_INSERT`.
- **No credential leaks**, verified against a real server error message for a
  failing `CREATE DATABASE SCOPED CREDENTIAL`.

## Debugging a failure

Suites run with `fileParallelism: false` — one physical server, and suites that
create and drop databases on it. Test databases are named
`<prefix>_<timestamp>_<n>` and dropped in `afterAll`; if a run is killed
mid-flight, `npm run docker:down` removes everything at once.

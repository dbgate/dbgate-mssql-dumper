# dbgate-mssql-dumper

Standalone, client-agnostic Microsoft SQL Server SQL dump and restore library
for Node.js.

Produces a deterministic, restorable plain `.sql` file and restores it back —
using only a TDS connection. **No `sqlcmd`, no SMO, no `bcp`, no external
process is ever invoked.** Framework-independent: it does not depend on DbGate
internals and works outside DbGate.

- Node.js >= 20, ESM and CJS builds, full TypeScript types
- `tedious` is an **optional** peer dependency, reachable only through the
  separate `dbgate-mssql-dumper/tedious` entry point — the core package never
  imports a driver
- Round-trip verified against a real SQL Server: dump → restore → introspect →
  compare schema _and_ data semantics (see
  [docs/round-trip-testing.md](docs/round-trip-testing.md))

## Install

```sh
npm install dbgate-mssql-dumper
# optional, for the bundled Tedious adapter:
npm install tedious
```

## Quick start

### Dump

```ts
import { createWriteStream } from 'node:fs';
import { dumpMssql } from 'dbgate-mssql-dumper';
import { fromTediousConnection } from 'dbgate-mssql-dumper/tedious';
import { Connection } from 'tedious';

const tedious = new Connection({
  server: 'localhost',
  authentication: { type: 'default', options: { userName: 'sa', password: '…' } },
  options: { database: 'MyDatabase', trustServerCertificate: true },
});
await new Promise<void>((resolve, reject) =>
  tedious.connect(error => (error ? reject(error) : resolve())),
);

const connection = fromTediousConnection(tedious);

const result = await dumpMssql(connection, { mode: 'full' }, createWriteStream('dump.sql'), event =>
  console.log(event.phase, event.objectsProcessed ?? '', event.bytesWritten ?? ''),
);

console.log(`${result.rowsExported} rows, ${result.bytesWritten} bytes`);
for (const warning of result.warnings) {
  console.warn(`[${warning.severity}] ${warning.code}: ${warning.message}`);
}
```

### Restore

```ts
import { createReadStream } from 'node:fs';
import { restoreSqlDump } from 'dbgate-mssql-dumper';

const result = await restoreSqlDump({
  connection,
  source: createReadStream('dump.sql'),
  progress: event => console.log(event.phase, event.batchIndex, event.rowsRestored),
});

console.log(`${result.batchesExecuted} batches, ${result.rowsRestored} rows`);
for (const error of result.errors) {
  console.error(`batch ${error.batchIndex} (line ${error.location.startLine}): ${error.message}`);
  console.error(`  ${error.sqlPreview}`); // truncated and credential-redacted
}
```

`source` accepts a `string`, a `Readable`, or any `AsyncIterable` of text or
`Buffer` chunks. Input is parsed incrementally, so restoring a multi-gigabyte
dump does not read it into memory.

## Public API

| Function                                                               | Purpose                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `dumpMssql(connection, options, output, onProgress?, signal?)`         | Full pipeline: introspect → plan → render schema → stream data      |
| `restoreSqlDump({ connection, source, options?, signal?, progress? })` | Parse `GO` batches; bulk-load generated INSERTs when available      |
| `introspectMssql(connection, options?, signal?)`                       | Normalized `MssqlDatabase` model + version/capabilities/diagnostics |
| `inspectDumpArchive(database, options?)`                               | Pure dependency planning → ordered `ArchiveEntry[]`                 |
| `renderPlainSql(request)`                                              | Pure model → plain T-SQL text (never touches the network)           |
| `exportTableDataAsInserts(request)`                                    | Stream one table's rows as batched `INSERT` statements              |
| `preflightRestore(request)`                                            | Detect the restore target's version/capabilities                    |
| `isDumperSqlDump(sample)`                                              | Cheap check that input looks like this package's own dump           |
| `parseSqlBatches(sql)` / `streamSqlBatches(source)`                    | The `GO` batch lexer, usable on its own                             |
| `fromTediousConnection(connection)`                                    | Adapter (from `dbgate-mssql-dumper/tedious`)                        |
| `connectTedious(config)`                                               | Convenience creator (from `dbgate-mssql-dumper/tedious`)            |

Each stage is independently usable: `inspectDumpArchive` and `renderPlainSql`
are pure functions of the model and need no connection at all.

## Documentation

| Document                                                     | Contents                                                                |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| [docs/dump-api.md](docs/dump-api.md)                         | `dumpMssql` options, modes, progress, diagnostics, batching             |
| [docs/restore-api.md](docs/restore-api.md)                   | `restoreSqlDump`, the `GO` lexer, typed errors, supported script subset |
| [docs/tedious-adapter.md](docs/tedious-adapter.md)           | Connection ownership, backpressure, batch execution, pools              |
| [docs/supported-objects.md](docs/supported-objects.md)       | Object kinds: dumped / restored / tested                                |
| [docs/supported-data-types.md](docs/supported-data-types.md) | Per-type serialization and round-trip fidelity                          |
| [docs/known-limitations.md](docs/known-limitations.md)       | What this package does not do, and why                                  |
| [docs/round-trip-testing.md](docs/round-trip-testing.md)     | Running the Docker-backed integration suite                             |
| [docs/architecture.md](docs/architecture.md)                 | Layer-by-layer design and the reasoning behind it                       |
| [docs/coverage.md](docs/coverage.md)                         | Implementation coverage table                                           |

## Why `GO`, not semicolons

SQL Server client scripts use `GO` as a **batch separator**, and `GO` itself is
never sent to the server. Splitting a T-SQL script on semicolons is wrong:
`CREATE PROCEDURE`/`VIEW`/`FUNCTION`/`TRIGGER` must each be alone in their
batch, and a semicolon inside a module body does not end it.

This package ships a real incremental lexer, so `GO` is recognized only when it
is genuinely a standalone separator — never inside a string, a bracketed or
double-quoted identifier, a `--` comment, or a (possibly nested) `/* */` block
comment, including when those span lines or arrive split across stream chunks:

```sql
PRINT 'GO';        -- not a separator
/*
GO
*/                 -- not a separator
GO                 -- a separator
```

## Development

```sh
npm install
npm run typecheck
npm run lint
npm test                        # unit tests, no Docker or network needed

npm run docker:up               # start SQL Server 2022 on port 14330
npm run test:integration        # round-trip tests against it
npm run docker:down

npm run test:package            # builds, then smoke-tests dist/ as ESM and CJS
```

Integration tests skip themselves with a clear message when no server is
reachable; set `MSSQL_TEST_REQUIRED=1` (as CI should) to make that a hard
failure instead.

## License

GPL-3.0-only

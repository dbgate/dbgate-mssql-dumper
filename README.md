# dbgate-mssql-dumper

Standalone, client-agnostic Microsoft SQL Server SQL dump and restore library
for Node.js. Framework-independent: it does not depend on DbGate internals
and works outside DbGate. Node.js >= 20, ESM and CJS builds.

See [docs/architecture.md](docs/architecture.md) for the full pipeline,
design decisions, and current implementation status.

## Status

This package is under active development. Public interfaces, the connection
abstraction, the optional Tedious adapter, and catalog introspection
(schemas, tables/columns, constraints, indexes, sequences, views, routines,
triggers) are in place. Procedure/function parameter introspection, deeper
temporal/memory-optimized/Always Encrypted metadata, restore conflict
detection, and plain-SQL rendering of columnstore/XML/spatial indexes remain
future work — see "What is intentionally out of scope for this phase" in the
architecture doc.

## Install

```sh
npm install dbgate-mssql-dumper
# optional, for the Tedious adapter:
npm install tedious
```

## Usage

```ts
import { Connection } from 'tedious';
import { fromTediousConnection } from 'dbgate-mssql-dumper/tedious';
import { dumpMssql } from 'dbgate-mssql-dumper';
import { createWriteStream } from 'node:fs';

const tediousConnection = new Connection({
  server: 'localhost',
  authentication: { type: 'default', options: { userName: 'sa', password: '...' } },
  options: { database: 'MyDatabase', trustServerCertificate: true },
});

await new Promise<void>((resolve, reject) => {
  tediousConnection.on('connect', err => (err ? reject(err) : resolve()));
  tediousConnection.connect();
});

const connection = fromTediousConnection(tediousConnection);
const output = createWriteStream('dump.sql');

const result = await dumpMssql(connection, { mode: 'schema-only' }, output);
console.log(result.warnings);
```

## Public API

- `dumpMssql(connection, options, output, onProgress?, signal?)`
- `introspectMssql(connection, options?, signal?)`
- `inspectDumpArchive(database, options?)`
- `renderPlainSql(request)`
- `exportTableDataAsInserts(request)`
- `restoreSqlDump(request)`
- `preflightRestore(request)`
- `fromTediousConnection(connection)` (from `dbgate-mssql-dumper/tedious`)

## Development

```sh
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

## License

GPL-3.0-only

# Tedious adapter

`tedious` is an **optional** peer dependency. The core package never imports it;
`src/tedious.ts` is the only file that does, and it is reachable solely through
the separate `dbgate-mssql-dumper/tedious` entry point. Importing
`dbgate-mssql-dumper` alone does not pull a driver into your bundle.

## Wrapping a connection you own

```ts
import { Connection } from 'tedious';
import { fromTediousConnection } from 'dbgate-mssql-dumper/tedious';

const tedious = new Connection({
  server: 'localhost',
  authentication: { type: 'default', options: { userName: 'sa', password: '…' } },
  options: { database: 'MyDatabase', trustServerCertificate: true },
});
await new Promise<void>((resolve, reject) =>
  tedious.connect(error => (error ? reject(error) : resolve())),
);

const connection = fromTediousConnection(tedious);
```

**Ownership stays with you.** This adapter never calls `connection.close()` — not
on abort, not on error, not on completion. It only ever calls
`connection.cancel()` to stop an in-flight statement. Closing a connection the
library did not create is not its decision to make.

## Creating one for the library to own

```ts
import { connectTedious } from 'dbgate-mssql-dumper/tedious';

const { connection, close } = await connectTedious({/* tedious config */});
try {
  await dumpMssql(connection, { mode: 'full' }, output);
} finally {
  await close();
}
```

Here the caller of `connectTedious` owns the result, so `close()` is provided.
This lives only in the optional adapter module, so it adds no `tedious`-shaped
concept to the core API.

## What the adapter provides

| Member                          | Notes                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `query(query, signal?)`         | Buffered. Parameters map to `tedious.TYPES`, using an explicit `sqlType` name when given, otherwise inferred from the JS value |
| `stream(query, options?)`       | Async-iterable rows with **true** backpressure                                                                                 |
| `execBatch(sql, signal?)`       | Real TDS batch via `execSqlBatch` — no parameters, matching that API                                                           |
| `getTransactionStatus(signal?)` | Best-effort, via `@@TRANCOUNT` / `XACT_STATE()`                                                                                |
| `cancel()`                      | `connection.cancel()`                                                                                                          |

`query.timeoutMs` is applied with `request.setTimeout(...)`.

### `execBatch` vs `query`

`execBatch` calls `connection.execSqlBatch()`; `query` calls
`connection.execSql()`, which routes the text through `sp_executesql`. The
difference is load-bearing for restore: `CREATE PROCEDURE`/`VIEW`/`FUNCTION`/
`TRIGGER` must be alone in their batch and can behave differently or be rejected
inside that wrapper, and batch-scoped constructs (local temp tables, `SET`
options intended to persist into later batches) must not be sandboxed in a
nested execution context.

### Streaming backpressure

`stream()` uses `tedious.Request`'s own `pause()`/`resume()`, which stop the TDS
row flow itself — tedious emits no further `row` events while paused. Once the
internal queue reaches `options.batchSize` (default 50) the request is paused;
once the consumer drains it to half that, it resumes. An unconsumed
multi-million-row result therefore never accumulates past that bound, however
slowly the caller iterates.

This is deliberately not the `PassThrough`-stream approach some drivers'
wrappers use: an object-mode Node stream that is written to as fast as rows
arrive has an effectively unbounded internal buffer unless the reader keeps up.

If the consumer stops early (`break`, or an error unwinding a `for await`), the
generator's `finally` cancels the request and un-pauses it first, so nothing is
left stuck paused.

## One request at a time

A single SQL Server session executes one request at a time; TDS cannot
interleave two. Tedious rejects the attempt with a cryptic
`EINVALIDSTATE` ("Requests can only be made in the LoggedIn state, not the
SentClientRequest state") that names neither operation.

The adapter detects this itself and throws an `MssqlDumperError` with code
`connection-busy`, naming both the operation being started and the one still in
flight. A `stream()` holds the connection from its first `next()` until the
iteration finishes, so you must finish consuming a stream before issuing another
query on the same connection.

This is deliberately **not** an internal queue: silently serializing would turn
a caller mistake into a deadlock whenever the waiting operation is what the
in-flight one is waiting for.

To run work concurrently, use separate connections.

## Type declarations

`tedious`'s public `.d.ts` does not export a `ColumnMetadata` or row-column type
— its `row`/`columnMetadata` listener parameters are effectively untyped at the
package boundary. The adapter declares minimal local structural types for the
shapes it reads and narrows them at runtime, rather than importing internal
unexported types.

## Connection pools

No pool source ships yet. `tedious` has no first-party pool, and third-party
ones (`tedious-connection-pool`, `generic-pool`) differ enough that wrapping one
prematurely would bake in an unvalidated interface.

You can supply your own by implementing `MssqlConnectionSource`:

```ts
const source: MssqlConnectionSource = {
  async acquire() {
    const pooled = await myPool.acquire();
    return {
      connection: fromTediousConnection(pooled),
      release: async () => myPool.release(pooled),
    };
  },
};

await dumpMssql(source, { mode: 'full' }, output);
```

Everything in the public API accepts an `MssqlConnectionSource` wherever it
accepts a connection, and acquires exactly **one** physical connection for the
whole operation — `SET` options, `@@TRANCOUNT`, temp tables and
`SESSION_CONTEXT` are all connection-scoped, so introspection and data export
must observe the same session.

## Using a different driver

Nothing in the core package depends on `tedious`. Implement `MssqlConnection`
over `msnodesqlv8`, `mssql`, or anything else and every API works unchanged;
`execBatch` and `getTransactionStatus` are optional, with documented fallbacks.

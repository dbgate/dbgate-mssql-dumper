import type { Connection, Request } from 'tedious';
import { describe, expect, it, vi } from 'vitest';
import type { MssqlBulkInsertRequest } from '../src/connection/types.js';
import { TediousConnectionAdapter } from '../src/tedious.js';

interface FakeTediousRowColumn {
  readonly metadata: { readonly colName: string };
  readonly value: unknown;
}

function row(values: Record<string, unknown>): FakeTediousRowColumn[] {
  return Object.entries(values).map(([colName, value]) => ({ metadata: { colName }, value }));
}

/**
 * `tedious.Request`'s own `.emit`/`.callback` typings are keyed to its
 * internal, unexported payload shapes (e.g. a full `ColumnMetadata` with
 * every TDS-level field), which a lightweight test fake cannot and should
 * not reproduce. These helpers drive the same real `EventEmitter`/callback
 * at runtime through a deliberately widened type, exactly as tedious's own
 * network-parsing code does internally.
 */
function emitOn(request: Request, event: string, ...args: unknown[]): void {
  (request as unknown as { emit: (event: string, ...args: unknown[]) => boolean }).emit(
    event,
    ...args,
  );
}

function completeRequest(request: Request, error: Error | null, rowCount?: number): void {
  (request as unknown as { callback: (error: Error | null, rowCount?: number) => void }).callback(
    error,
    rowCount,
  );
}

/**
 * A structural fake of `tedious.Connection`: only `execSql`/`cancel`/`close`
 * are exercised by the adapter. `execSql` records the real `tedious.Request`
 * instance the adapter created, so tests can drive it with real event
 * emissions (`request.emit('row', ...)`) and observe its real `paused`
 * flag — not a reimplementation of tedious's backpressure semantics.
 */
function createFakeTediousConnection() {
  let currentRequest: Request | null = null;
  let lastExecKind: 'execSql' | 'execSqlBatch' | null = null;
  let cancelCalls = 0;
  let closeCalls = 0;
  let completeOnCancel = true;
  let currentBulkLoad:
    | {
        table: string;
        callback: (error?: Error | null, rowCount?: number) => void;
        columns: string[];
        addColumn: (name: string) => void;
        cancel: () => void;
      }
    | undefined;
  let currentBulkRows: unknown[][] | undefined;
  /** When set, exec* throws synchronously, as tedious does for a wrong-state request. */
  let execThrows: Error | null = null;

  const fake = {
    execSql(request: Request) {
      if (execThrows) throw execThrows;
      currentRequest = request;
      lastExecKind = 'execSql';
    },
    execSqlBatch(request: Request) {
      if (execThrows) throw execThrows;
      currentRequest = request;
      lastExecKind = 'execSqlBatch';
    },
    newBulkLoad(
      table: string,
      _options: unknown,
      callback: (error?: Error | null, rowCount?: number) => void,
    ) {
      const columns: string[] = [];
      currentBulkLoad = {
        table,
        callback,
        columns,
        addColumn(name: string) {
          columns.push(name);
        },
        cancel() {},
      };
      return currentBulkLoad;
    },
    execBulkLoad(_bulkLoad: unknown, rows: unknown[][]) {
      currentBulkRows = rows;
    },
    cancel() {
      cancelCalls++;
      // Approximates tedious's real behavior: cancelling in-flight work
      // eventually completes the request with an error.
      if (completeOnCancel) {
        (currentRequest as unknown as { callback: (err: Error) => void } | null)?.callback(
          new Error('Canceled.'),
        );
      }
    },
    close() {
      closeCalls++;
    },
  };

  return {
    connection: fake as unknown as Connection,
    getCurrentRequest: () => currentRequest,
    getLastExecKind: () => lastExecKind,
    setExecSqlThrows: (error: Error | null) => {
      execThrows = error;
    },
    setCompleteOnCancel: (value: boolean) => {
      completeOnCancel = value;
    },
    getCancelCalls: () => cancelCalls,
    getCloseCalls: () => closeCalls,
    getCurrentBulkLoad: () => currentBulkLoad,
    getCurrentBulkRows: () => currentBulkRows,
    completeBulk: (error?: Error | null, rowCount?: number) =>
      currentBulkLoad?.callback(error, rowCount),
  };
}

describe('TediousConnectionAdapter.query', () => {
  it('resolves with rows, columns, and rowsAffected on success', async () => {
    const fake = createFakeTediousConnection();
    const adapter = new TediousConnectionAdapter(fake.connection);

    const promise = adapter.query({ sql: 'select 1 as id' });
    const request = fake.getCurrentRequest()!;
    emitOn(request, 'columnMetadata', [{ colName: 'id' }]);
    emitOn(request, 'row', row({ id: 1 }));
    completeRequest(request, null, 1);

    const result = await promise;
    expect(result.rows).toEqual([{ id: 1 }]);
    expect(result.columns).toEqual([
      {
        name: 'id',
        sqlType: undefined,
        nullable: undefined,
        length: undefined,
        precision: undefined,
        scale: undefined,
      },
    ]);
    expect(result.rowsAffected).toBe(1);
  });

  it('rejects with a wrapped error on SQL failure', async () => {
    const fake = createFakeTediousConnection();
    const adapter = new TediousConnectionAdapter(fake.connection);

    const promise = adapter.query({ sql: 'select 1/0' });
    const request = fake.getCurrentRequest()!;
    completeRequest(request, new Error('Divide by zero error encountered.'));

    await expect(promise).rejects.toThrow('Divide by zero error encountered.');
  });

  it('cancels the connection and rejects when the signal is aborted', async () => {
    const fake = createFakeTediousConnection();
    const adapter = new TediousConnectionAdapter(fake.connection);
    const controller = new AbortController();

    const promise = adapter.query({ sql: 'select 1' }, controller.signal);
    controller.abort();

    await expect(promise).rejects.toThrow();
    expect(fake.getCancelCalls()).toBe(1);
  });

  it('does not start a request for an already-aborted signal', async () => {
    const fake = createFakeTediousConnection();
    const adapter = new TediousConnectionAdapter(fake.connection);
    const controller = new AbortController();
    controller.abort();

    await expect(adapter.query({ sql: 'select 1' }, controller.signal)).rejects.toMatchObject({
      code: 'operation-cancelled',
    });
    expect(fake.getCurrentRequest()).toBeNull();
  });

  it('settles promptly even when cancel does not invoke the tedious callback', async () => {
    const fake = createFakeTediousConnection();
    fake.setCompleteOnCancel(false);
    const adapter = new TediousConnectionAdapter(fake.connection);
    const controller = new AbortController();

    const promise = adapter.query({ sql: 'select 1' }, controller.signal);
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: 'operation-cancelled' });
    expect(fake.getCancelCalls()).toBe(1);
    // Release the deliberately uncooperative fake's in-flight request.
    completeRequest(fake.getCurrentRequest()!, new Error('Canceled.'));
  });

  it('never closes the caller-owned connection', async () => {
    const fake = createFakeTediousConnection();
    const adapter = new TediousConnectionAdapter(fake.connection);

    const promise = adapter.query({ sql: 'select 1' });
    const request = fake.getCurrentRequest()!;
    completeRequest(request, null, 0);
    await promise;

    const controller = new AbortController();
    const abortedPromise = adapter.query({ sql: 'select 1' }, controller.signal);
    controller.abort();
    await abortedPromise.catch(() => {});

    expect(fake.getCloseCalls()).toBe(0);
  });
});

describe('TediousConnectionAdapter.execBatch', () => {
  it('sends the SQL via execSqlBatch (not execSql), and resolves with the accumulated rowsAffected', async () => {
    const fake = createFakeTediousConnection();
    const adapter = new TediousConnectionAdapter(fake.connection);

    const promise = adapter.execBatch('CREATE PROCEDURE dbo.P AS SELECT 1;');
    expect(fake.getLastExecKind()).toBe('execSqlBatch');
    const request = fake.getCurrentRequest()!;
    completeRequest(request, null, 3);

    await expect(promise).resolves.toEqual({ rowsAffected: 3 });
  });

  it('rejects with a wrapped error on failure', async () => {
    const fake = createFakeTediousConnection();
    const adapter = new TediousConnectionAdapter(fake.connection);

    const promise = adapter.execBatch('CREATE PROCEDURE dbo.Bad AS this is not valid;');
    const request = fake.getCurrentRequest()!;
    completeRequest(request, new Error("Incorrect syntax near 'this'."));

    await expect(promise).rejects.toThrow("Incorrect syntax near 'this'.");
  });

  it('preserves SQL Server messages from Tedious AggregateError failures', async () => {
    const fake = createFakeTediousConnection();
    const adapter = new TediousConnectionAdapter(fake.connection);

    const promise = adapter.execBatch('INSERT INTO dbo.Items VALUES (...);');
    const request = fake.getCurrentRequest()!;
    completeRequest(
      request,
      new AggregateError([
        new Error('String or binary data would be truncated.'),
        new Error('The statement has been terminated.'),
      ]),
    );

    await expect(promise).rejects.toThrow(
      'String or binary data would be truncated.; The statement has been terminated.',
    );
  });

  it('cancels the connection and rejects when the signal is aborted', async () => {
    const fake = createFakeTediousConnection();
    const adapter = new TediousConnectionAdapter(fake.connection);
    const controller = new AbortController();

    const promise = adapter.execBatch("WAITFOR DELAY '00:00:05';", controller.signal);
    controller.abort();

    await expect(promise).rejects.toThrow();
    expect(fake.getCancelCalls()).toBe(1);
  });

  it('defaults rowsAffected to 0 when tedious reports no row count', async () => {
    const fake = createFakeTediousConnection();
    const adapter = new TediousConnectionAdapter(fake.connection);

    const promise = adapter.execBatch('SET ANSI_NULLS ON;');
    const request = fake.getCurrentRequest()!;
    completeRequest(request, null, undefined);

    await expect(promise).resolves.toEqual({ rowsAffected: 0 });
  });

  it('applies the per-query timeout to the tedious request', async () => {
    const fake = createFakeTediousConnection();
    const adapter = new TediousConnectionAdapter(fake.connection);

    const queryPromise = adapter.query({ sql: 'select 1', timeoutMs: 1234 });
    const queryRequest = fake.getCurrentRequest()!;
    expect((queryRequest as unknown as { timeout: number }).timeout).toBe(1234);
    completeRequest(queryRequest, null, 1);
    await queryPromise;
  });
});

describe('TediousConnectionAdapter.bulkInsert', () => {
  it('stages identity rows before copying them with ordinary INSERT semantics', async () => {
    const fake = createFakeTediousConnection();
    const adapter = new TediousConnectionAdapter(fake.connection);
    const request: MssqlBulkInsertRequest = {
      schemaName: 'dbo',
      tableName: 'Items',
      columns: [
        {
          name: 'id',
          dataType: 'int',
          maxLength: 4,
          precision: 10,
          scale: 0,
          nullable: false,
          identity: true,
        },
        {
          name: 'body',
          dataType: 'nvarchar',
          maxLength: 100,
          precision: 0,
          scale: 0,
          nullable: true,
        },
      ],
      rows: [
        [41, 'first'],
        [99, 'second'],
      ],
    };

    const promise = adapter.bulkInsert(request);
    const createRequest = fake.getCurrentRequest()!;
    expect((createRequest as unknown as { sqlTextOrProcedure: string }).sqlTextOrProcedure).toMatch(
      /SELECT TOP \(0\).*INTO \[#__dbgate_restore_/s,
    );
    completeRequest(createRequest, null, 0);
    await vi.waitFor(() => expect(fake.getCurrentBulkLoad()).toBeDefined());

    expect(fake.getCurrentBulkLoad()?.table).toMatch(/^\[#__dbgate_restore_/);
    expect(fake.getCurrentBulkLoad()?.columns).toEqual(['id', 'body']);
    expect(fake.getCurrentBulkRows()).toEqual([
      [41, 'first'],
      [99, 'second'],
    ]);
    fake.completeBulk(null, 2);
    await vi.waitFor(() => expect(fake.getCurrentRequest()).not.toBe(createRequest));

    const copyRequest = fake.getCurrentRequest()!;
    expect((copyRequest as unknown as { sqlTextOrProcedure: string }).sqlTextOrProcedure).toMatch(
      /^INSERT INTO dbo\.Items.*SELECT.*FROM \[#__dbgate_restore_/s,
    );
    completeRequest(copyRequest, null, 2);
    await vi.waitFor(() => expect(fake.getCurrentRequest()).not.toBe(copyRequest));

    const dropRequest = fake.getCurrentRequest()!;
    expect((dropRequest as unknown as { sqlTextOrProcedure: string }).sqlTextOrProcedure).toMatch(
      /^DROP TABLE IF EXISTS \[#__dbgate_restore_/,
    );
    completeRequest(dropRequest, null, 0);

    await expect(promise).resolves.toEqual({ rowsAffected: 2 });
  });
});

describe('TediousConnectionAdapter: one request at a time', () => {
  it('rejects a query issued while a stream from the same connection is still being consumed', async () => {
    const fake = createFakeTediousConnection();
    const adapter = new TediousConnectionAdapter(fake.connection);

    const iterator = adapter.stream({ sql: 'select * from Big' })[Symbol.asyncIterator]();
    const first = iterator.next();
    const request = fake.getCurrentRequest()!;
    emitOn(request, 'row', row({ id: 1 }));
    await first;

    // TDS cannot interleave two requests on one session.
    await expect(adapter.query({ sql: 'select 2' })).rejects.toThrow(
      /connection-busy|Cannot start/,
    );
    await iterator.return?.(undefined);
  });

  it('names both the new and the in-flight operation, with statement text redacted', async () => {
    const fake = createFakeTediousConnection();
    const adapter = new TediousConnectionAdapter(fake.connection);

    const pending = adapter.query({
      sql: "CREATE LOGIN a WITH PASSWORD = 'super-secret-123'",
    });
    let message = '';
    try {
      await adapter.query({ sql: 'SELECT 2' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('SELECT 2');
    expect(message).toContain('CREATE LOGIN');
    expect(message).not.toContain('super-secret-123');

    completeRequest(fake.getCurrentRequest()!, null, 0);
    await pending;
  });

  it('releases the in-flight slot once the request completes, successfully or not', async () => {
    const fake = createFakeTediousConnection();
    const adapter = new TediousConnectionAdapter(fake.connection);

    const failing = adapter.query({ sql: 'select 1/0' });
    completeRequest(fake.getCurrentRequest()!, new Error('Divide by zero'));
    await expect(failing).rejects.toThrow();

    // A leaked slot would brick the adapter for every later call.
    const next = adapter.query({ sql: 'select 1' });
    completeRequest(fake.getCurrentRequest()!, null, 1);
    await expect(next).resolves.toBeDefined();
  });

  it('does not let a duplicate stale callback release a newer in-flight request', async () => {
    const fake = createFakeTediousConnection();
    const adapter = new TediousConnectionAdapter(fake.connection);

    const first = adapter.query({ sql: 'select 1' });
    const firstRequest = fake.getCurrentRequest()!;
    completeRequest(firstRequest, null, 1);
    await first;

    const second = adapter.query({ sql: 'select 2' });
    const secondRequest = fake.getCurrentRequest()!;
    completeRequest(firstRequest, null, 1);
    await expect(adapter.query({ sql: 'select 3' })).rejects.toMatchObject({
      code: 'connection-busy',
    });

    completeRequest(secondRequest, null, 1);
    await second;
  });

  it('releases the in-flight slot when execSql throws synchronously', async () => {
    const fake = createFakeTediousConnection();
    const adapter = new TediousConnectionAdapter(fake.connection);

    // Tedious rejects a request made in the wrong connection state by throwing
    // straight out of execSql, so the completion callback never runs.
    fake.setExecSqlThrows(new Error('Requests can only be made in the LoggedIn state'));
    await expect(adapter.query({ sql: 'select 1' })).rejects.toThrow(/LoggedIn state/);

    fake.setExecSqlThrows(null);
    const recovered = adapter.query({ sql: 'select 1' });
    completeRequest(fake.getCurrentRequest()!, null, 1);
    await expect(recovered).resolves.toBeDefined();
  });

  it('releases the in-flight slot when execSqlBatch throws synchronously', async () => {
    const fake = createFakeTediousConnection();
    const adapter = new TediousConnectionAdapter(fake.connection);

    fake.setExecSqlThrows(new Error('Requests can only be made in the LoggedIn state'));
    await expect(adapter.execBatch('select 1')).rejects.toThrow(/LoggedIn state/);

    fake.setExecSqlThrows(null);
    const recovered = adapter.execBatch('select 1');
    completeRequest(fake.getCurrentRequest()!, null, 1);
    await expect(recovered).resolves.toEqual({ rowsAffected: 1 });
  });
});

describe('TediousConnectionAdapter.stream', () => {
  it('yields rows as they arrive', async () => {
    const fake = createFakeTediousConnection();
    const adapter = new TediousConnectionAdapter(fake.connection);
    const iterator = adapter.stream({ sql: 'select * from Big' })[Symbol.asyncIterator]();

    const first = iterator.next();
    const request = fake.getCurrentRequest()!;
    emitOn(request, 'row', row({ id: 1 }));
    expect((await first).value).toEqual({ id: 1 });

    const second = iterator.next();
    emitOn(request, 'row', row({ id: 2 }));
    expect((await second).value).toEqual({ id: 2 });

    const done = iterator.next();
    completeRequest(request, null);
    expect((await done).done).toBe(true);
  });

  it('pauses the request once the buffered queue reaches batchSize and resumes once it drains', async () => {
    const fake = createFakeTediousConnection();
    const adapter = new TediousConnectionAdapter(fake.connection);
    const stream = adapter.stream({ sql: 'select * from Big' }, { batchSize: 2 });
    const iterator = stream[Symbol.asyncIterator]();

    const first = iterator.next();
    const request = fake.getCurrentRequest()!;
    emitOn(request, 'row', row({ id: 1 }));
    await first;

    // Consumer is now "slow": push more rows than fit under batchSize without reading them.
    emitOn(request, 'row', row({ id: 2 }));
    expect(request.paused).toBe(false);
    emitOn(request, 'row', row({ id: 3 }));
    expect(request.paused).toBe(true);
    emitOn(request, 'row', row({ id: 4 }));
    expect(request.paused).toBe(true);

    expect((await iterator.next()).value).toEqual({ id: 2 });
    expect(request.paused).toBe(true); // queue still has [3, 4], above the low-water mark of 1

    expect((await iterator.next()).value).toEqual({ id: 3 });
    expect(request.paused).toBe(false); // queue drained to [4], at/below the low-water mark

    expect((await iterator.next()).value).toEqual({ id: 4 });
  });

  it('cancels the connection and stops iterating when the signal is aborted', async () => {
    const fake = createFakeTediousConnection();
    const adapter = new TediousConnectionAdapter(fake.connection);
    const controller = new AbortController();
    const stream = adapter.stream({ sql: 'select * from Big' }, { signal: controller.signal });
    const iterator = stream[Symbol.asyncIterator]();

    const pending = iterator.next();
    controller.abort();

    await expect(pending).rejects.toThrow();
    expect(fake.getCancelCalls()).toBe(1);
  });

  it('wakes a paused/waiting stream promptly when cancel has no completion callback', async () => {
    const fake = createFakeTediousConnection();
    fake.setCompleteOnCancel(false);
    const adapter = new TediousConnectionAdapter(fake.connection);
    const controller = new AbortController();
    const stream = adapter.stream(
      { sql: 'select * from Big' },
      { signal: controller.signal, batchSize: 1 },
    );
    const iterator = stream[Symbol.asyncIterator]();

    const pending = iterator.next();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'operation-cancelled' });
    expect(fake.getCancelCalls()).toBe(1);
  });

  it('cancels the underlying request when the consumer stops iterating early', async () => {
    const fake = createFakeTediousConnection();
    const adapter = new TediousConnectionAdapter(fake.connection);
    const stream = adapter.stream({ sql: 'select * from Big' }, { batchSize: 2 });
    const iterator = stream[Symbol.asyncIterator]();

    const first = iterator.next();
    const request = fake.getCurrentRequest()!;
    emitOn(request, 'row', row({ id: 1 }));
    expect((await first).value).toEqual({ id: 1 });

    // Equivalent to a `for await` loop's `break`: it invokes the generator's
    // `return()`, which runs the same `finally` block as any other exit path.
    await iterator.return?.(undefined);

    expect(fake.getCancelCalls()).toBe(1);
  });
});

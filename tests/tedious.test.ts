import type { Connection, Request } from 'tedious';
import { describe, expect, it } from 'vitest';
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
  let cancelCalls = 0;
  let closeCalls = 0;

  const fake = {
    execSql(request: Request) {
      currentRequest = request;
    },
    cancel() {
      cancelCalls++;
      // Approximates tedious's real behavior: cancelling in-flight work
      // eventually completes the request with an error.
      (currentRequest as unknown as { callback: (err: Error) => void } | null)?.callback(
        new Error('Canceled.'),
      );
    },
    close() {
      closeCalls++;
    },
  };

  return {
    connection: fake as unknown as Connection,
    getCurrentRequest: () => currentRequest,
    getCancelCalls: () => cancelCalls,
    getCloseCalls: () => closeCalls,
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

/**
 * Optional adapter for the `tedious` package.
 *
 * Wraps a caller-owned, already-connected `tedious.Connection` as one
 * physical {@link MssqlConnection}. This module is never imported by the
 * core package; `tedious` is an optional peer dependency and only resolved
 * when a consumer imports `dbgate-mssql-dumper/tedious` themselves.
 *
 * `tedious`'s own public type declarations do not export a `ColumnMetadata`
 * or row-column type (its `row`/`columnMetadata` listener parameters are
 * typed `any`/effectively untyped at the package boundary), so this adapter
 * declares minimal local structural types for the shapes it reads and
 * narrows them at runtime rather than importing internal, unexported
 * `tedious` types.
 */
import type { ConnectionConfiguration, RequestError } from 'tedious';
import { Connection, Request, TYPES } from 'tedious';
import type {
  MssqlConnection,
  MssqlBulkColumn,
  MssqlBulkInsertRequest,
  MssqlBulkInsertResult,
  MssqlExecBatchResult,
  MssqlParameterValue,
  MssqlQuery,
  MssqlQueryParameter,
  MssqlQueryResult,
  MssqlResultColumn,
  MssqlRow,
  MssqlStreamOptions,
  MssqlTransactionStatus,
} from './connection/types.js';
import { quoteQualifiedIdentifier } from './security/identifiers.js';
import { safeSqlPreview } from './restore/batches.js';
import { MssqlDumperError, OperationCancelledError, throwIfAborted } from './utils/errors.js';

/** Rows buffered ahead of the consumer before `stream()` pauses the underlying request. */
const DEFAULT_STREAM_HIGH_WATER_MARK = 50;

interface TediousColumnMetadata {
  readonly colName: string;
  readonly nullable?: boolean;
  readonly type?: { readonly name?: string };
  readonly dataLength?: number;
  readonly precision?: number;
  readonly scale?: number;
}

interface TediousRowColumn {
  readonly metadata: TediousColumnMetadata;
  readonly value: unknown;
}

function toList<T>(value: unknown): readonly T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }
  return Object.values(value as Record<string, T>);
}

function wrapTediousError(error: RequestError | Error): MssqlDumperError {
  return new MssqlDumperError('tedious-request-failed', error.message, { cause: error });
}

function isAbortSignalError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * A short, single-line label for a statement, for use in adapter-level error
 * messages. Passed through the same credential redaction as restore previews,
 * so a failing `CREATE LOGIN ... WITH PASSWORD = '...'` cannot put the
 * password into an error message.
 */
function safeStatementLabel(sql: string): string {
  return safeSqlPreview(sql, 60);
}

function inferTediousType(value: MssqlParameterValue): (typeof TYPES)[keyof typeof TYPES] {
  if (value === null) return TYPES.NVarChar;
  if (typeof value === 'string') return TYPES.NVarChar;
  if (typeof value === 'boolean') return TYPES.Bit;
  if (typeof value === 'bigint') return TYPES.BigInt;
  if (typeof value === 'number') return Number.isInteger(value) ? TYPES.Int : TYPES.Float;
  if (value instanceof Date) return TYPES.DateTime2;
  return TYPES.VarBinary;
}

function resolveTediousType(parameter: MssqlQueryParameter): (typeof TYPES)[keyof typeof TYPES] {
  if (parameter.sqlType) {
    const match = Object.entries(TYPES).find(
      ([name]) => name.toLowerCase() === parameter.sqlType!.toLowerCase(),
    );
    if (match) {
      return match[1];
    }
  }
  return inferTediousType(parameter.value);
}

function resolveBulkType(column: MssqlBulkColumn): (typeof TYPES)[keyof typeof TYPES] {
  const aliases: Record<string, string> = {
    numeric: 'decimal',
    rowversion: 'varbinary',
    timestamp: 'varbinary',
    sysname: 'nvarchar',
  };
  const requested = aliases[column.dataType.toLowerCase()] ?? column.dataType.toLowerCase();
  const match = Object.entries(TYPES).find(([name]) => name.toLowerCase() === requested);
  if (!match) {
    throw new MssqlDumperError(
      'unsupported-bulk-type',
      `Tedious cannot bulk-load SQL Server type ${JSON.stringify(column.dataType)}`,
    );
  }
  return match[1];
}

function bulkColumnOptions(column: MssqlBulkColumn): {
  nullable: boolean;
  length?: number;
  precision?: number;
  scale?: number;
} {
  const type = column.dataType.toLowerCase();
  const options: {
    nullable: boolean;
    length?: number;
    precision?: number;
    scale?: number;
  } = { nullable: column.nullable };
  if (['char', 'varchar', 'binary', 'varbinary'].includes(type)) {
    options.length = column.maxLength === -1 ? Infinity : column.maxLength;
  } else if (['nchar', 'nvarchar', 'sysname'].includes(type)) {
    options.length = column.maxLength === -1 ? Infinity : Math.max(1, column.maxLength / 2);
  }
  if (type === 'decimal' || type === 'numeric') {
    options.precision = column.precision;
    options.scale = column.scale;
  } else if (['time', 'datetime2', 'datetimeoffset'].includes(type)) {
    options.scale = column.scale;
  }
  return options;
}

function bindParameters(
  request: Request,
  parameters: readonly MssqlQueryParameter[] | undefined,
): void {
  for (const parameter of parameters ?? []) {
    request.addParameter(parameter.name, resolveTediousType(parameter), parameter.value);
  }
}

/** Applies `query.timeoutMs` to `request`, if given. Tedious surfaces an expired timeout as a request error. */
function applyTimeout(request: Request, query: MssqlQuery): void {
  if (query.timeoutMs !== undefined) {
    request.setTimeout(query.timeoutMs);
  }
}

function toResultColumn(metadata: TediousColumnMetadata): MssqlResultColumn {
  return {
    name: metadata.colName,
    sqlType: metadata.type?.name,
    nullable: metadata.nullable,
    length: metadata.dataLength,
    precision: metadata.precision,
    scale: metadata.scale,
  };
}

function rowFromColumns<Row extends MssqlRow>(columns: unknown): Row {
  const row: Record<string, unknown> = {};
  for (const column of toList<TediousRowColumn>(columns)) {
    row[column.metadata.colName] = column.value;
  }
  return row as Row;
}

/**
 * Rejects a connection configured with `useUTC: false`.
 *
 * Tedious builds `date`/`datetime`/`datetime2`/`smalldatetime`/`time` values as
 * *local* times when `useUTC` is off, while this package renders them through
 * `toISOString()`. Every such value would then be silently shifted by the host's
 * UTC offset — a `date` of `2022-03-12` dumps as `'2022-03-11'` at UTC+2 — with
 * no error and a perfectly well-formed dump. The default is `true`; this guard
 * exists because the failure is otherwise completely invisible.
 */
function assertUsesUtc(useUTC: unknown, source: string): void {
  if (useUTC === false) {
    throw new MssqlDumperError(
      'unsupported-connection-option',
      `${source} has options.useUTC = false. This adapter requires useUTC (the tedious default) because date/time values are rendered as UTC ISO-8601 literals; with local-time values every dumped date and time would be silently shifted by the host's UTC offset.`,
    );
  }
}

/** Adapts a connected `tedious.Connection` as one physical {@link MssqlConnection}. */
export class TediousConnectionAdapter implements MssqlConnection {
  private readonly connection: Connection;
  /** Description of the request currently occupying the connection, if any. */
  private inFlight: string | null = null;

  constructor(connection: Connection) {
    assertUsesUtc(
      (connection as unknown as { config?: { options?: { useUTC?: unknown } } }).config?.options
        ?.useUTC,
      'The supplied tedious.Connection',
    );
    this.connection = connection;
  }

  /**
   * Guards against overlapping requests on one connection.
   *
   * TDS cannot interleave two requests on a single session, and tedious
   * rejects the attempt with a cryptic `EINVALIDSTATE` ("Requests can only be
   * made in the LoggedIn state, not the SentClientRequest state") that says
   * nothing about which two operations collided. Detecting it here turns that
   * into an actionable error naming both. Deliberately *not* a queue: silently
   * serializing would turn a caller bug into a deadlock whenever the pending
   * operation is itself waiting on the first one (a query issued while a
   * `stream()` from the same connection is still being consumed).
   */
  private beginRequest(description: string): () => void {
    if (this.inFlight !== null) {
      throw new MssqlDumperError(
        'connection-busy',
        `Cannot start "${description}" while "${this.inFlight}" is still in flight on the same connection. ` +
          `A single SQL Server session executes one request at a time: await each call (and finish consuming any stream()) before starting the next, or use a separate connection.`,
      );
    }
    this.inFlight = description;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.inFlight = null;
    };
  }

  async query<Row extends MssqlRow = MssqlRow>(
    query: MssqlQuery,
    signal?: AbortSignal,
  ): Promise<MssqlQueryResult<Row>> {
    throwIfAborted(signal);
    const endRequest = this.beginRequest(`query(${safeStatementLabel(query.sql)})`);
    return new Promise<MssqlQueryResult<Row>>((resolve, reject) => {
      const rows: Row[] = [];
      let columns: MssqlResultColumn[] = [];

      const request = new Request(query.sql, (error, rowCount) => {
        endRequest();
        signal?.removeEventListener('abort', onAbort);
        if (error) {
          reject(isAbortSignalError(error) ? error : wrapTediousError(error));
          return;
        }
        resolve({ rows, columns, rowsAffected: rowCount ?? 0 });
      });
      applyTimeout(request, query);
      bindParameters(request, query.parameters);

      request.on('columnMetadata', (metadata: unknown) => {
        columns = toList<TediousColumnMetadata>(metadata).map(toResultColumn);
      });
      request.on('row', (row: unknown) => {
        rows.push(rowFromColumns<Row>(row));
      });

      const onAbort = (): void => {
        // Settle promptly even if a mocked/broken driver never invokes the
        // request callback after cancel. The in-flight slot is intentionally
        // retained until that callback arrives, because TDS may still be
        // processing the attention acknowledgement.
        reject(new OperationCancelledError());
        this.connection.cancel();
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      // `execSql` can throw synchronously (tedious rejects a request made in
      // the wrong connection state that way). Without this, the completion
      // callback never runs, `endRequest()` is never called, and `inFlight`
      // stays set — permanently bricking the adapter, since every later call
      // then fails with `connection-busy`.
      try {
        this.connection.execSql(request);
      } catch (error) {
        endRequest();
        signal?.removeEventListener('abort', onAbort);
        reject(isAbortSignalError(error) ? error : wrapTediousError(error as Error));
      }
    });
  }

  /**
   * Executes `sql` via `connection.execSqlBatch()` — sent as one TDS SQL
   * batch, with no `sp_executesql` wrapping and no parameter support,
   * exactly matching how `sqlcmd`/SSMS execute a `GO`-separated batch.
   * `rowCount` in the completion callback is tedious's own running total
   * across every `DONE`/`DONE_IN_PROC` token the batch produces, so a batch
   * containing several `INSERT` statements (as `dumpMssql`'s data batches
   * do) reports their combined row count, not just the last statement's.
   */
  async execBatch(sql: string, signal?: AbortSignal): Promise<MssqlExecBatchResult> {
    throwIfAborted(signal);
    const endRequest = this.beginRequest(`execBatch(${safeStatementLabel(sql)})`);
    return new Promise<MssqlExecBatchResult>((resolve, reject) => {
      const request = new Request(sql, (error, rowCount) => {
        endRequest();
        signal?.removeEventListener('abort', onAbort);
        if (error) {
          reject(isAbortSignalError(error) ? error : wrapTediousError(error));
          return;
        }
        resolve({ rowsAffected: rowCount ?? 0 });
      });

      const onAbort = (): void => {
        reject(new OperationCancelledError());
        this.connection.cancel();
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      // See the equivalent guard in `query()`: a synchronous throw here would
      // otherwise leak `inFlight` and brick the adapter.
      try {
        this.connection.execSqlBatch(request);
      } catch (error) {
        endRequest();
        signal?.removeEventListener('abort', onAbort);
        reject(isAbortSignalError(error) ? error : wrapTediousError(error as Error));
      }
    });
  }

  /** Sends typed rows through Tedious's native TDS bulk-load stream. */
  async bulkInsert(
    request: MssqlBulkInsertRequest,
    signal?: AbortSignal,
  ): Promise<MssqlBulkInsertResult> {
    throwIfAborted(signal);
    const table = quoteQualifiedIdentifier([request.schemaName, request.tableName]);
    const endRequest = this.beginRequest(`bulkInsert(${table}, ${request.rows.length} rows)`);

    return new Promise<MssqlBulkInsertResult>((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null | undefined, rowCount?: number): void => {
        endRequest();
        signal?.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        if (error) reject(wrapTediousError(error));
        else resolve({ rowsAffected: rowCount ?? request.rows.length });
      };

      const bulkLoad = this.connection.newBulkLoad(
        table,
        {
          // Match ordinary INSERT semantics. Generated dumps create triggers
          // and constraints after data, but hand-authored compatible batches
          // must not silently bypass them.
          checkConstraints: true,
          fireTriggers: true,
          keepNulls: true,
          lockTable: true,
        },
        finish,
      );

      const onAbort = (): void => {
        if (!settled) {
          settled = true;
          reject(new OperationCancelledError());
        }
        bulkLoad.cancel();
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        for (const column of request.columns) {
          bulkLoad.addColumn(column.name, resolveBulkType(column), bulkColumnOptions(column));
        }
        this.connection.execBulkLoad(
          bulkLoad,
          request.rows.map(row => Array.from(row)),
        );
      } catch (error) {
        finish(error as Error);
      }
    });
  }

  /**
   * Streams rows with true backpressure: `request.pause()`/`resume()`
   * suspend and resume the underlying TDS row flow directly (tedious stops
   * emitting `row` events entirely while paused), so an unconsumed 10M-row
   * result set never accumulates past `options.batchSize` rows in memory,
   * regardless of how slowly the caller iterates.
   */
  stream<Row extends MssqlRow = MssqlRow>(
    query: MssqlQuery,
    options?: MssqlStreamOptions,
  ): AsyncIterable<Row> {
    const connection = this.connection;
    const signal = options?.signal;
    const highWaterMark = Math.max(1, options?.batchSize ?? DEFAULT_STREAM_HIGH_WATER_MARK);
    const lowWaterMark = Math.max(1, Math.floor(highWaterMark / 2));
    // Claimed on the first `next()` (when the generator body starts) and
    // released in its `finally`, so the connection stays reserved for as long
    // as the caller is still consuming rows.
    const beginRequest = (): (() => void) =>
      this.beginRequest(`stream(${safeStatementLabel(query.sql)})`);

    const generator = async function* (): AsyncGenerator<Row> {
      throwIfAborted(signal);
      const endRequest = beginRequest();
      const queue: Row[] = [];
      let finished = false;
      let failure: unknown = null;
      let notify: (() => void) | null = null;

      const wake = (): void => {
        notify?.();
        notify = null;
      };

      const request = new Request(query.sql, error => {
        finished = true;
        if (error && failure === null) {
          failure = isAbortSignalError(error) ? error : wrapTediousError(error);
        }
        wake();
      });
      applyTimeout(request, query);
      bindParameters(request, query.parameters);

      request.on('row', (row: unknown) => {
        queue.push(rowFromColumns<Row>(row));
        if (queue.length >= highWaterMark && !request.paused) {
          request.pause();
        }
        wake();
      });
      request.on('error', (error: Error) => {
        if (failure === null) {
          failure = wrapTediousError(error);
        }
        finished = true;
        wake();
      });

      const onAbort = (): void => {
        failure = new OperationCancelledError();
        finished = true;
        wake();
        connection.cancel();
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        connection.execSql(request);
        while (true) {
          if (queue.length > 0) {
            const row = queue.shift() as Row;
            if (request.paused && queue.length <= lowWaterMark) {
              request.resume();
            }
            yield row;
            continue;
          }
          if (failure) {
            throw failure;
          }
          if (finished) {
            return;
          }
          if (signal?.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError');
          }
          await new Promise<void>(resolve => {
            notify = resolve;
          });
        }
      } finally {
        endRequest();
        signal?.removeEventListener('abort', onAbort);
        if (!finished) {
          // The consumer stopped iterating early (`break`/`return`) or the
          // stream is unwinding after an error/abort: stop the server from
          // continuing to produce rows nobody will read, and make sure a
          // paused request is never left stuck paused.
          connection.cancel();
          if (request.paused) {
            request.resume();
          }
        }
      }
    };

    return generator();
  }

  async getTransactionStatus(signal?: AbortSignal): Promise<MssqlTransactionStatus> {
    const result = await this.query<{ trancount: number; xactstate: number }>(
      { sql: 'select @@TRANCOUNT as trancount, XACT_STATE() as xactstate' },
      signal,
    );
    const row = result.rows[0];
    if (!row || row.trancount === 0) {
      return 'idle';
    }
    if (row.xactstate === 1) {
      return 'in-transaction';
    }
    if (row.xactstate === -1) {
      return 'failed';
    }
    return 'unknown';
  }

  async cancel(): Promise<void> {
    this.connection.cancel();
  }
}

/**
 * Adapts an already-connected `tedious.Connection` as one physical
 * {@link MssqlConnection}. The caller retains ownership: this adapter never
 * calls `connection.close()`, on abort or otherwise — only
 * `connection.cancel()` to stop an in-flight statement.
 */
export function fromTediousConnection(connection: Connection): MssqlConnection {
  return new TediousConnectionAdapter(connection);
}

export interface ConnectTediousResult {
  readonly connection: MssqlConnection;
  /** Closes the underlying `tedious.Connection` this call created. */
  close(): Promise<void>;
}

/**
 * Convenience creator: establishes a new `tedious.Connection` from `config`
 * and adapts it. Unlike {@link fromTediousConnection}, the returned
 * connection is owned by the caller of *this* function, not by an
 * externally-supplied `tedious.Connection` — call `close()` when done with
 * it. Kept out of the core package (`dbgate-mssql-dumper`'s main entry point
 * never imports `tedious`); this exists only in the optional
 * `dbgate-mssql-dumper/tedious` adapter module.
 */
export function connectTedious(config: ConnectionConfiguration): Promise<ConnectTediousResult> {
  assertUsesUtc(config.options?.useUTC, 'connectTedious config');
  return new Promise((resolve, reject) => {
    const tediousConnection = new Connection(config);
    tediousConnection.connect(error => {
      if (error) {
        reject(error);
        return;
      }
      resolve({
        connection: fromTediousConnection(tediousConnection),
        close: async () => {
          tediousConnection.close();
        },
      });
    });
  });
}

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
  MssqlParameterValue,
  MssqlQuery,
  MssqlQueryParameter,
  MssqlQueryResult,
  MssqlResultColumn,
  MssqlRow,
  MssqlStreamOptions,
  MssqlTransactionStatus,
} from './connection/types.js';
import { MssqlDumperError } from './utils/errors.js';

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

/** Adapts a connected `tedious.Connection` as one physical {@link MssqlConnection}. */
export class TediousConnectionAdapter implements MssqlConnection {
  private readonly connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  async query<Row extends MssqlRow = MssqlRow>(
    query: MssqlQuery,
    signal?: AbortSignal,
  ): Promise<MssqlQueryResult<Row>> {
    return new Promise<MssqlQueryResult<Row>>((resolve, reject) => {
      const rows: Row[] = [];
      let columns: MssqlResultColumn[] = [];

      const request = new Request(query.sql, (error, rowCount) => {
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
        this.connection.cancel();
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      this.connection.execSql(request);
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

    const generator = async function* (): AsyncGenerator<Row> {
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
        if (error) {
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
        failure = wrapTediousError(error);
        finished = true;
        wake();
      });

      const onAbort = (): void => {
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

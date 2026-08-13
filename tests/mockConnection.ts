import type {
  MssqlConnection,
  MssqlQuery,
  MssqlRow,
  MssqlTransactionStatus,
} from '../src/connection/types.js';

export interface ScriptedResponse {
  /** Matched with `sql.includes(pattern)`, checked in array order; the first match wins. */
  readonly pattern: string;
  readonly rows: readonly MssqlRow[];
}

export interface ScriptedConnection extends MssqlConnection {
  readonly calls: MssqlQuery[];
}

/**
 * A fake `MssqlConnection` whose `query()` returns canned rows based on
 * which distinctive `FROM`-clause substring appears in the SQL text (e.g.
 * `"from sys.tables t"`), rather than executing anything. Every call is
 * recorded in `.calls` so tests can assert on bound parameters (in
 * particular, the `OPENJSON` object-id filter parameter) without depending
 * on exact SQL formatting elsewhere in the query.
 */
export function createScriptedConnection(
  responses: readonly ScriptedResponse[],
  options?: { transactionStatus?: MssqlTransactionStatus },
): ScriptedConnection {
  const calls: MssqlQuery[] = [];
  return {
    calls,
    async query<Row extends MssqlRow = MssqlRow>(query: MssqlQuery) {
      calls.push(query);
      const match = responses.find(response => query.sql.includes(response.pattern));
      if (!match) {
        throw new Error(`No scripted response configured for query:\n${query.sql}`);
      }
      return { rows: match.rows as readonly Row[], columns: [], rowsAffected: match.rows.length };
    },
    stream() {
      return (async function* () {})();
    },
    async cancel() {},
    async getTransactionStatus() {
      return options?.transactionStatus ?? 'idle';
    },
  };
}

/** Builds a row satisfying `MssqlRow`'s index signature from a plain object literal. */
export function row<T extends Record<string, unknown>>(values: T): MssqlRow & T {
  return values as MssqlRow & T;
}

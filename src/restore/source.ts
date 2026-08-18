import type { Readable } from 'node:stream';

/**
 * Anything {@link restoreSqlDump}/{@link streamSqlBatches} can read a SQL
 * dump from. `Readable` streams are consumed via their own async-iterable
 * protocol (`for await`), so no adapter is needed for the common case of
 * `fs.createReadStream(path)`.
 */
export type SqlDumpSource = string | Readable | AsyncIterable<string | Buffer | Uint8Array>;

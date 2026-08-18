import { Writable } from 'node:stream';
import { dumpMssql } from '../../src/api/dump.js';
import type { DumpMssqlOptions, DumpResult } from '../../src/api/types.js';
import type { MssqlConnection } from '../../src/connection/types.js';
import type { DumpProgressCallback } from '../../src/utils/progress.js';

/** Collects everything written to it, so a dump can be inspected as text. */
class CollectingWritable extends Writable {
  private readonly chunks: Buffer[] = [];

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    callback();
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }

  byteLength(): number {
    return this.chunks.reduce((total, chunk) => total + chunk.length, 0);
  }
}

export interface DumpToStringResult {
  readonly sql: string;
  readonly result: DumpResult;
  readonly byteLength: number;
}

/** Runs a full `dumpMssql` into memory and returns both the SQL text and the structured result. */
export async function dumpToString(
  connection: MssqlConnection,
  options: DumpMssqlOptions,
  onProgress?: DumpProgressCallback,
  signal?: AbortSignal,
): Promise<DumpToStringResult> {
  const output = new CollectingWritable();
  const result = await dumpMssql(connection, options, output, onProgress, signal);
  return { sql: output.text(), result, byteLength: output.byteLength() };
}

/**
 * Splits a dump into its `GO`-delimited batches using a deliberately naive,
 * line-only splitter — the exact algorithm a careless client would use.
 *
 * Used only to *demonstrate* that this package's own dumps contain batch
 * content a naive splitter would tear apart (a module body with a standalone
 * `GO` inside a string or comment), which is what makes the real lexer in
 * `src/restore/batchParser.ts` necessary. Never used to actually restore.
 */
export function naivelySplitOnGoLines(sql: string): string[] {
  const batches: string[] = [];
  let current: string[] = [];
  for (const line of sql.split(/\r?\n/)) {
    if (/^\s*GO\s*$/i.test(line)) {
      const text = current.join('\n').trim();
      if (text.length > 0) batches.push(text);
      current = [];
    } else {
      current.push(line);
    }
  }
  const tail = current.join('\n').trim();
  if (tail.length > 0) batches.push(tail);
  return batches;
}

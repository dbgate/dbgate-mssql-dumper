export interface SqlBatch {
  readonly sql: string;
  /** From a trailing `GO <n>` count; the batch is executed this many times. */
  readonly repeatCount: number;
}

/** Matches a standalone `GO` batch separator line, optionally followed by a repeat count and/or a line comment. */
const GO_LINE_PATTERN = /^\s*GO(?:\s+(\d+))?\s*(?:--.*)?$/i;

/**
 * Splits plain T-SQL script text into batches on standalone `GO` separator
 * lines, matching the convention used by `sqlcmd`/SSMS. This is a line-based
 * split, not a full T-SQL tokenizer: a `GO` that is not alone on its own
 * line (for example inside a string literal or block comment) is never
 * mistaken for a separator, but a batch separator embedded inside a
 * multi-line string that happens to occupy its own line would be. Dumps
 * produced by `renderPlainSql` never do this.
 */
export function splitSqlIntoBatches(sql: string): SqlBatch[] {
  const lines = sql.split(/\r\n|\r|\n/);
  const batches: SqlBatch[] = [];
  let current: string[] = [];

  const flush = (repeatCount: number): void => {
    const text = current.join('\n').trim();
    current = [];
    if (text.length > 0) {
      batches.push({ sql: text, repeatCount });
    }
  };

  for (const line of lines) {
    const match = GO_LINE_PATTERN.exec(line);
    if (match) {
      const repeatCount = match[1] ? Number(match[1]) : 1;
      flush(repeatCount);
      continue;
    }
    current.push(line);
  }
  flush(1);

  return batches;
}

/** Truncates SQL text for inclusion in error messages, never a full potentially large statement. */
export function safeSqlPreview(sql: string, maximumLength = 200): string {
  const normalized = sql.trim().replace(/\s+/g, ' ');
  if (normalized.length <= maximumLength) {
    return normalized;
  }
  return `${normalized.slice(0, maximumLength)}…`;
}

const DUMP_HEADER_PREFIX = '-- dbgate-mssql-dumper plain SQL dump';

/** Heuristically detects whether `sample` looks like a dump produced by {@link renderPlainSql}. */
export function isDumperSqlDump(sample: string | Uint8Array): boolean {
  const text = typeof sample === 'string' ? sample : Buffer.from(sample).toString('utf8');
  return text.trimStart().startsWith(DUMP_HEADER_PREFIX);
}

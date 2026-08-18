import { StringDecoder } from 'node:string_decoder';
import { throwIfAborted } from '../utils/errors.js';
import { safeSqlPreview } from './batches.js';
import {
  BatchTooLargeError,
  InvalidGoRepeatCountError,
  MalformedSqlDumpError,
  UnsupportedSqlcmdDirectiveError,
} from './errors.js';
import type { BatchSourceLocation } from './location.js';
import type { SqlDumpSource } from './source.js';

/** Matches a standalone `GO` separator line: optional repeat count, optional trailing line comment. */
const GO_LINE_PATTERN = /^\s*GO(?:\s+(\d+))?\s*(?:--.*)?$/i;
/** Matches any line that *starts* with the standalone word `GO` (used to detect a malformed attempt). */
const GO_WORD_AT_LINE_START = /^\s*GO\b/i;
/**
 * `sqlcmd` scripting commands (`:r`, `:setvar`, `:connect`, `!!`, ...) are
 * only recognized starting in column 1 by `sqlcmd` itself; requiring the
 * same here avoids mistaking indented T-SQL (a `CASE`/label construct using
 * `:`, or a `::` static method call) for a directive.
 */
const SQLCMD_DIRECTIVE_PATTERN = /^(?:!!|:(?:!!|[A-Za-z][A-Za-z0-9]*))/;
/** A `sqlcmd` variable substitution token, recognized outside strings/comments/brackets. */
const SQLCMD_VARIABLE_PATTERN = /^\$\(([^)]*)\)/;

const DEFAULT_MAX_BATCH_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_GO_REPEAT_COUNT = 100_000;

export interface SqlBatchParserOptions {
  /**
   * Upper bound, in UTF-8 bytes, on one batch's accumulated text before a
   * `GO` separator is found. Guards against unbounded memory growth from a
   * pathological or truncated input with no `GO` lines at all. Defaults to
   * 64 MiB.
   */
  readonly maxBatchBytes?: number;
  /**
   * Upper bound on a `GO <n>` repeat count. `sqlcmd` only documents that
   * the count must be a positive integer; this package additionally caps
   * it so a mistyped or malicious count cannot make restoration loop far
   * longer than any legitimate script would need. Defaults to 100,000.
   */
  readonly maxGoRepeatCount?: number;
}

export interface ParsedSqlBatch {
  readonly batchIndex: number;
  readonly sql: string;
  /** From a trailing `GO <n>` count; the batch must be executed this many times. Always >= 1. */
  readonly repeatCount: number;
  readonly location: BatchSourceLocation;
}

type LexerMode = 'normal' | 'singleQuote' | 'doubleQuote' | 'bracket' | 'blockComment';

const OPEN_CONSTRUCT_NAME: Record<Exclude<LexerMode, 'normal'>, string> = {
  singleQuote: "single-quoted string ('...')",
  doubleQuote: 'double-quoted identifier/string ("...")',
  bracket: 'bracketed identifier ([...])',
  blockComment: 'block comment (/* ... */)',
};

/**
 * Scans one line's text starting from `mode`, updating lexer state for
 * strings, bracketed/double-quoted identifiers, and (possibly nested, which
 * SQL Server itself supports) block comments. Line comments (`--`) always
 * end at the line's own end, so they never persist across lines and need no
 * mode of their own. Throws {@link UnsupportedSqlcmdDirectiveError} on a
 * `$(Variable)` substitution token found outside any of the above, since
 * that is only ever meaningful as `sqlcmd` preprocessing input.
 */
class LineScanner {
  mode: LexerMode = 'normal';
  /** Line on which the currently-open construct (if `mode !== 'normal'`) started. */
  openLine = 0;

  scan(line: string, lineNumber: number): void {
    let i = 0;
    const len = line.length;
    while (i < len) {
      const ch = line[i];
      switch (this.mode) {
        case 'normal': {
          if (ch === "'") {
            this.mode = 'singleQuote';
            this.openLine = lineNumber;
            i++;
          } else if (ch === '"') {
            this.mode = 'doubleQuote';
            this.openLine = lineNumber;
            i++;
          } else if (ch === '[') {
            this.mode = 'bracket';
            this.openLine = lineNumber;
            i++;
          } else if (ch === '-' && line[i + 1] === '-') {
            i = len; // line comment: consume the rest of the line
          } else if (ch === '/' && line[i + 1] === '*') {
            this.mode = 'blockComment';
            this.blockCommentDepth = 1;
            this.openLine = lineNumber;
            i += 2;
          } else if (ch === '$') {
            const variableMatch = SQLCMD_VARIABLE_PATTERN.exec(line.slice(i));
            if (variableMatch) {
              throw new UnsupportedSqlcmdDirectiveError(variableMatch[0], lineNumber);
            }
            i++;
          } else {
            i++;
          }
          break;
        }
        case 'singleQuote': {
          if (ch === "'") {
            if (line[i + 1] === "'") {
              i += 2;
            } else {
              this.mode = 'normal';
              i++;
            }
          } else {
            i++;
          }
          break;
        }
        case 'doubleQuote': {
          if (ch === '"') {
            if (line[i + 1] === '"') {
              i += 2;
            } else {
              this.mode = 'normal';
              i++;
            }
          } else {
            i++;
          }
          break;
        }
        case 'bracket': {
          if (ch === ']') {
            if (line[i + 1] === ']') {
              i += 2;
            } else {
              this.mode = 'normal';
              i++;
            }
          } else {
            i++;
          }
          break;
        }
        case 'blockComment': {
          if (ch === '/' && line[i + 1] === '*') {
            this.blockCommentDepth++;
            i += 2;
          } else if (ch === '*' && line[i + 1] === '/') {
            this.blockCommentDepth--;
            i += 2;
            if (this.blockCommentDepth === 0) {
              this.mode = 'normal';
            }
          } else {
            i++;
          }
          break;
        }
      }
    }
  }

  private blockCommentDepth = 0;
}

/**
 * One physical source line, together with the exact terminator that ended
 * it. The terminator is kept rather than normalized because a newline inside
 * a string literal is *data*: rejoining batches with a hardcoded `\n` would
 * silently rewrite every `\r\n` a dumped text value contains into `\n`,
 * changing the restored data.
 */
interface PhysicalLine {
  readonly text: string;
  /** `'\n'`, `'\r\n'`, `'\r'`, or `''` for the final line of the input. */
  readonly terminator: string;
}

/**
 * Incrementally splits plain T-SQL script text into `GO`-separated batches,
 * recognizing `GO` only when it is a real standalone batch separator: alone
 * on its own logical line, outside any string/bracketed identifier/comment.
 * `PRINT 'GO'` and a `GO` inside a comment never split a batch; a `GO`
 * inside a multi-line string/comment is likewise never mistaken for one,
 * because separator detection is gated on the lexer being in `'normal'`
 * mode at the start of that line.
 *
 * Feed text via {@link push}; call {@link finish} once at end of input to
 * flush the final batch and validate that no string/bracket/comment was
 * left open. Memory is bounded on every path: only the current batch's text
 * plus one incomplete trailing line is retained, and
 * `options.maxBatchBytes` is checked against *both* — so a terminator-free
 * input (a whole script on one physical line) fails fast with
 * {@link BatchTooLargeError} instead of growing without limit. Incoming
 * chunks are also never re-concatenated onto the accumulated tail, so
 * feeding a large input in many small chunks stays linear rather than
 * quadratic.
 */
export class SqlBatchParser {
  private readonly maxBatchBytes: number;
  private readonly maxGoRepeatCount: number;
  private readonly scanner = new LineScanner();

  /** Fragments of the current, not-yet-terminated physical line. Joined only once it ends. */
  private pendingChunks: string[] = [];
  private pendingBytes = 0;
  private currentLineNumber = 0;
  /** Alternating line text and its original terminator, so `flush` can rebuild the source exactly. */
  private batchSegments: string[] = [];
  private batchByteLength = 0;
  private batchStartLine: number | null = null;
  private lastAppendedLine: number | null = null;
  private nextBatchIndex = 0;
  private finished = false;

  constructor(options?: SqlBatchParserOptions) {
    this.maxBatchBytes = options?.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
    this.maxGoRepeatCount = options?.maxGoRepeatCount ?? DEFAULT_MAX_GO_REPEAT_COUNT;
  }

  push(chunkText: string): ParsedSqlBatch[] {
    if (this.finished) {
      throw new Error('SqlBatchParser.push() called after finish()');
    }
    if (chunkText.length === 0) {
      return [];
    }

    const batches: ParsedSqlBatch[] = [];
    const emit = (line: PhysicalLine): void => {
      const batch = this.processLine(line);
      if (batch) {
        batches.push(batch);
      }
    };

    let chunk = chunkText;

    // A `\r` that ended the previous chunk was deferred, because only now
    // can we tell whether it was a lone CR or the first half of a CRLF pair.
    if (this.pendingEndsWithCarriageReturn()) {
      const isCrLf = chunk.startsWith('\n');
      if (isCrLf) {
        chunk = chunk.slice(1);
      }
      const pending = this.takePending();
      emit({ text: pending.slice(0, -1), terminator: isCrLf ? '\r\n' : '\r' });
    }

    let start = 0;
    let i = 0;
    while (i < chunk.length) {
      const ch = chunk[i];
      if (ch === '\n') {
        emit({ text: this.takePending() + chunk.slice(start, i), terminator: '\n' });
        i++;
        start = i;
      } else if (ch === '\r') {
        if (i + 1 >= chunk.length) {
          // Trailing CR: defer, its partner `\n` may open the next chunk.
          break;
        }
        const isCrLf = chunk[i + 1] === '\n';
        emit({
          text: this.takePending() + chunk.slice(start, i),
          terminator: isCrLf ? '\r\n' : '\r',
        });
        i += isCrLf ? 2 : 1;
        start = i;
      } else {
        i++;
      }
    }

    this.appendPending(chunk.slice(start));
    return batches;
  }

  finish(): ParsedSqlBatch[] {
    if (this.finished) {
      throw new Error('SqlBatchParser.finish() called more than once');
    }
    this.finished = true;

    // A deferred trailing `\r` can no longer become a CRLF pair; treat it as
    // the terminator of the final line. `String.prototype.split` likewise
    // always yields a final (possibly empty) segment, and the empty tail is
    // trimmed away by `flush`.
    const pending = this.takePending();
    const endsWithCr = pending.endsWith('\r');

    const batches: ParsedSqlBatch[] = [];
    const finalLineBatch = this.processLine({
      text: endsWithCr ? pending.slice(0, -1) : pending,
      terminator: endsWithCr ? '\r' : '',
    });
    if (finalLineBatch) {
      batches.push(finalLineBatch);
    }

    if (this.scanner.mode !== 'normal') {
      throw new MalformedSqlDumpError(
        OPEN_CONSTRUCT_NAME[this.scanner.mode],
        this.scanner.openLine,
      );
    }

    const finalBatch = this.flush(1);
    if (finalBatch) {
      batches.push(finalBatch);
    }
    return batches;
  }

  private pendingEndsWithCarriageReturn(): boolean {
    const last = this.pendingChunks[this.pendingChunks.length - 1];
    return last !== undefined && last.endsWith('\r');
  }

  /** Joins and clears the accumulated fragments of the current physical line. */
  private takePending(): string {
    const text =
      this.pendingChunks.length === 1 ? this.pendingChunks[0]! : this.pendingChunks.join('');
    this.pendingChunks = [];
    this.pendingBytes = 0;
    return text;
  }

  private appendPending(text: string): void {
    if (text.length === 0) {
      return;
    }
    this.pendingChunks.push(text);
    this.pendingBytes += Buffer.byteLength(text, 'utf8');
    // The incomplete line counts toward the batch limit too: without this,
    // an input containing no line terminator at all would accumulate here
    // forever, never reaching the check in `appendLine`.
    this.enforceBatchByteLimit();
  }

  private enforceBatchByteLimit(): void {
    if (this.batchByteLength + this.pendingBytes > this.maxBatchBytes) {
      throw new BatchTooLargeError(
        this.maxBatchBytes,
        this.batchStartLine ?? this.currentLineNumber + 1,
      );
    }
  }

  /** Processes one complete physical line; returns a batch if this line was a valid `GO` separator that closed one. */
  private processLine(line: PhysicalLine): ParsedSqlBatch | null {
    this.currentLineNumber++;
    const lineNumber = this.currentLineNumber;
    const { text } = line;

    if (this.scanner.mode === 'normal') {
      const goMatch = GO_LINE_PATTERN.exec(text);
      if (goMatch) {
        const rawCount = goMatch[1];
        const repeatCount = rawCount === undefined ? 1 : Number(rawCount);
        if (rawCount !== undefined) {
          if (repeatCount < 1) {
            throw new InvalidGoRepeatCountError(
              rawCount,
              lineNumber,
              'the repeat count must be a positive integer',
            );
          }
          if (repeatCount > this.maxGoRepeatCount) {
            throw new InvalidGoRepeatCountError(
              rawCount,
              lineNumber,
              `the repeat count must not exceed ${this.maxGoRepeatCount} (see options.maxGoRepeatCount)`,
            );
          }
        }
        return this.flush(repeatCount);
      }

      if (GO_WORD_AT_LINE_START.test(text)) {
        // Truncated and credential-redacted: the remainder of the line is
        // arbitrary user SQL. A script written entirely on one line (`GO CREATE
        // LOGIN app WITH PASSWORD = '…'`) would otherwise put the password —
        // and up to `maxBatchBytes` of text — straight into the error message
        // and the public `rawToken`.
        const rest = safeSqlPreview(text.replace(GO_WORD_AT_LINE_START, ''), 60);
        throw new InvalidGoRepeatCountError(
          rest,
          lineNumber,
          'expected nothing or a positive integer repeat count after "GO"',
        );
      }

      const directiveMatch = SQLCMD_DIRECTIVE_PATTERN.exec(text);
      if (directiveMatch) {
        throw new UnsupportedSqlcmdDirectiveError(directiveMatch[0], lineNumber);
      }
    }

    this.scanner.scan(text, lineNumber);
    this.appendLine(line, lineNumber);
    return null;
  }

  private appendLine(line: PhysicalLine, lineNumber: number): void {
    // Location tracking ignores blank lines, because `flush` trims the batch
    // text: counting them would report a `startLine` pointing at the blank line
    // before a batch (every dump with `includeDropStatements` has one) or an
    // `endLine` past the last real line whenever the input ends with a newline.
    // The segment itself is still appended, so `flush` rebuilds exact bytes.
    if (line.text.trim().length > 0) {
      if (this.batchStartLine === null) {
        this.batchStartLine = lineNumber;
      }
      this.lastAppendedLine = lineNumber;
    }
    // Text and terminator are kept as separate segments so `flush` rebuilds
    // the original bytes, CR/CRLF included (see `PhysicalLine`).
    this.batchSegments.push(line.text, line.terminator);
    this.batchByteLength += Buffer.byteLength(line.text, 'utf8') + line.terminator.length;
    this.enforceBatchByteLimit();
  }

  private flush(repeatCount: number): ParsedSqlBatch | null {
    const text = this.batchSegments.join('').trim();
    const location: BatchSourceLocation = {
      startLine: this.batchStartLine ?? this.currentLineNumber,
      endLine: this.lastAppendedLine ?? this.currentLineNumber,
    };
    this.batchSegments = [];
    this.batchByteLength = 0;
    this.batchStartLine = null;
    this.lastAppendedLine = null;

    if (text.length === 0) {
      return null;
    }
    return { batchIndex: this.nextBatchIndex++, sql: text, repeatCount, location };
  }
}

/** Parses a complete, already-in-memory SQL script into batches. A convenience wrapper for {@link SqlBatchParser} over one string. */
export function parseSqlBatches(sql: string, options?: SqlBatchParserOptions): ParsedSqlBatch[] {
  const parser = new SqlBatchParser(options);
  return [...parser.push(sql), ...parser.finish()];
}

async function* toTextChunks(source: SqlDumpSource): AsyncGenerator<string> {
  if (typeof source === 'string') {
    yield source;
    return;
  }
  const decoder = new StringDecoder('utf8');
  for await (const chunk of source as AsyncIterable<string | Buffer | Uint8Array>) {
    if (typeof chunk === 'string') {
      yield chunk;
    } else {
      yield decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  }
  const tail = decoder.end();
  if (tail.length > 0) {
    yield tail;
  }
}

/**
 * Streams `source` (a string, a `Readable`, or any `AsyncIterable` of text
 * chunks) into {@link ParsedSqlBatch}es without ever buffering the whole
 * input: at most the current batch's accumulated text, plus one pending
 * partial line, is held at a time. `Buffer`/`Uint8Array` chunks are decoded
 * as UTF-8 with a persistent `StringDecoder`, so a multi-byte character
 * split across two chunks is never corrupted.
 */
export async function* streamSqlBatches(
  source: SqlDumpSource,
  options?: SqlBatchParserOptions,
  signal?: AbortSignal,
): AsyncGenerator<ParsedSqlBatch> {
  const parser = new SqlBatchParser(options);
  for await (const chunk of toTextChunks(source)) {
    throwIfAborted(signal);
    for (const batch of parser.push(chunk)) {
      yield batch;
    }
  }
  throwIfAborted(signal);
  for (const batch of parser.finish()) {
    yield batch;
  }
}

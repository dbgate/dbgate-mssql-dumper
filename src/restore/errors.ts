import { MssqlDumperError } from '../utils/errors.js';
import type { BatchSourceLocation } from './location.js';

/** Common base for every error {@link restoreSqlDump} (or the batch parser it uses) throws intentionally. */
export class RestoreError extends MssqlDumperError {}

/**
 * The input could not be split into batches correctly. Always fatal: unlike
 * a batch that fails when executed against the server (see
 * {@link RestoreExecutionError}), a parse failure means the batch boundaries
 * themselves are not trustworthy, so nothing after the failure point can be
 * safely executed either.
 */
export class SqlBatchParseError extends RestoreError {
  readonly line: number;

  constructor(code: string, message: string, line: number, options?: { cause?: unknown }) {
    super(code, message, options);
    this.name = 'SqlBatchParseError';
    this.line = line;
  }
}

/**
 * The input ended while a lexical construct (string, bracketed identifier,
 * block comment) was still open — for example a missing closing quote. The
 * script is structurally incomplete and cannot be split into valid batches.
 */
export class MalformedSqlDumpError extends SqlBatchParseError {
  readonly openConstruct: string;

  constructor(openConstruct: string, line: number) {
    super(
      'malformed-sql-dump',
      `Unterminated ${openConstruct} starting at line ${line}: the input ends before it is closed`,
      line,
    );
    this.name = 'MalformedSqlDumpError';
    this.openConstruct = openConstruct;
  }
}

/**
 * A line was recognized as an attempted `GO` batch separator (the line
 * starts with the standalone word `GO`) but its trailing content is not a
 * valid, in-range repeat count — for example `GO 0`, `GO abc`, or a count
 * exceeding {@link SqlBatchParserOptions.maxGoRepeatCount}.
 */
export class InvalidGoRepeatCountError extends SqlBatchParseError {
  readonly rawToken: string;

  constructor(rawToken: string, line: number, reason: string) {
    super(
      'invalid-go-repeat-count',
      `Invalid "GO" repeat count on line ${line}: ${reason} (found "${rawToken}")`,
      line,
    );
    this.name = 'InvalidGoRepeatCountError';
    this.rawToken = rawToken;
  }
}

/**
 * A `sqlcmd` scripting construct was found outside any string/comment —
 * either a colon-prefixed directive (`:r`, `:setvar`, `:connect`, `:!!`,
 * ...), a standard `!!` shell escape, or a `$(Variable)` substitution token. These are preprocessed by
 * `sqlcmd`/SSMS before the batch ever reaches SQL Server; this package
 * executes batches directly against the connection and does not implement a
 * `sqlcmd` preprocessor, so a script relying on one cannot be restored
 * as-is (see docs/architecture.md for the supported subset).
 */
export class UnsupportedSqlcmdDirectiveError extends SqlBatchParseError {
  readonly directive: string;

  constructor(directive: string, line: number) {
    super(
      'unsupported-sqlcmd-directive',
      `Unsupported sqlcmd scripting construct "${directive}" on line ${line}: dbgate-mssql-dumper restores plain T-SQL batches only and does not implement sqlcmd directives or variable substitution`,
      line,
    );
    this.name = 'UnsupportedSqlcmdDirectiveError';
    this.directive = directive;
  }
}

/**
 * One batch's accumulated text exceeded
 * {@link SqlBatchParserOptions.maxBatchBytes} before a `GO` separator (or
 * end of input) was found. A single T-SQL batch must be sent to the server
 * whole, so this is the parser's bound on how much of a pathological input
 * (a huge script with no `GO` lines at all) it will buffer before giving up
 * rather than growing unboundedly.
 */
export class BatchTooLargeError extends SqlBatchParseError {
  readonly maxBatchBytes: number;

  constructor(maxBatchBytes: number, line: number) {
    super(
      'batch-too-large',
      `Batch starting near line ${line} exceeds the configured limit of ${maxBatchBytes} bytes without a "GO" separator; increase options.maxBatchBytes if this batch is genuinely intended to be this large`,
      line,
    );
    this.name = 'BatchTooLargeError';
    this.maxBatchBytes = maxBatchBytes;
  }
}

/**
 * A batch parsed successfully but failed when executed against the
 * connection. Unlike a parse error, this is scoped to one batch: with
 * `stopOnError: false`, restoration continues with the next batch, and this
 * error's data (never the raw underlying driver error, which could in
 * principle echo back parts of the failing statement) is what is recorded
 * in {@link SqlDumpRestoreResult.errors}.
 */
export class RestoreExecutionError extends RestoreError {
  readonly batchIndex: number;
  readonly location: BatchSourceLocation;
  readonly sqlPreview: string;

  constructor(
    batchIndex: number,
    location: BatchSourceLocation,
    sqlPreview: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super('restore-execution-failed', message, options);
    this.name = 'RestoreExecutionError';
    this.batchIndex = batchIndex;
    this.location = location;
    this.sqlPreview = sqlPreview;
  }
}

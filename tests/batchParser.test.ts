import { describe, expect, it } from 'vitest';
import {
  parseSqlBatches,
  SqlBatchParser,
  streamSqlBatches,
  type ParsedSqlBatch,
} from '../src/restore/batchParser.js';
import {
  BatchTooLargeError,
  InvalidGoRepeatCountError,
  MalformedSqlDumpError,
  UnsupportedSqlcmdDirectiveError,
} from '../src/restore/errors.js';

function sqlOf(batches: readonly ParsedSqlBatch[]): string[] {
  return batches.map(b => b.sql);
}

describe('parseSqlBatches: standalone GO detection', () => {
  it('splits on standalone GO lines', () => {
    const batches = parseSqlBatches('SELECT 1;\nGO\nSELECT 2;\nGO\n');
    expect(sqlOf(batches)).toEqual(['SELECT 1;', 'SELECT 2;']);
    expect(batches.every(b => b.repeatCount === 1)).toBe(true);
  });

  it('includes a trailing batch with no final GO', () => {
    const batches = parseSqlBatches('SELECT 1;\nGO\nSELECT 2;');
    expect(sqlOf(batches)).toEqual(['SELECT 1;', 'SELECT 2;']);
  });

  it('tolerates leading/trailing whitespace and a trailing comment on the GO line', () => {
    const batches = parseSqlBatches('SELECT 1;\n   GO   -- separator\nSELECT 2;\nGO\n');
    expect(sqlOf(batches)).toEqual(['SELECT 1;', 'SELECT 2;']);
  });

  it('honors a GO repeat count', () => {
    const batches = parseSqlBatches('PRINT 1;\nGO 3\n');
    expect(batches).toEqual([
      { batchIndex: 0, sql: 'PRINT 1;', repeatCount: 3, location: { startLine: 1, endLine: 1 } },
    ]);
  });

  it('does not emit a batch for whitespace-only content between two GO lines', () => {
    const batches = parseSqlBatches('SELECT 1;\nGO\n\n   \n\nGO\nSELECT 2;\nGO\n');
    expect(sqlOf(batches)).toEqual(['SELECT 1;', 'SELECT 2;']);
  });

  it('still emits a comment-only batch between two GO lines (only whitespace is trimmed, not comments)', () => {
    const batches = parseSqlBatches('SELECT 1;\nGO\n-- just a comment\nGO\nSELECT 2;\nGO\n');
    expect(sqlOf(batches)).toEqual(['SELECT 1;', '-- just a comment', 'SELECT 2;']);
  });

  it('assigns sequential batchIndex and 1-based line locations', () => {
    const batches = parseSqlBatches('SELECT 1;\nGO\nSELECT 2;\nSELECT 3;\nGO\n');
    expect(batches).toEqual([
      { batchIndex: 0, sql: 'SELECT 1;', repeatCount: 1, location: { startLine: 1, endLine: 1 } },
      {
        batchIndex: 1,
        sql: 'SELECT 2;\nSELECT 3;',
        repeatCount: 1,
        location: { startLine: 3, endLine: 4 },
      },
    ]);
  });
});

describe('parseSqlBatches: GO must be a real standalone separator', () => {
  it('does not split on "GO" that is not alone on its line', () => {
    const batches = parseSqlBatches("SELECT 'GO home';\nGO\n");
    expect(sqlOf(batches)).toEqual(["SELECT 'GO home';"]);
  });

  it("does not split PRINT 'GO'", () => {
    const batches = parseSqlBatches("PRINT 'GO';\nGO\n");
    expect(sqlOf(batches)).toEqual(["PRINT 'GO';"]);
  });

  it('does not treat GOTO as a batch separator', () => {
    const batches = parseSqlBatches('WHILE 1 = 1\nBEGIN\n  GOTO Done;\nEND\nDone:\nGO\n');
    expect(batches).toHaveLength(1);
    expect(batches[0]!.sql).toContain('GOTO Done;');
  });

  it('does not split a GO appearing inside a line comment', () => {
    const batches = parseSqlBatches('SELECT 1; -- GO\nGO\n');
    expect(sqlOf(batches)).toEqual(['SELECT 1; -- GO']);
  });

  it('does not split a GO appearing inside a single-quoted string, including one spanning multiple lines', () => {
    const batches = parseSqlBatches("INSERT INTO T (Msg) VALUES ('line one\nGO\nline two');\nGO\n");
    expect(sqlOf(batches)).toEqual(["INSERT INTO T (Msg) VALUES ('line one\nGO\nline two');"]);
  });

  it('does not split a GO appearing inside a single-line block comment', () => {
    const batches = parseSqlBatches('SELECT 1; /* GO */\nGO\n');
    expect(sqlOf(batches)).toEqual(['SELECT 1; /* GO */']);
  });

  it('does not split a GO appearing inside a multi-line block comment', () => {
    const batches = parseSqlBatches('/*\nGO\n*/\nSELECT 1;\nGO\n');
    expect(sqlOf(batches)).toEqual(['/*\nGO\n*/\nSELECT 1;']);
  });

  it('does not split a GO appearing inside a nested block comment', () => {
    const batches = parseSqlBatches(
      '/* outer /* inner GO inner-end */ still outer */\nSELECT 1;\nGO\n',
    );
    expect(sqlOf(batches)).toEqual(['/* outer /* inner GO inner-end */ still outer */\nSELECT 1;']);
  });

  it('does not split a GO appearing inside a bracketed identifier', () => {
    const batches = parseSqlBatches('CREATE TABLE [dbo].[Foo GO Bar] (Id INT);\nGO\n');
    expect(sqlOf(batches)).toEqual(['CREATE TABLE [dbo].[Foo GO Bar] (Id INT);']);
  });

  it('does not split a GO appearing inside a bracketed identifier spanning multiple lines', () => {
    const batches = parseSqlBatches('SELECT 1 AS [Col\nGO\nName];\nGO\n');
    expect(sqlOf(batches)).toEqual(['SELECT 1 AS [Col\nGO\nName];']);
  });

  it('handles a doubled `]]` escape inside a bracketed identifier without closing it early', () => {
    const batches = parseSqlBatches('SELECT 1 AS [Weird]]Name];\nGO\n');
    expect(sqlOf(batches)).toEqual(['SELECT 1 AS [Weird]]Name];']);
  });

  it("handles a doubled `''` escape inside a string without closing it early", () => {
    const batches = parseSqlBatches("INSERT INTO T (Msg) VALUES ('it''s fine');\nGO\n");
    expect(sqlOf(batches)).toEqual(["INSERT INTO T (Msg) VALUES ('it''s fine');"]);
  });

  it('does not split a GO appearing inside a double-quoted identifier', () => {
    const batches = parseSqlBatches('SELECT 1 AS "GO Column";\nGO\n');
    expect(sqlOf(batches)).toEqual(['SELECT 1 AS "GO Column";']);
  });

  it('keeps a whole CREATE PROCEDURE module body as one batch despite embedded GO-like text', () => {
    const sql = [
      'CREATE PROCEDURE dbo.Foo',
      'AS',
      'BEGIN',
      "  PRINT 'not a separator: GO';",
      '  /* comment mentions GO here',
      '     and here: GO */',
      '  SELECT 1;',
      'END',
    ].join('\n');
    const batches = parseSqlBatches(`${sql}\nGO\n`);
    expect(sqlOf(batches)).toEqual([sql]);
  });
});

describe('parseSqlBatches: invalid GO repeat counts', () => {
  it('rejects GO 0', () => {
    expect(() => parseSqlBatches('PRINT 1;\nGO 0\n')).toThrow(InvalidGoRepeatCountError);
  });

  it('rejects a non-numeric GO argument', () => {
    expect(() => parseSqlBatches('PRINT 1;\nGO abc\n')).toThrow(InvalidGoRepeatCountError);
  });

  it('rejects a negative GO argument', () => {
    expect(() => parseSqlBatches('PRINT 1;\nGO -1\n')).toThrow(InvalidGoRepeatCountError);
  });

  it('rejects a GO repeat count above the configured maximum', () => {
    expect(() => parseSqlBatches('PRINT 1;\nGO 5\n', { maxGoRepeatCount: 4 })).toThrow(
      InvalidGoRepeatCountError,
    );
  });

  it('accepts a GO repeat count within a raised maximum', () => {
    const batches = parseSqlBatches('PRINT 1;\nGO 500000\n', { maxGoRepeatCount: 1_000_000 });
    expect(batches[0]!.repeatCount).toBe(500000);
  });

  it('reports the offending line number', () => {
    try {
      parseSqlBatches('PRINT 1;\nGO xyz\n');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidGoRepeatCountError);
      expect((error as InvalidGoRepeatCountError).line).toBe(2);
      expect((error as InvalidGoRepeatCountError).rawToken).toBe('xyz');
    }
  });
});

describe('parseSqlBatches: unsupported sqlcmd directives', () => {
  it.each([':setvar DbName MyDb', ':r shared.sql', ':connect server', ':!! dir', ':on error exit'])(
    'rejects the sqlcmd directive "%s"',
    directiveLine => {
      expect(() => parseSqlBatches(`${directiveLine}\nSELECT 1;\nGO\n`)).toThrow(
        UnsupportedSqlcmdDirectiveError,
      );
    },
  );

  it('rejects a $(Variable) substitution token outside any string/comment', () => {
    expect(() => parseSqlBatches('USE $(DbName);\nGO\n')).toThrow(UnsupportedSqlcmdDirectiveError);
  });

  it('does not flag a $(...)-shaped token that appears inside a string literal', () => {
    const batches = parseSqlBatches("PRINT 'literal text: $(NotAVariable)';\nGO\n");
    expect(sqlOf(batches)).toEqual(["PRINT 'literal text: $(NotAVariable)';"]);
  });

  it('does not flag an indented colon, since sqlcmd directives must start in column 1', () => {
    const batches = parseSqlBatches('  :setvar Looks Like A Directive But Is Indented\nGO\n');
    expect(batches).toHaveLength(1);
  });

  it('reports the offending line number and directive text', () => {
    try {
      parseSqlBatches('SELECT 1;\n:setvar X 1\nGO\n');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedSqlcmdDirectiveError);
      expect((error as UnsupportedSqlcmdDirectiveError).line).toBe(2);
      expect((error as UnsupportedSqlcmdDirectiveError).directive).toBe(':setvar');
    }
  });
});

describe('parseSqlBatches: malformed input', () => {
  it('throws when a single-quoted string is never closed', () => {
    expect(() => parseSqlBatches("SELECT 'unterminated;\nGO\n")).toThrow(MalformedSqlDumpError);
  });

  it('throws when a bracketed identifier is never closed', () => {
    expect(() => parseSqlBatches('SELECT 1 AS [unterminated;\nGO\n')).toThrow(
      MalformedSqlDumpError,
    );
  });

  it('throws when a block comment is never closed', () => {
    expect(() => parseSqlBatches('/* unterminated\nSELECT 1;\nGO\n')).toThrow(
      MalformedSqlDumpError,
    );
  });

  it('throws when a nested block comment only closes its inner level', () => {
    expect(() => parseSqlBatches('/* outer /* inner */\nSELECT 1;\nGO\n')).toThrow(
      MalformedSqlDumpError,
    );
  });

  it('reports the line the unterminated construct started on', () => {
    try {
      parseSqlBatches("SELECT 1;\nSELECT 'unterminated;\n");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MalformedSqlDumpError);
      expect((error as MalformedSqlDumpError).line).toBe(2);
      expect((error as MalformedSqlDumpError).openConstruct).toContain('string');
    }
  });

  it('rejects a batch exceeding the configured byte limit with no GO separator', () => {
    const huge = `SELECT '${'x'.repeat(1000)}';\n`.repeat(100);
    expect(() => parseSqlBatches(huge, { maxBatchBytes: 1000 })).toThrow(BatchTooLargeError);
  });

  it('redacts and truncates the offending text in a malformed-GO error', () => {
    // The remainder of the line is arbitrary user SQL. A script written on one
    // line puts a credential — and potentially megabytes of text — into both
    // the message and the public `rawToken`.
    try {
      parseSqlBatches("GO CREATE LOGIN app WITH PASSWORD = 'super-secret-123';");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidGoRepeatCountError);
      const invalid = error as InvalidGoRepeatCountError;
      expect(invalid.message).not.toContain('super-secret-123');
      expect(invalid.rawToken).not.toContain('super-secret-123');
      expect(invalid.rawToken).toContain('REDACTED');
    }
  });

  it('bounds the malformed-GO error message even for a huge single line', () => {
    try {
      parseSqlBatches(`GO ${'x'.repeat(500_000)}`);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidGoRepeatCountError);
      expect((error as InvalidGoRepeatCountError).message.length).toBeLessThan(300);
    }
  });
});

describe('SqlBatchParser: large inputs succeed and stay linear', () => {
  it('parses a multi-megabyte batch fed in small chunks, preserving it exactly', () => {
    // The success path at scale: previously only the *failure* path (exceeding
    // maxBatchBytes) had any large-input coverage.
    const row = "(1, N'padding padding padding padding padding'),\n";
    const body = `INSERT INTO [dbo].[T] (Id, V) VALUES\n${row.repeat(50_000)}(2, N'last');`;
    const source = `${body}\nGO\n`;
    expect(Buffer.byteLength(source, 'utf8')).toBeGreaterThan(2 * 1024 * 1024);

    const started = process.hrtime.bigint();
    const parser = new SqlBatchParser();
    const batches: ParsedSqlBatch[] = [];
    for (let i = 0; i < source.length; i += 4096) {
      batches.push(...parser.push(source.slice(i, i + 4096)));
    }
    batches.push(...parser.finish());
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(batches).toHaveLength(1);
    expect(batches[0]!.sql).toBe(body);
    // Quadratic re-concatenation of the pending tail would blow far past this.
    expect(elapsedMs).toBeLessThan(5_000);
  });
});

describe('SqlBatchParser: chunk-boundary independence', () => {
  /**
   * Deliberately packs every lexical construct the scanner tracks into one
   * input, so feeding it one byte at a time splits each *two-character*
   * delimiter across a `push()` boundary: `/`+`*`, `*`+`/`, `]`+`]`, `'`+`'`,
   * `"`+`"`, `-`+`-`, `$`+`(`, and `\r`+`\n`. A mode transition that is only
   * mishandled when its delimiter straddles a chunk is otherwise invisible.
   */
  const SAMPLE = [
    'CREATE TABLE [dbo].[Foo]]Bar] (Id INT, "Odd""Name" NVARCHAR(50) DEFAULT \'it\'\'s\');',
    'GO',
    '/* outer /* nested */ still outer',
    '   mentioning GO here */',
    'INSERT INTO [dbo].[Foo]]Bar] (Id, "Odd""Name") VALUES (1, N\'a 🚀 astral\'), (2, \'literal $(NotAVariable)\'); -- trailing GO in comment',
    'GO 2',
    "PRINT 'not a GO separator: GO';",
    'GO',
    "PRINT N'crlf\r\nembedded in data';",
    'GO',
    'SELECT 1 AS [GO];',
    '',
  ].join('\n');

  function parseInChunksOf(chunkSize: number): ParsedSqlBatch[] {
    const parser = new SqlBatchParser();
    const batches: ParsedSqlBatch[] = [];
    for (let i = 0; i < SAMPLE.length; i += chunkSize) {
      batches.push(...parser.push(SAMPLE.slice(i, i + chunkSize)));
    }
    batches.push(...parser.finish());
    return batches;
  }

  it('produces identical results regardless of how the input is chunked', () => {
    const wholeString = parseSqlBatches(SAMPLE);
    for (const chunkSize of [1, 2, 3, 7, 16, 64]) {
      expect(parseInChunksOf(chunkSize)).toEqual(wholeString);
    }
  });

  it('throws if push() is called after finish()', () => {
    const parser = new SqlBatchParser();
    parser.finish();
    expect(() => parser.push('SELECT 1;')).toThrow();
  });

  it('throws if finish() is called twice', () => {
    const parser = new SqlBatchParser();
    parser.finish();
    expect(() => parser.finish()).toThrow();
  });
});

describe('SqlBatchParser: line-ending normalization', () => {
  it('treats CRLF and CR the same as LF', () => {
    const crlf = parseSqlBatches('SELECT 1;\r\nGO\r\nSELECT 2;\r\nGO\r\n');
    const cr = parseSqlBatches('SELECT 1;\rGO\rSELECT 2;\rGO\r');
    const lf = parseSqlBatches('SELECT 1;\nGO\nSELECT 2;\nGO\n');
    expect(sqlOf(crlf)).toEqual(['SELECT 1;', 'SELECT 2;']);
    expect(sqlOf(cr)).toEqual(sqlOf(crlf));
    expect(sqlOf(lf)).toEqual(sqlOf(crlf));
  });

  it('handles a CRLF pair split exactly across two push() calls', () => {
    const parser = new SqlBatchParser();
    const batches = [...parser.push('SELECT 1;\r'), ...parser.push('\nGO\r\n'), ...parser.finish()];
    expect(sqlOf(batches)).toEqual(['SELECT 1;']);
  });

  it('handles a lone trailing CR at true end of input with no following LF', () => {
    const batches = parseSqlBatches('SELECT 1;\nGO\r');
    expect(sqlOf(batches)).toEqual(['SELECT 1;']);
  });
});

describe('streamSqlBatches', () => {
  it('streams batches from a plain string source', async () => {
    const batches: ParsedSqlBatch[] = [];
    for await (const batch of streamSqlBatches('SELECT 1;\nGO\nSELECT 2;\nGO\n')) {
      batches.push(batch);
    }
    expect(sqlOf(batches)).toEqual(['SELECT 1;', 'SELECT 2;']);
  });

  it('streams batches from an async iterable of Buffer chunks, decoding a multi-byte UTF-8 character split across chunk boundaries', async () => {
    const text = "PRINT 'café';\nGO\n";
    const fullBuffer = Buffer.from(text, 'utf8');
    // Split so the two-byte UTF-8 encoding of 'é' straddles the chunk boundary.
    const splitIndex = fullBuffer.indexOf(Buffer.from('café', 'utf8')) + Buffer.byteLength('caf');
    const chunks = [fullBuffer.subarray(0, splitIndex + 1), fullBuffer.subarray(splitIndex + 1)];

    async function* source(): AsyncGenerator<Buffer> {
      for (const chunk of chunks) {
        yield chunk;
      }
    }

    const batches: ParsedSqlBatch[] = [];
    for await (const batch of streamSqlBatches(source())) {
      batches.push(batch);
    }
    expect(sqlOf(batches)).toEqual(["PRINT 'café';"]);
  });

  it('streams batches from a Node Readable stream', async () => {
    const { Readable } = await import('node:stream');
    const readable = Readable.from(['SELECT 1;\nG', 'O\nSELECT 2;\nGO\n']);

    const batches: ParsedSqlBatch[] = [];
    for await (const batch of streamSqlBatches(readable)) {
      batches.push(batch);
    }
    expect(sqlOf(batches)).toEqual(['SELECT 1;', 'SELECT 2;']);
  });

  it('stops with an AbortError once the signal is aborted', async () => {
    async function* source(): AsyncGenerator<string> {
      yield 'SELECT 1;\nGO\n';
      await new Promise(resolve => setTimeout(resolve, 5));
      yield 'SELECT 2;\nGO\n';
    }

    const controller = new AbortController();
    const iterate = async (): Promise<ParsedSqlBatch[]> => {
      const batches: ParsedSqlBatch[] = [];
      for await (const batch of streamSqlBatches(source(), undefined, controller.signal)) {
        batches.push(batch);
        controller.abort();
      }
      return batches;
    };

    await expect(iterate()).rejects.toThrow();
  });
});

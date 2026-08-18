import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { introspectMssql } from '../src/introspection/introspect.js';
import { restoreSqlDump } from '../src/restore/restoreSqlDump.js';
import { MalformedSqlDumpError, UnsupportedSqlcmdDirectiveError } from '../src/restore/errors.js';
import { isDumperSqlDump } from '../src/restore/batches.js';
import { parseSqlBatches } from '../src/restore/batchParser.js';
import { dumpToString, naivelySplitOnGoLines } from './helpers/dump.js';
import { createEmptyDatabase, createFixtureDatabases } from './helpers/fixtureDatabase.js';
import type { FixtureDatabases } from './helpers/fixtureDatabase.js';
import { probeServer } from './helpers/server.js';
import { execBatches } from './helpers/server.js';
import { readScalarText } from './helpers/snapshot.js';

const availability = await probeServer();
const describeIntegration = availability.available ? describe : describe.skip;

describeIntegration('batch semantics against a live server', () => {
  let fixtures: FixtureDatabases;
  let dumpSql: string;

  beforeAll(async () => {
    fixtures = await createFixtureDatabases('batch');
    dumpSql = (await dumpToString(fixtures.source.connection, { mode: 'schema-only' })).sql;
  });

  afterAll(async () => {
    await fixtures?.dispose();
  });

  it('recognizes its own dump header', () => {
    expect(isDumperSqlDump(dumpSql)).toBe(true);
  });

  it('emits a module body that a naive line-based GO splitter would tear apart', () => {
    // This is the justification for the real lexer: `dbo.uspGoTrap`'s body
    // contains standalone `GO` lines inside a string literal and inside a
    // block comment. A splitter that only looks at line text breaks it.
    const naive = naivelySplitOnGoLines(dumpSql);
    const header = naive.find(batch => batch.toLowerCase().includes('uspgotrap'));

    expect(header).toBeDefined();
    // The naive split cut the procedure at the standalone `GO` inside its
    // block comment, so the fragment carrying `CREATE PROCEDURE` never reaches
    // the body's `END` — it is not valid T-SQL on its own.
    expect(header!.toLowerCase()).not.toContain('end;');

    // The real lexer keeps the whole procedure in one batch.
    const proper = parseSqlBatches(dumpSql).filter(batch =>
      batch.sql.toLowerCase().includes('uspgotrap'),
    );
    expect(proper).toHaveLength(1);
    expect(proper[0]!.sql.trimEnd().toLowerCase().endsWith('end;')).toBe(true);
  });

  it('restores that same module intact, with its embedded GO lines preserved verbatim', async () => {
    const restore = await restoreSqlDump({
      connection: fixtures.target.connection,
      source: dumpSql,
    });
    expect(restore.errors).toEqual([]);

    const target = await introspectMssql(fixtures.target.connection);
    const restored = target.database.routines.find(r => r.pureName === 'uspGoTrap');
    const original = fixtures.sourceIntrospection.database.routines.find(
      r => r.pureName === 'uspGoTrap',
    );

    expect(restored?.definition).toBe(original?.definition);
    // The GO lines really are still in there, un-split.
    expect(restored?.definition).toMatch(/^GO$/m);
  });

  it('executes the restored GO-trap procedure successfully', async () => {
    // Proof the module is not merely stored byte-identically but is valid,
    // compilable T-SQL on the target.
    await fixtures.target.connection.query({ sql: 'exec [dbo].[uspGoTrap]' });
  });

  it('accepts a dump fed as a Readable stream in arbitrary chunk sizes', async () => {
    const empty = await createEmptyDatabase('batch_stream');
    try {
      // 7 bytes at a time: splits identifiers, string literals, CRLF pairs and
      // GO lines across chunk boundaries.
      const chunks: Buffer[] = [];
      const buffer = Buffer.from(dumpSql, 'utf8');
      for (let offset = 0; offset < buffer.length; offset += 7) {
        chunks.push(buffer.subarray(offset, offset + 7));
      }

      const restore = await restoreSqlDump({
        connection: empty.database.connection,
        source: Readable.from(chunks),
      });
      expect(restore.errors).toEqual([]);

      const target = await introspectMssql(empty.database.connection);
      expect(target.database.tables.length).toBe(
        fixtures.sourceIntrospection.database.tables.length,
      );
    } finally {
      await empty.dispose();
    }
  });

  it('executes a GO <n> repeat count the requested number of times', async () => {
    const empty = await createEmptyDatabase('batch_repeat');
    try {
      await execBatches(empty.database.connection, [
        'create table [dbo].[Ticks] ([Id] int identity(1,1) primary key, [At] datetime2 default sysutcdatetime());',
      ]);

      const restore = await restoreSqlDump({
        connection: empty.database.connection,
        source: 'insert into [dbo].[Ticks] default values;\nGO 5\n',
      });

      expect(restore.errors).toEqual([]);
      expect(restore.batchesExecuted).toBe(5);
      const count = await readScalarText(
        empty.database.connection,
        'select cast(count(*) as nvarchar(32)) as value from [dbo].[Ticks]',
      );
      expect(count).toBe('5');
    } finally {
      await empty.dispose();
    }
  });

  it('keeps batch-scoped constructs working by using real batch execution', async () => {
    const empty = await createEmptyDatabase('batch_scope');
    try {
      // `CREATE PROCEDURE` must be the only statement in its batch, and a
      // module created in one batch must be callable from the next. Both rely
      // on genuine batch execution (execSqlBatch), not sp_executesql wrapping.
      const restore = await restoreSqlDump({
        connection: empty.database.connection,
        source: [
          'create procedure [dbo].[p1] as select 1 as one;',
          'GO',
          'create procedure [dbo].[p2] as exec [dbo].[p1];',
          'GO',
          '',
        ].join('\n'),
      });

      expect(restore.errors).toEqual([]);
      await empty.database.connection.query({ sql: 'exec [dbo].[p2]' });
    } finally {
      await empty.dispose();
    }
  });

  it('preserves a CRLF inside a restored string value', async () => {
    const empty = await createEmptyDatabase('batch_crlf');
    try {
      await execBatches(empty.database.connection, [
        'create table [dbo].[Notes] ([Id] int not null primary key, [Body] nvarchar(100) not null);',
      ]);

      // The literal below contains a real CRLF: a parser that normalized line
      // endings while rejoining batches would silently drop the CR.
      const restore = await restoreSqlDump({
        connection: empty.database.connection,
        source:
          "insert into [dbo].[Notes] ([Id], [Body]) values (1, N'line one\r\nline two');\r\nGO\r\n",
      });
      expect(restore.errors).toEqual([]);

      const hex = await readScalarText(
        empty.database.connection,
        'select convert(nvarchar(max), convert(varbinary(max), [Body]), 1) as value from [dbo].[Notes] where [Id] = 1',
      );
      // 000d000a is CR LF in UTF-16LE-as-stored (nvarchar) hex.
      expect(hex?.toLowerCase()).toContain('0d000a00');
    } finally {
      await empty.dispose();
    }
  });

  it('restores a filtered index that follows a module created with ANSI_NULLS OFF', async () => {
    // Regression: SET options are session-scoped, so a module recorded with
    // ANSI_NULLS/QUOTED_IDENTIFIER OFF used to leave the restore session in
    // that state. Functions sort before indexes within post-data, so the next
    // CREATE INDEX for a filtered index failed outright — "CREATE INDEX failed
    // because the following SET options have incorrect settings" — making the
    // dump unrestorable, and leaving the caller's session altered afterwards.
    const source = await createEmptyDatabase('batch_setopts_src');
    const target = await createEmptyDatabase('batch_setopts_tgt');
    try {
      await execBatches(source.database.connection, [
        `create table [dbo].[T] ([Id] int not null primary key, [Status] varchar(20) null, [V] int null);`,
        'set ansi_nulls off',
        'set quoted_identifier off',
        'create function [dbo].[fnOff](@x int) returns int as begin return @x; end;',
        'set ansi_nulls on',
        'set quoted_identifier on',
        `create nonclustered index [IX_Filtered] on [dbo].[T] ([V]) where ([Status] = 'new');`,
      ]);

      const { sql } = await dumpToString(source.database.connection, { mode: 'schema-only' });
      const restore = await restoreSqlDump({
        connection: target.database.connection,
        source: sql,
      });

      expect(restore.errors).toEqual([]);

      const restored = await introspectMssql(target.database.connection);
      const index = restored.database.indexes.find(i => i.indexName === 'IX_Filtered');
      expect(index?.filterDefinition).toBeTruthy();

      // The module's own recorded flags still round-trip...
      const fn = restored.database.routines.find(r => r.pureName === 'fnOff');
      expect(fn?.usesAnsiNulls).toBe(false);
      expect(fn?.usesQuotedIdentifier).toBe(false);

      // ...and the session the restore ran through is left back at the
      // defaults, not silently flipped to OFF.
      const session = await target.database.connection.query<{ an: number; qi: number }>({
        sql: `select cast(sessionproperty('ANSI_NULLS') as int) as an,
                     cast(sessionproperty('QUOTED_IDENTIFIER') as int) as qi`,
      });
      expect(session.rows[0]?.an).toBe(1);
      expect(session.rows[0]?.qi).toBe(1);
    } finally {
      await target.dispose();
      await source.dispose();
    }
  });

  it('rejects a sqlcmd directive rather than sending it to the server', async () => {
    await expect(
      restoreSqlDump({
        connection: fixtures.target.connection,
        source: ':setvar DbName Foo\nselect 1;\nGO\n',
      }),
    ).rejects.toBeInstanceOf(UnsupportedSqlcmdDirectiveError);
  });

  it('rejects a structurally malformed script before executing anything', async () => {
    const empty = await createEmptyDatabase('batch_malformed');
    try {
      await expect(
        restoreSqlDump({
          connection: empty.database.connection,
          source: "create table [dbo].[T] ([A] int);\nGO\nselect 'unterminated;\n",
        }),
      ).rejects.toBeInstanceOf(MalformedSqlDumpError);

      // The first batch had already executed before the parse error was
      // reached — a parse failure stops the restore, it does not roll back.
      const exists = await readScalarText(
        empty.database.connection,
        "select cast(count(*) as nvarchar(32)) as value from sys.tables where name = 'T'",
      );
      expect(exists).toBe('1');
    } finally {
      await empty.dispose();
    }
  });

  it('records a per-batch execution error without aborting when stopOnError is false', async () => {
    const empty = await createEmptyDatabase('batch_errors');
    try {
      const restore = await restoreSqlDump({
        connection: empty.database.connection,
        source: [
          'create table [dbo].[Good1] ([A] int);',
          'GO',
          'create table [dbo].[Bad] ([A] nosuchtype);',
          'GO',
          'create table [dbo].[Good2] ([A] int);',
          'GO',
          '',
        ].join('\n'),
        options: { stopOnError: false },
      });

      expect(restore.batchesFailed).toBe(1);
      expect(restore.batchesExecuted).toBe(2);
      expect(restore.errors[0]?.batchIndex).toBe(1);
      expect(restore.errors[0]?.location.startLine).toBe(3);

      const tables = await readScalarText(
        empty.database.connection,
        "select cast(count(*) as nvarchar(32)) as value from sys.tables where name in ('Good1','Good2')",
      );
      expect(tables).toBe('2');
    } finally {
      await empty.dispose();
    }
  });

  it('never puts a credential literal into a restore error, even from the server message', async () => {
    const empty = await createEmptyDatabase('batch_secret');
    try {
      const restore = await restoreSqlDump({
        connection: empty.database.connection,
        // Invalid on purpose: a database-scoped credential needs a master key,
        // so the server rejects it and the failing statement text is reported.
        source:
          "create database scoped credential [c1] with identity = 'SHARED ACCESS SIGNATURE', secret = 'sv=2022-11-02&sig=SUPERSECRETTOKEN';\nGO\n",
        options: { stopOnError: false },
      });

      expect(restore.batchesFailed).toBe(1);
      const recorded = JSON.stringify(restore.errors);
      expect(recorded).not.toContain('SUPERSECRETTOKEN');
      expect(recorded).toContain('REDACTED');
    } finally {
      await empty.dispose();
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DumpProgressEvent } from '../src/utils/progress.js';
import { restoreSqlDump } from '../src/restore/restoreSqlDump.js';
import { BIG_TABLE_ROW_COUNT } from './fixture/data.js';
import { dumpToString } from './helpers/dump.js';
import { createEmptyDatabase, createFixtureDatabases } from './helpers/fixtureDatabase.js';
import type { FixtureDatabases } from './helpers/fixtureDatabase.js';
import { execBatches, openConnection, probeServer } from './helpers/server.js';
import { readScalarText } from './helpers/snapshot.js';

const availability = await probeServer();
const describeIntegration = availability.available ? describe : describe.skip;

describeIntegration('streaming, progress and cancellation', () => {
  let fixtures: FixtureDatabases;

  beforeAll(async () => {
    fixtures = await createFixtureDatabases('stream');
  });

  afterAll(async () => {
    await fixtures?.dispose();
  });

  it('streams thousands of rows with row-level progress and monotonic byte counts', async () => {
    const events: DumpProgressEvent[] = [];
    const { result } = await dumpToString(
      fixtures.source.connection,
      { mode: 'data-only', selection: { tables: [{ schemaName: 'dbo', pureName: 'BigTable' }] } },
      event => events.push(event),
    );

    expect(result.rowsExported).toBe(BIG_TABLE_ROW_COUNT);

    const dataEvents = events.filter(e => e.phase === 'exporting-data');
    // One event per row, not per batch.
    expect(dataEvents.length).toBe(BIG_TABLE_ROW_COUNT);
    expect(dataEvents.at(-1)?.objectsProcessed).toBe(BIG_TABLE_ROW_COUNT);
    expect(dataEvents.at(0)?.message).toBe('dbo.BigTable');

    const byteCounts = dataEvents.map(e => e.bytesWritten ?? 0);
    for (let i = 1; i < byteCounts.length; i++) {
      expect(byteCounts[i]!).toBeGreaterThanOrEqual(byteCounts[i - 1]!);
    }
    expect(byteCounts.at(-1)!).toBeGreaterThan(0);

    const phases = new Set(events.map(e => e.phase));
    expect(phases).toContain('connecting');
    expect(phases).toContain('detecting-version');
    expect(phases).toContain('planning-archive');
    expect(phases).toContain('exporting-data');
    expect(phases).toContain('finalizing');
  });

  it('respects a small row-batch limit while still exporting every row', async () => {
    const { sql, result } = await dumpToString(fixtures.source.connection, {
      mode: 'data-only',
      selection: { tables: [{ schemaName: 'dbo', pureName: 'BigTable' }] },
      dataExport: { maxRowsPerStatement: 10, streamBatchSize: 5 },
    });

    expect(result.rowsExported).toBe(BIG_TABLE_ROW_COUNT);
    const insertCount = (sql.match(/^INSERT INTO/gm) ?? []).length;
    expect(insertCount).toBe(BIG_TABLE_ROW_COUNT / 10);
  });

  it('cancels a dump mid-stream and reports partial progress instead of throwing', async () => {
    // Cancelling issues `connection.cancel()`, which leaves the underlying
    // tedious connection mid-attention and unusable for a short while, so this
    // runs on a dedicated connection rather than the suite's shared one (see
    // docs/known-limitations.md, "Reusing a connection after cancellation").
    const cancellable = await openConnection(fixtures.source.name);
    try {
      const controller = new AbortController();
      let seen = 0;

      const { sql, result } = await dumpToString(
        cancellable.connection,
        { mode: 'full' },
        event => {
          if (event.phase === 'exporting-data') {
            seen++;
            if (seen === 25) {
              controller.abort();
            }
          }
        },
        controller.signal,
      );

      expect(result.cancelled).toBe(true);
      expect(result.rowsExported).toBeLessThan(BIG_TABLE_ROW_COUNT);
      // Whatever was produced before the abort is still well-formed output, not
      // a truncated half-statement.
      expect(sql.startsWith('-- dbgate-mssql-dumper plain SQL dump')).toBe(true);
      // Cancellation must not leave an unbalanced IDENTITY_INSERT behind.
      const onCount = (sql.match(/SET IDENTITY_INSERT .* ON;/g) ?? []).length;
      const offCount = (sql.match(/SET IDENTITY_INSERT .* OFF;/g) ?? []).length;
      expect(offCount).toBe(onCount);
    } finally {
      await cancellable.close();
    }
  });

  it('cancels a restore mid-script and reports how far it got', async () => {
    const { sql } = await dumpToString(fixtures.source.connection, { mode: 'schema-only' });

    // Its own database *and* its own connection: cancelling leaves the
    // underlying tedious connection mid-attention, so it must not be reused
    // for the verification queries (see docs/known-limitations.md).
    const scratch = await createEmptyDatabase('stream_cancel');
    try {
      const controller = new AbortController();
      let batches = 0;
      const restore = await restoreSqlDump({
        connection: scratch.database.connection,
        source: sql,
        signal: controller.signal,
        progress: event => {
          if (event.phase === 'executing') {
            batches++;
            if (batches === 5) {
              controller.abort();
            }
          }
        },
      });

      expect(restore.cancelled).toBe(true);
      expect(restore.batchesExecuted).toBeGreaterThan(0);

      const verify = await openConnection(scratch.database.name);
      try {
        const tableCount = Number(
          await readScalarText(
            verify.connection,
            'select cast(count(*) as nvarchar(32)) as value from sys.tables',
          ),
        );
        // Some objects exist, but not all — the restore really did stop early.
        expect(tableCount).toBeLessThan(fixtures.sourceIntrospection.database.tables.length);
      } finally {
        await verify.close();
      }
    } finally {
      await scratch.dispose();
    }
  });

  it('reports restore progress with batch index and a running rows-restored total', async () => {
    const { sql } = await dumpToString(fixtures.source.connection, {
      mode: 'data-only',
      selection: { tables: [{ schemaName: 'dbo', pureName: 'BigTable' }] },
    });

    const scratch = await createEmptyDatabase('stream_progress');
    try {
      await execBatches(scratch.database.connection, [
        `create table [dbo].[BigTable] (
           [Id] int identity(1,1) not null constraint [PK_BigTable_stream] primary key,
           [Payload] nvarchar(200) not null,
           [Num] decimal(18,4) not null,
           [Flag] bit not null);`,
      ]);

      const batchIndexes: number[] = [];
      let lastRowsRestored = 0;
      const restore = await restoreSqlDump({
        connection: scratch.database.connection,
        source: sql,
        progress: event => {
          if (event.batchIndex !== undefined) batchIndexes.push(event.batchIndex);
          if (event.rowsRestored !== undefined) lastRowsRestored = event.rowsRestored;
        },
      });

      expect(restore.errors).toEqual([]);
      expect(restore.rowsRestored).toBe(BIG_TABLE_ROW_COUNT);
      expect(lastRowsRestored).toBe(BIG_TABLE_ROW_COUNT);
      // Batch indexes are reported and never go backwards.
      expect(batchIndexes.length).toBeGreaterThan(0);
      expect([...batchIndexes].sort((a, b) => a - b)).toEqual(batchIndexes);
    } finally {
      await scratch.dispose();
    }
  });
});

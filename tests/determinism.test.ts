/**
 * Proves the archive order and rendered SQL depend only on the *content* of the
 * introspected model, never on the order SQL Server happened to return rows in.
 *
 * The existing determinism check reverses a few arrays; this one shuffles every
 * collection in the model with a seeded PRNG across many iterations, which is
 * what actually exercises the tie-break comparator being a total order. A
 * comparator with a tie left in it passes a reversal test and fails here.
 */
import { describe, expect, it } from 'vitest';
import { inspectDumpArchive } from '../src/archive/planner.js';
import type { MssqlDatabase } from '../src/model/database.js';
import { renderPlainSql } from '../src/renderer/plainSql.js';
import { StringDumpWriter } from '../src/writer/stringWriter.js';
import { buildSampleDatabase } from './fixtures.js';

/** Deterministic PRNG (mulberry32) — a seeded shuffle must be reproducible. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/** Shuffles every collection in the model, including each table's column list. */
function shuffleDatabase(database: MssqlDatabase, seed: number): MssqlDatabase {
  const random = createRandom(seed);
  return {
    ...database,
    schemas: shuffled(database.schemas, random),
    tables: shuffled(database.tables, random).map(table => ({
      ...table,
      columns: shuffled(table.columns, random),
    })),
    views: shuffled(database.views, random),
    routines: shuffled(database.routines, random),
    triggers: shuffled(database.triggers, random),
    sequences: shuffled(database.sequences, random),
    primaryKeys: shuffled(database.primaryKeys, random),
    uniqueConstraints: shuffled(database.uniqueConstraints, random),
    foreignKeys: shuffled(database.foreignKeys, random),
    checkConstraints: shuffled(database.checkConstraints, random),
    defaultConstraints: shuffled(database.defaultConstraints, random),
    indexes: shuffled(database.indexes, random).map(index => ({
      ...index,
      columns: shuffled(index.columns, random),
    })),
  };
}

async function render(database: MssqlDatabase, mode: 'full' | 'schema-only'): Promise<string> {
  const archive = inspectDumpArchive(database, { mode });
  const writer = new StringDumpWriter();
  await renderPlainSql({
    database,
    archive,
    writer,
    // Stand in for real data so `full` mode exercises the data section too.
    onDataEntry: async entry => {
      await writer.write(`-- data: ${entry.schemaName}.${entry.name}\n`);
      return true;
    },
  });
  return writer.toString();
}

describe('archive planning is order-independent', () => {
  const baseline = buildSampleDatabase();

  it('produces an identical dumpId sequence for 50 shuffled inputs', () => {
    const expected = inspectDumpArchive(baseline, { mode: 'full' }).entries.map(e => e.dumpId);
    expect(expected.length).toBeGreaterThan(5);

    for (let seed = 1; seed <= 50; seed++) {
      const archive = inspectDumpArchive(shuffleDatabase(baseline, seed), { mode: 'full' });
      expect(
        archive.entries.map(e => e.dumpId),
        `seed ${seed}`,
      ).toEqual(expected);
    }
  });

  it('assigns identical sequence numbers for shuffled inputs', () => {
    const expected = inspectDumpArchive(baseline, { mode: 'full' }).entries.map(
      e => `${e.sequenceNumber}:${e.objectType}:${e.schemaName}.${e.name}`,
    );
    for (let seed = 1; seed <= 20; seed++) {
      const archive = inspectDumpArchive(shuffleDatabase(baseline, seed), { mode: 'full' });
      expect(
        archive.entries.map(e => `${e.sequenceNumber}:${e.objectType}:${e.schemaName}.${e.name}`),
        `seed ${seed}`,
      ).toEqual(expected);
    }
  });

  it('reports dependency edges in a stable order', () => {
    // `dependsOn` is public API, so its array order must not drift either.
    const fingerprint = (database: MssqlDatabase): string =>
      inspectDumpArchive(database, { mode: 'full' })
        .entries.map(
          e => `${e.dumpId}<-${e.dependsOn.map(d => `${d.targetDumpId}/${d.strength}`).join(',')}`,
        )
        .join('|');

    const expected = fingerprint(baseline);
    for (let seed = 1; seed <= 20; seed++) {
      expect(fingerprint(shuffleDatabase(baseline, seed)), `seed ${seed}`).toBe(expected);
    }
  });
});

describe('rendered SQL is order-independent', () => {
  const baseline = buildSampleDatabase();

  it.each(['full', 'schema-only'] as const)(
    'produces byte-identical %s output for 25 shuffled inputs',
    async mode => {
      const expected = await render(baseline, mode);
      for (let seed = 1; seed <= 25; seed++) {
        expect(await render(shuffleDatabase(baseline, seed), mode), `seed ${seed}`).toBe(expected);
      }
    },
  );

  it('orders columns by ordinal position, not by array order', async () => {
    // Columns are the one place the model's array order is *not* authoritative:
    // `ordinalPosition` is, and CREATE TABLE must follow it.
    const sql = await render(shuffleDatabase(baseline, 7), 'schema-only');
    const baselineSql = await render(baseline, 'schema-only');
    expect(sql).toBe(baselineSql);
  });
});

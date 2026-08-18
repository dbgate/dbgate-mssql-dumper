import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { introspectMssql } from '../src/introspection/introspect.js';
import { restoreSqlDump } from '../src/restore/restoreSqlDump.js';
import { BIG_TABLE_ROW_COUNT } from './fixture/data.js';
import { dumpToString } from './helpers/dump.js';
import { createEmptyDatabase, createFixtureDatabases } from './helpers/fixtureDatabase.js';
import type { FixtureDatabases } from './helpers/fixtureDatabase.js';
import { normalizeDatabase, normalizeDumpText } from './helpers/normalize.js';
import { probeServer } from './helpers/server.js';
import { readScalarText, readTableSnapshot } from './helpers/snapshot.js';

const availability = await probeServer();
const describeIntegration = availability.available ? describe : describe.skip;

describeIntegration('dump modes and semantic stability', () => {
  let fixtures: FixtureDatabases;

  beforeAll(async () => {
    fixtures = await createFixtureDatabases('modes');
  });

  afterAll(async () => {
    await fixtures?.dispose();
  });

  it('schema-only produces a restorable dump with every object and no rows', async () => {
    const { sql, result } = await dumpToString(fixtures.source.connection, {
      mode: 'schema-only',
    });

    expect(result.rowsExported).toBe(0);
    expect(sql).not.toContain('INSERT INTO');
    expect(sql).not.toContain('IDENTITY_INSERT');

    const restore = await restoreSqlDump({
      connection: fixtures.target.connection,
      source: sql,
    });
    expect(restore.errors).toEqual([]);
    expect(restore.rowsRestored).toBe(0);

    const target = await introspectMssql(fixtures.target.connection);
    // Structurally identical to the source, but with no data at all.
    expect(normalizeDatabase(target.database)).toEqual(
      normalizeDatabase(fixtures.sourceIntrospection.database),
    );
    const rowCount = await readScalarText(
      fixtures.target.connection,
      'select cast(count(*) as nvarchar(32)) as value from [dbo].[BigTable]',
    );
    expect(rowCount).toBe('0');
  });

  it('data-only loads rows into an already-restored schema without touching definitions', async () => {
    // Runs against the schema the previous test restored. Selection is limited
    // to two trigger-free tables on purpose: applying a data-only dump to a
    // schema whose triggers already exist would fire them for every inserted
    // row (see docs/known-limitations.md).
    const selection = {
      tables: [
        { schemaName: 'dbo', pureName: 'AllTypes' },
        { schemaName: 'dbo', pureName: 'BigTable' },
      ],
    };

    const { sql, result } = await dumpToString(fixtures.source.connection, {
      mode: 'data-only',
      selection,
    });

    expect(sql).not.toContain('CREATE TABLE');
    expect(sql).not.toContain('ADD CONSTRAINT');
    expect(result.rowsExported).toBe(4 + BIG_TABLE_ROW_COUNT);

    const restore = await restoreSqlDump({
      connection: fixtures.target.connection,
      source: sql,
    });
    expect(restore.errors).toEqual([]);

    const target = await introspectMssql(fixtures.target.connection);
    for (const table of [
      { schemaName: 'dbo', pureName: 'AllTypes' },
      { schemaName: 'dbo', pureName: 'BigTable' },
    ]) {
      const before = await readTableSnapshot(
        fixtures.source.connection,
        fixtures.sourceIntrospection.database,
        table.schemaName,
        table.pureName,
      );
      const after = await readTableSnapshot(
        fixtures.target.connection,
        target.database,
        table.schemaName,
        table.pureName,
      );
      expect(after.rows).toEqual(before.rows);
    }
  });

  it('is semantically stable: dump -> restore -> dump again yields identical normalized SQL', async () => {
    // The strongest single check in the suite. It requires deterministic object
    // ordering, deterministic row ordering, and byte-exact rendering of every
    // identifier, literal and definition — a difference anywhere in the
    // pipeline shows up here. Needs its own pristine target, since restoring
    // into an already-populated database would duplicate rows.
    const fresh = await createEmptyDatabase('modes_stable');
    try {
      const first = await dumpToString(fixtures.source.connection, { mode: 'full' });

      const restore = await restoreSqlDump({
        connection: fresh.database.connection,
        source: first.sql,
      });
      expect(restore.errors).toEqual([]);

      const second = await dumpToString(fresh.database.connection, { mode: 'full' });

      expect(normalizeDumpText(second.sql)).toBe(normalizeDumpText(first.sql));
    } finally {
      await fresh.dispose();
    }
  });

  it('produces byte-identical output when the same database is dumped twice', async () => {
    const first = await dumpToString(fixtures.source.connection, { mode: 'full' });
    const second = await dumpToString(fixtures.source.connection, { mode: 'full' });
    expect(second.sql).toBe(first.sql);
  });

  it('honours include/exclude selection', async () => {
    const included = await dumpToString(fixtures.source.connection, {
      mode: 'schema-only',
      selection: { schemas: ['sales'] },
    });
    expect(included.sql).toContain('CREATE TABLE sales.Customers');
    expect(included.sql).not.toContain('CREATE TABLE dbo.AllTypes');

    const excluded = await dumpToString(fixtures.source.connection, {
      mode: 'schema-only',
      selection: { excludeSchemas: ['sales'] },
    });
    expect(excluded.sql).not.toContain('CREATE TABLE sales.Customers');
    expect(excluded.sql).toContain('CREATE TABLE dbo.AllTypes');
  });

  it('emits reverse-ordered DROP statements that actually execute against a populated database', async () => {
    const { sql } = await dumpToString(fixtures.source.connection, {
      mode: 'schema-only',
      render: { includeDropStatements: true },
    });

    // Dropping everything, then recreating it, must succeed against a database
    // that already holds the full schema — which only works if the drops run
    // in reverse dependency order.
    const restore = await restoreSqlDump({
      connection: fixtures.target.connection,
      source: sql,
    });
    expect(restore.errors).toEqual([]);
  });
});

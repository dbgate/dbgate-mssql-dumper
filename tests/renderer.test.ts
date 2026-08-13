import { describe, expect, it } from 'vitest';
import { inspectDumpArchive } from '../src/archive/planner.js';
import { renderPlainSql } from '../src/renderer/plainSql.js';
import { StringDumpWriter } from '../src/writer/stringWriter.js';
import { buildEmptyDatabase, buildSampleDatabase } from './fixtures.js';

describe('renderPlainSql', () => {
  it('renders a deterministic schema dump with no timestamps', async () => {
    const database = buildSampleDatabase();
    const archive = inspectDumpArchive(database, { mode: 'schema-only' });
    const writer = new StringDumpWriter();

    const result = await renderPlainSql({ database, archive, writer });

    expect(result.cancelled).toBe(false);
    expect(result.renderedDumpIds.length).toBe(archive.entries.length);
    expect(result.skippedDumpIds).toHaveLength(0);

    const text = writer.toString();
    expect(text).toContain('CREATE TABLE dbo.Customers');
    expect(text).toContain('IDENTITY(1,1)');
    expect(text).toContain('ADD CONSTRAINT FK_Orders_Customers FOREIGN KEY');
    expect(text).toContain('CREATE NONCLUSTERED INDEX IX_Orders_CustomerId');
    expect(text).not.toMatch(/generated \d{4}-/);

    const second = new StringDumpWriter();
    await renderPlainSql({ database, archive, writer: second });
    expect(second.toString()).toBe(text);
  });

  it('warns instead of rendering selected table data', async () => {
    const database = buildSampleDatabase();
    const archive = inspectDumpArchive(database, { mode: 'full' });
    const writer = new StringDumpWriter();

    const result = await renderPlainSql({ database, archive, writer });

    expect(result.warnings.some(w => w.code === 'data-not-rendered')).toBe(true);
    expect(result.skippedDumpIds.length).toBeGreaterThan(0);
  });

  it('emits reverse-order drop statements when includeDropStatements is set', async () => {
    const database = buildSampleDatabase();
    const archive = inspectDumpArchive(database, { mode: 'schema-only' });
    const writer = new StringDumpWriter();

    await renderPlainSql({ database, archive, writer, options: { includeDropStatements: true } });
    const text = writer.toString();

    const dropTableIdx = text.indexOf('DROP TABLE IF EXISTS dbo.Orders');
    const createTableIdx = text.indexOf('CREATE TABLE dbo.Orders');
    expect(dropTableIdx).toBeGreaterThanOrEqual(0);
    expect(createTableIdx).toBeGreaterThan(dropTableIdx);
  });

  it('throws for an invalid (cyclic) archive', async () => {
    const database = buildSampleDatabase();
    const archive = inspectDumpArchive(database, { mode: 'schema-only' });
    const invalid = { ...archive, valid: false };
    const writer = new StringDumpWriter();

    await expect(renderPlainSql({ database, archive: invalid, writer })).rejects.toThrow();
  });

  it('includes a recognizable header with source metadata but no secrets, and an optional timestamp', async () => {
    const database = buildSampleDatabase();
    const archive = inspectDumpArchive(database, { mode: 'schema-only' });
    const writer = new StringDumpWriter();

    await renderPlainSql({
      database,
      archive,
      writer,
      mode: 'schema-only',
      sourceVersion: {
        productVersion: '16.0.1000.6',
        majorVersion: 16,
        minorVersion: 0,
        buildNumber: 1000,
        revision: 6,
        engineEdition: 'standard',
        isAzure: false,
      },
      options: { includeTimestamp: true },
    });

    const text = writer.toString();
    expect(text.startsWith('-- dbgate-mssql-dumper plain SQL dump')).toBe(true);
    expect(text).toContain(`-- Database: ${database.databaseName}`);
    expect(text).toContain('-- Source: SQL Server 16.0.1000.6 (standard)');
    expect(text).toContain('-- Mode: schema-only');
    expect(text).toMatch(/-- Generated: \d{4}-\d{2}-\d{2}T/);
  });

  it('omits optional header lines that have no data, and never includes a timestamp by default', async () => {
    const database = buildSampleDatabase();
    const archive = inspectDumpArchive(database, { mode: 'schema-only' });
    const writer = new StringDumpWriter();

    await renderPlainSql({ database, archive, writer });

    const text = writer.toString();
    expect(text).not.toContain('-- Source:');
    expect(text).not.toContain('-- Mode:');
    expect(text).not.toMatch(/-- Generated:/);
  });

  it('renders a per-object SET ANSI_NULLS/QUOTED_IDENTIFIER preamble reflecting the captured module flags', async () => {
    const database = buildEmptyDatabase({
      schemas: [{ schemaName: 'dbo', ownerName: 'dbo' }],
      views: [
        {
          schemaName: 'dbo',
          pureName: 'LegacyView',
          objectId: 1,
          definition: 'CREATE VIEW [dbo].[LegacyView] AS SELECT 1 AS x',
          isSchemaBound: false,
          usesAnsiNulls: false,
          usesQuotedIdentifier: false,
          isEncrypted: false,
          comment: null,
        },
      ],
    });
    const archive = inspectDumpArchive(database, { mode: 'schema-only' });
    const writer = new StringDumpWriter();

    await renderPlainSql({ database, archive, writer });

    const text = writer.toString();
    expect(text).toContain('SET ANSI_NULLS OFF;');
    expect(text).toContain('SET QUOTED_IDENTIFIER OFF;');
  });

  it('calls onDataEntry for data-section entries and marks them rendered instead of skipped when handled', async () => {
    const database = buildSampleDatabase();
    const archive = inspectDumpArchive(database, { mode: 'full' });
    const writer = new StringDumpWriter();
    const handledDumpIds: string[] = [];

    const result = await renderPlainSql({
      database,
      archive,
      writer,
      onDataEntry: async entry => {
        handledDumpIds.push(entry.dumpId);
        await writer.write(`-- (data for ${entry.schemaName}.${entry.name} would go here)\n`);
        return true;
      },
    });

    const dataEntries = archive.entries.filter(e => e.section === 'data');
    expect(handledDumpIds).toEqual(dataEntries.map(e => e.dumpId));
    expect(result.warnings.some(w => w.code === 'data-not-rendered')).toBe(false);
    for (const entry of dataEntries) {
      expect(result.renderedDumpIds).toContain(entry.dumpId);
      expect(result.skippedDumpIds).not.toContain(entry.dumpId);
    }
  });

  it('falls back to the default warning when onDataEntry returns false', async () => {
    const database = buildSampleDatabase();
    const archive = inspectDumpArchive(database, { mode: 'full' });
    const writer = new StringDumpWriter();

    const result = await renderPlainSql({
      database,
      archive,
      writer,
      onDataEntry: async () => false,
    });

    expect(result.warnings.some(w => w.code === 'data-not-rendered')).toBe(true);
    expect(result.skippedDumpIds.length).toBeGreaterThan(0);
  });
});

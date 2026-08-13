import { describe, expect, it } from 'vitest';
import { inspectDumpArchive } from '../src/archive/planner.js';
import { normalizeDumpSelection } from '../src/selection/normalize.js';
import { buildSampleDatabase } from './fixtures.js';

function indexOf(
  entries: readonly { objectType: string; name: string }[],
  objectType: string,
  name: string,
): number {
  return entries.findIndex(entry => entry.objectType === objectType && entry.name === name);
}

describe('inspectDumpArchive', () => {
  it('produces a valid, dependency-respecting order for a full dump', () => {
    const database = buildSampleDatabase();
    const inspection = inspectDumpArchive(database);

    expect(inspection.valid).toBe(true);
    expect(inspection.cycles).toEqual([]);

    const schemaIdx = indexOf(inspection.entries, 'schema', 'dbo');
    const customersIdx = indexOf(inspection.entries, 'table', 'Customers');
    const ordersIdx = indexOf(inspection.entries, 'table', 'Orders');
    const fkIdx = indexOf(inspection.entries, 'foreignKey', 'FK_Orders_Customers');
    const pkOrdersIdx = indexOf(inspection.entries, 'primaryKey', 'PK_Orders');
    const indexIdx = indexOf(inspection.entries, 'index', 'IX_Orders_CustomerId');
    const dataIdx = indexOf(inspection.entries, 'tableData', 'Orders');

    expect(schemaIdx).toBeLessThan(customersIdx);
    expect(schemaIdx).toBeLessThan(ordersIdx);
    expect(customersIdx).toBeLessThan(fkIdx);
    expect(ordersIdx).toBeLessThan(fkIdx);
    expect(ordersIdx).toBeLessThan(pkOrdersIdx);
    expect(ordersIdx).toBeLessThan(indexIdx);
    expect(ordersIdx).toBeLessThan(dataIdx);
    // post-data (constraints/indexes) sorts after the data section as a whole
    expect(dataIdx).toBeLessThan(fkIdx);
  });

  it('is deterministic across repeated calls', () => {
    const database = buildSampleDatabase();
    const first = inspectDumpArchive(database).entries.map(e => e.dumpId);
    const second = inspectDumpArchive(database).entries.map(e => e.dumpId);
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(0);
  });

  it('omits table data in schema-only mode', () => {
    const database = buildSampleDatabase();
    const inspection = inspectDumpArchive(database, { mode: 'schema-only' });
    expect(inspection.entries.some(e => e.objectType === 'tableData')).toBe(false);
    expect(inspection.entries.some(e => e.objectType === 'table')).toBe(true);
  });

  it('keeps only data-section entries in data-only mode', () => {
    const database = buildSampleDatabase();
    const inspection = inspectDumpArchive(database, { mode: 'data-only' });
    expect(inspection.entries.every(e => e.section === 'data')).toBe(true);
    expect(inspection.entries).toHaveLength(2);
  });

  it('pulls in a foreign key target excluded by selection, with a diagnostic', () => {
    const database = buildSampleDatabase();
    const selection = normalizeDumpSelection({
      tables: [{ schemaName: 'dbo', pureName: 'Orders' }],
    });
    const inspection = inspectDumpArchive(database, { selection });

    expect(inspection.valid).toBe(true);
    const customersEntry = inspection.entries.find(
      e => e.objectType === 'table' && e.name === 'Customers',
    );
    expect(customersEntry?.selectionState).toBe('dependency');
    expect(inspection.diagnostics.some(d => d.code === 'included-as-dependency')).toBe(true);
  });

  it('does not report a cycle for mutually referencing foreign keys', () => {
    const database = buildSampleDatabase();
    const mutual = {
      ...database,
      foreignKeys: [
        ...database.foreignKeys,
        {
          constraintName: 'FK_Customers_Orders',
          schemaName: 'dbo',
          pureName: 'Customers',
          refSchemaName: 'dbo',
          refTableName: 'Orders',
          updateAction: 'NO ACTION' as const,
          deleteAction: 'NO ACTION' as const,
          isNotTrusted: false,
          isDisabled: false,
          columns: [{ columnName: 'Id', refColumnName: 'Id', ordinalPosition: 1 }],
        },
      ],
    };
    const inspection = inspectDumpArchive(mutual);
    expect(inspection.valid).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { inspectDumpArchive } from '../src/archive/planner.js';
import type { MssqlObjectDependency } from '../src/model/objectDependency.js';
import type { MssqlRoutine } from '../src/model/routine.js';
import type { MssqlView } from '../src/model/view.js';
import { normalizeDumpSelection } from '../src/selection/normalize.js';
import { buildEmptyDatabase, buildSampleDatabase } from './fixtures.js';

let nextObjectId = 1000;

function view(overrides: Partial<MssqlView> & { schemaName: string; pureName: string }): MssqlView {
  return {
    objectId: nextObjectId++,
    definition: `CREATE VIEW [${overrides.schemaName}].[${overrides.pureName}] AS SELECT 1 AS x`,
    isSchemaBound: false,
    usesAnsiNulls: true,
    usesQuotedIdentifier: true,
    isEncrypted: false,
    comment: null,
    ...overrides,
  };
}

function scalarFunction(
  overrides: Partial<MssqlRoutine> & { schemaName: string; pureName: string },
): MssqlRoutine {
  return {
    kind: 'scalar-function',
    objectId: nextObjectId++,
    definition: `CREATE FUNCTION [${overrides.schemaName}].[${overrides.pureName}]() RETURNS int AS BEGIN RETURN 1 END`,
    isSchemaBound: false,
    usesAnsiNulls: true,
    usesQuotedIdentifier: true,
    isEncrypted: false,
    parameters: [],
    comment: null,
    ...overrides,
  };
}

function dependency(
  from: { kind: MssqlObjectDependency['fromKind']; schemaName: string; name: string },
  to: { kind: MssqlObjectDependency['toKind']; schemaName: string; name: string },
  isSchemaBoundReference: boolean,
): MssqlObjectDependency {
  return {
    fromKind: from.kind,
    fromSchemaName: from.schemaName,
    fromName: from.name,
    toKind: to.kind,
    toSchemaName: to.schemaName,
    toName: to.name,
    isSchemaBoundReference,
  };
}

function indexOfName(entries: readonly { name: string }[], name: string): number {
  return entries.findIndex(e => e.name === name);
}

describe('inspectDumpArchive: foreign key cycles', () => {
  it('never reports a cycle for mutually referencing foreign keys (FK edges only ever target pre-data tables)', () => {
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
    expect(inspection.cycles).toEqual([]);

    // Both foreign keys land after all table data, and after each table's own creation.
    const dataOrdersIdx = indexOfName(inspection.entries, 'Orders');
    const fkIdx = inspection.entries.findIndex(e => e.objectType === 'foreignKey');
    expect(fkIdx).toBeGreaterThan(dataOrdersIdx);
  });

  it('handles a self-referencing foreign key without a false cycle, and without a duplicated edge', () => {
    const database = buildEmptyDatabase({
      schemas: [{ schemaName: 'dbo', ownerName: 'dbo' }],
      tables: [
        {
          schemaName: 'dbo',
          pureName: 'Employees',
          objectId: 1,
          createDate: null,
          modifyDate: null,
          comment: null,
          isMemoryOptimized: false,
          durability: null,
          isSystemVersioned: false,
          historyTableSchemaName: null,
          historyTablePureName: null,
          columns: [],
        },
      ],
      primaryKeys: [
        {
          constraintName: 'PK_Employees',
          schemaName: 'dbo',
          pureName: 'Employees',
          isClustered: true,
          columns: [{ columnName: 'Id', ordinalPosition: 1, isDescending: false }],
        },
      ],
      foreignKeys: [
        {
          constraintName: 'FK_Employees_Manager',
          schemaName: 'dbo',
          pureName: 'Employees',
          refSchemaName: 'dbo',
          refTableName: 'Employees',
          updateAction: 'NO ACTION',
          deleteAction: 'NO ACTION',
          isNotTrusted: false,
          isDisabled: false,
          columns: [{ columnName: 'ManagerId', refColumnName: 'Id', ordinalPosition: 1 }],
        },
      ],
    });

    const inspection = inspectDumpArchive(database);
    expect(inspection.valid).toBe(true);
    expect(inspection.cycles).toEqual([]);

    const fk = inspection.entries.find(e => e.objectType === 'foreignKey');
    expect(fk).toBeDefined();
    // Both "own table" and "referenced table" resolve to the same Employees entry: exactly one edge, not two.
    expect(fk?.dependsOn).toHaveLength(1);

    const tableIdx = inspection.entries.findIndex(e => e.objectType === 'table');
    const fkIdx = inspection.entries.findIndex(e => e.objectType === 'foreignKey');
    expect(fkIdx).toBeGreaterThan(tableIdx);
  });
});

describe('inspectDumpArchive: programmable object dependencies', () => {
  it('orders a view before another view that depends on it, overriding what alphabetical order would otherwise pick', () => {
    // Named so that alphabetical tie-break alone would put AAA_View first — wrong, since it
    // selects from ZZZ_View. Only the discovered dependency edge can produce the correct order.
    const database = buildEmptyDatabase({
      schemas: [{ schemaName: 'dbo', ownerName: 'dbo' }],
      views: [
        view({ schemaName: 'dbo', pureName: 'AAA_View' }),
        view({ schemaName: 'dbo', pureName: 'ZZZ_View' }),
      ],
      objectDependencies: [
        dependency(
          { kind: 'view', schemaName: 'dbo', name: 'AAA_View' },
          { kind: 'view', schemaName: 'dbo', name: 'ZZZ_View' },
          true,
        ),
      ],
    });

    const inspection = inspectDumpArchive(database);
    expect(inspection.valid).toBe(true);

    const aaaIdx = indexOfName(inspection.entries, 'AAA_View');
    const zzzIdx = indexOfName(inspection.entries, 'ZZZ_View');
    expect(zzzIdx).toBeLessThan(aaaIdx);

    const aaa = inspection.entries[aaaIdx]!;
    expect(
      aaa.dependsOn.some(
        d => d.targetDumpId === inspection.entries[zzzIdx]!.dumpId && d.strength === 'hard',
      ),
    ).toBe(true);
  });

  it('orders a function before another function that depends on it, using a non-schema-bound (preference) reference', () => {
    const database = buildEmptyDatabase({
      schemas: [{ schemaName: 'dbo', ownerName: 'dbo' }],
      routines: [
        scalarFunction({ schemaName: 'dbo', pureName: 'AAA_Fn' }),
        scalarFunction({ schemaName: 'dbo', pureName: 'ZZZ_Fn' }),
      ],
      objectDependencies: [
        dependency(
          { kind: 'scalar-function', schemaName: 'dbo', name: 'AAA_Fn' },
          { kind: 'scalar-function', schemaName: 'dbo', name: 'ZZZ_Fn' },
          false,
        ),
      ],
    });

    const inspection = inspectDumpArchive(database);
    expect(inspection.valid).toBe(true);

    const aaaIdx = indexOfName(inspection.entries, 'AAA_Fn');
    const zzzIdx = indexOfName(inspection.entries, 'ZZZ_Fn');
    expect(zzzIdx).toBeLessThan(aaaIdx);

    const aaa = inspection.entries[aaaIdx]!;
    expect(
      aaa.dependsOn.some(
        d => d.targetDumpId === inspection.entries[zzzIdx]!.dumpId && d.strength === 'preference',
      ),
    ).toBe(true);
  });

  it('reports a diagnostic instead of guessing when a discovered dependency target is not part of the archive', () => {
    const database = buildEmptyDatabase({
      schemas: [{ schemaName: 'dbo', ownerName: 'dbo' }],
      views: [view({ schemaName: 'dbo', pureName: 'V1' })],
      objectDependencies: [
        dependency(
          { kind: 'view', schemaName: 'dbo', name: 'V1' },
          { kind: 'scalar-function', schemaName: 'dbo', name: 'DoesNotExist' },
          true,
        ),
      ],
    });

    const inspection = inspectDumpArchive(database);
    expect(inspection.valid).toBe(true);
    expect(inspection.diagnostics.some(d => d.code === 'unresolved-programmable-dependency')).toBe(
      true,
    );
  });
});

describe('inspectDumpArchive: hard vs. preference cycle resolution', () => {
  it('reports an unresolved hard cycle between two schema-bound views as invalid, with structured diagnostics', () => {
    const database = buildEmptyDatabase({
      schemas: [{ schemaName: 'dbo', ownerName: 'dbo' }],
      views: [
        view({ schemaName: 'dbo', pureName: 'V1' }),
        view({ schemaName: 'dbo', pureName: 'V2' }),
      ],
      objectDependencies: [
        dependency(
          { kind: 'view', schemaName: 'dbo', name: 'V1' },
          { kind: 'view', schemaName: 'dbo', name: 'V2' },
          true,
        ),
        dependency(
          { kind: 'view', schemaName: 'dbo', name: 'V2' },
          { kind: 'view', schemaName: 'dbo', name: 'V1' },
          true,
        ),
      ],
    });

    const inspection = inspectDumpArchive(database);

    expect(inspection.valid).toBe(false);
    expect(inspection.cycles).toHaveLength(1);
    expect(inspection.cycles[0]?.memberDumpIds).toHaveLength(2);
    expect(
      inspection.diagnostics.some(
        d => d.code === 'archive-dependency-cycle' && d.severity === 'error',
      ),
    ).toBe(true);
    // No executable order is claimed for an invalid archive: no entry gets a sequenceNumber.
    expect(inspection.entries.every(e => e.sequenceNumber === undefined)).toBe(true);
  });

  it('breaks a cycle formed entirely of non-schema-bound (preference) references and still produces a valid order', () => {
    const database = buildEmptyDatabase({
      schemas: [{ schemaName: 'dbo', ownerName: 'dbo' }],
      views: [
        view({ schemaName: 'dbo', pureName: 'V1' }),
        view({ schemaName: 'dbo', pureName: 'V2' }),
      ],
      objectDependencies: [
        dependency(
          { kind: 'view', schemaName: 'dbo', name: 'V1' },
          { kind: 'view', schemaName: 'dbo', name: 'V2' },
          false,
        ),
        dependency(
          { kind: 'view', schemaName: 'dbo', name: 'V2' },
          { kind: 'view', schemaName: 'dbo', name: 'V1' },
          false,
        ),
      ],
    });

    const inspection = inspectDumpArchive(database);

    expect(inspection.valid).toBe(true);
    expect(inspection.cycles).toEqual([]);
    expect(inspection.droppedPreferenceEdges.length).toBeGreaterThan(0);
    expect(inspection.diagnostics.some(d => d.code === 'preference-cycle-broken')).toBe(true);
    expect(
      inspection.entries
        .filter(e => e.objectType === 'view')
        .map(e => e.name)
        .sort(),
    ).toEqual(['V1', 'V2']);
    expect(inspection.entries.every(e => typeof e.sequenceNumber === 'number')).toBe(true);
  });

  it('breaks only the preference edges in a mixed cycle, keeping the hard edge, and still resolves', () => {
    // V1 -[hard]-> V2 -[preference]-> V1: a cycle, but only through the preference edge.
    const database = buildEmptyDatabase({
      schemas: [{ schemaName: 'dbo', ownerName: 'dbo' }],
      views: [
        view({ schemaName: 'dbo', pureName: 'V1' }),
        view({ schemaName: 'dbo', pureName: 'V2' }),
      ],
      objectDependencies: [
        dependency(
          { kind: 'view', schemaName: 'dbo', name: 'V1' },
          { kind: 'view', schemaName: 'dbo', name: 'V2' },
          true,
        ),
        dependency(
          { kind: 'view', schemaName: 'dbo', name: 'V2' },
          { kind: 'view', schemaName: 'dbo', name: 'V1' },
          false,
        ),
      ],
    });

    const inspection = inspectDumpArchive(database);

    expect(inspection.valid).toBe(true);
    expect(inspection.droppedPreferenceEdges).toHaveLength(1);
    // The surviving hard edge still governs the final order: V2 (the dependency) before V1.
    const v1Idx = indexOfName(inspection.entries, 'V1');
    const v2Idx = indexOfName(inspection.entries, 'V2');
    expect(v2Idx).toBeLessThan(v1Idx);
  });
});

describe('inspectDumpArchive: determinism regardless of catalog row order', () => {
  it('produces identical entries and dumpIds whether the underlying model arrays arrive shuffled or not', () => {
    const database = buildSampleDatabase();
    const shuffled = {
      ...database,
      tables: [...database.tables].reverse(),
      primaryKeys: [...database.primaryKeys].reverse(),
      foreignKeys: [...database.foreignKeys].reverse(),
      indexes: [...database.indexes].reverse(),
      checkConstraints: [...database.checkConstraints].reverse(),
      defaultConstraints: [...database.defaultConstraints].reverse(),
      views: [...database.views].reverse(),
    };

    const a = inspectDumpArchive(database);
    const b = inspectDumpArchive(shuffled);

    expect(a.entries.map(e => e.dumpId)).toEqual(b.entries.map(e => e.dumpId));
    expect(a.entries.map(e => `${e.objectType}:${e.schemaName}.${e.name}`)).toEqual(
      b.entries.map(e => `${e.objectType}:${e.schemaName}.${e.name}`),
    );
  });
});

describe('inspectDumpArchive: selection', () => {
  it('excludes an explicitly excluded table even when its schema is included', () => {
    const database = buildSampleDatabase();
    const selection = normalizeDumpSelection({
      excludeTables: [{ schemaName: 'dbo', pureName: 'Orders' }],
    });

    const inspection = inspectDumpArchive(database, { selection });

    expect(inspection.entries.some(e => e.objectType === 'table' && e.name === 'Orders')).toBe(
      false,
    );
    expect(inspection.entries.some(e => e.objectType === 'table' && e.name === 'Customers')).toBe(
      true,
    );
    // Orders' foreign key and index have no owning table in the archive, so they are dropped too.
    expect(inspection.entries.some(e => e.objectType === 'foreignKey')).toBe(false);
    expect(inspection.entries.some(e => e.objectType === 'index')).toBe(false);
  });

  it('excludes an entire schema via excludeSchemas', () => {
    const database = buildEmptyDatabase({
      schemas: [
        { schemaName: 'dbo', ownerName: 'dbo' },
        { schemaName: 'archived', ownerName: 'dbo' },
      ],
      views: [
        view({ schemaName: 'dbo', pureName: 'V1' }),
        view({ schemaName: 'archived', pureName: 'OldView' }),
      ],
    });
    const selection = normalizeDumpSelection({ excludeSchemas: ['archived'] });

    const inspection = inspectDumpArchive(database, { selection });

    expect(inspection.entries.some(e => e.schemaName === 'archived')).toBe(false);
    expect(inspection.entries.some(e => e.name === 'V1')).toBe(true);
  });
});

describe('inspectDumpArchive: strict selection mode', () => {
  it('rejects (rather than silently including) a dependency pulled in from outside the selection', () => {
    const database = buildSampleDatabase();
    const selection = normalizeDumpSelection({
      tables: [{ schemaName: 'dbo', pureName: 'Orders' }],
    });

    const lenient = inspectDumpArchive(database, { selection });
    expect(lenient.valid).toBe(true);
    expect(lenient.diagnostics.some(d => d.code === 'included-as-dependency')).toBe(true);

    const strict = inspectDumpArchive(database, { selection, strictSelection: true });
    expect(strict.valid).toBe(false);
    expect(
      strict.diagnostics.some(
        d => d.code === 'strict-selection-violation' && d.severity === 'error',
      ),
    ).toBe(true);
    // Still no dependency silently dropped either — Customers is still named in the diagnostic/archive,
    // just flagged as a problem instead of auto-included.
    expect(strict.entries.some(e => e.objectType === 'table' && e.name === 'Customers')).toBe(true);
  });
});

describe('inspectDumpArchive: sequence state vs. definition', () => {
  function databaseWithSequence() {
    return buildEmptyDatabase({
      schemas: [{ schemaName: 'dbo', ownerName: 'dbo' }],
      sequences: [
        {
          schemaName: 'dbo',
          pureName: 'OrderNumbers',
          dataType: 'bigint',
          startValue: 1n,
          increment: 1n,
          minValue: 1n,
          maxValue: null,
          isCycling: false,
          currentValue: 42n,
          isCached: true,
          cacheSize: null,
          comment: null,
        },
      ],
    });
  }

  it('includes both the sequence definition (pre-data) and its current-value state (data) in a full dump', () => {
    const inspection = inspectDumpArchive(databaseWithSequence());
    expect(inspection.valid).toBe(true);
    const sequenceEntry = inspection.entries.find(e => e.objectType === 'sequence');
    const stateEntry = inspection.entries.find(e => e.objectType === 'sequenceState');
    expect(sequenceEntry).toBeDefined();
    expect(stateEntry).toBeDefined();
    expect(stateEntry?.section).toBe('data');
    expect(
      stateEntry?.dependsOn.some(
        d => d.targetDumpId === sequenceEntry?.dumpId && d.strength === 'hard',
      ),
    ).toBe(true);
  });

  it('omits sequence state (but keeps the definition) in schema-only mode', () => {
    const inspection = inspectDumpArchive(databaseWithSequence(), { mode: 'schema-only' });
    expect(inspection.entries.some(e => e.objectType === 'sequence')).toBe(true);
    expect(inspection.entries.some(e => e.objectType === 'sequenceState')).toBe(false);
  });

  it('keeps only sequence state (not the definition) in data-only mode', () => {
    const inspection = inspectDumpArchive(databaseWithSequence(), { mode: 'data-only' });
    expect(inspection.entries.some(e => e.objectType === 'sequence')).toBe(false);
    expect(inspection.entries.some(e => e.objectType === 'sequenceState')).toBe(true);
  });
});

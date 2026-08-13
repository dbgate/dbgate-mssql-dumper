import { describe, expect, it } from 'vitest';
import { loadModules, moduleUnavailableDiagnostic } from '../src/introspection/catalog/modules.js';
import { loadRoutines } from '../src/introspection/catalog/routines.js';
import { loadSequences } from '../src/introspection/catalog/sequences.js';
import { loadTriggers } from '../src/introspection/catalog/triggers.js';
import { loadViews } from '../src/introspection/catalog/views.js';
import { createScriptedConnection, row } from './mockConnection.js';

describe('loadSequences', () => {
  it('converts sql_variant-backed bigint columns regardless of driver string/number representation', async () => {
    const connection = createScriptedConnection([
      {
        pattern: 'from sys.sequences seq',
        rows: [
          row({
            schemaName: 'dbo',
            pureName: 'OrderNumbers',
            dataType: 'bigint',
            startValue: '1',
            increment: 1,
            minValue: '1',
            maxValue: '9223372036854775807',
            isCycling: false,
            currentValue: '42',
            cacheSize: 50,
            comment: null,
          }),
        ],
      },
    ]);

    const sequences = await loadSequences(connection);
    expect(sequences).toEqual([
      {
        schemaName: 'dbo',
        pureName: 'OrderNumbers',
        dataType: 'bigint',
        startValue: 1n,
        increment: 1n,
        minValue: 1n,
        maxValue: 9223372036854775807n,
        isCycling: false,
        currentValue: 42n,
        cacheSize: 50,
        comment: null,
      },
    ]);
  });
});

describe('moduleUnavailableDiagnostic', () => {
  it('returns undefined when a definition is present', () => {
    const info = {
      definition: 'CREATE VIEW ...',
      usesAnsiNulls: true,
      usesQuotedIdentifier: true,
      isEncrypted: false,
      isSchemaBound: false,
    };
    expect(moduleUnavailableDiagnostic(info, 'view', 'dbo', 'v1')).toBeUndefined();
  });

  it('reports encrypted-module-definition-unavailable distinctly from a missing module row', () => {
    const encrypted = {
      definition: null,
      usesAnsiNulls: true,
      usesQuotedIdentifier: true,
      isEncrypted: true,
      isSchemaBound: false,
    };
    const missing = {
      definition: null,
      usesAnsiNulls: null,
      usesQuotedIdentifier: null,
      isEncrypted: false,
      isSchemaBound: null,
    };

    expect(moduleUnavailableDiagnostic(encrypted, 'view', 'dbo', 'v1')?.code).toBe(
      'encrypted-module-definition-unavailable',
    );
    expect(moduleUnavailableDiagnostic(missing, 'view', 'dbo', 'v1')?.code).toBe(
      'module-definition-not-found',
    );
  });
});

describe('loadModules', () => {
  it('returns an empty map without querying for an empty id list', async () => {
    const connection = createScriptedConnection([]);
    const modules = await loadModules(connection, []);
    expect(modules.size).toBe(0);
    expect(connection.calls).toHaveLength(0);
  });
});

describe('loadViews (definitions via the shared sql_modules query)', () => {
  it('attaches definition and session-setting flags, and flags an encrypted view', async () => {
    const connection = createScriptedConnection([
      {
        pattern: 'from sys.views v',
        rows: [
          row({
            objectId: 1,
            schemaName: 'dbo',
            pureName: 'vw_Open',
            isSchemaBound: false,
            comment: null,
          }),
          row({
            objectId: 2,
            schemaName: 'dbo',
            pureName: 'vw_Secret',
            isSchemaBound: false,
            comment: null,
          }),
        ],
      },
      {
        pattern: 'from sys.sql_modules m',
        rows: [
          row({
            objectId: 1,
            definition: 'CREATE VIEW [dbo].[vw_Open] AS SELECT 1 AS x',
            usesAnsiNulls: true,
            usesQuotedIdentifier: true,
            isEncrypted: false,
            isSchemaBound: false,
          }),
          row({
            objectId: 2,
            definition: null,
            usesAnsiNulls: true,
            usesQuotedIdentifier: true,
            isEncrypted: true,
            isSchemaBound: false,
          }),
        ],
      },
    ]);

    const result = await loadViews(connection);
    expect(result.views).toHaveLength(2);
    expect(result.views[0]).toMatchObject({
      pureName: 'vw_Open',
      definition: 'CREATE VIEW [dbo].[vw_Open] AS SELECT 1 AS x',
      usesAnsiNulls: true,
      isEncrypted: false,
    });
    expect(result.views[1]).toMatchObject({
      pureName: 'vw_Secret',
      definition: null,
      isEncrypted: true,
    });
    expect(result.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'encrypted-module-definition-unavailable',
        message: expect.stringContaining('vw_Secret'),
        objectReference: {
          kind: 'view',
          schemaName: 'dbo',
          name: 'vw_Secret',
          parentName: undefined,
        },
      },
    ]);
  });

  it('reports module-definition-not-found for a view with no sys.sql_modules row at all', async () => {
    const connection = createScriptedConnection([
      {
        pattern: 'from sys.views v',
        rows: [
          row({
            objectId: 1,
            schemaName: 'dbo',
            pureName: 'vw_Clr',
            isSchemaBound: false,
            comment: null,
          }),
        ],
      },
      { pattern: 'from sys.sql_modules m', rows: [] },
    ]);

    const result = await loadViews(connection);
    expect(result.views[0]?.definition).toBeNull();
    expect(result.diagnostics[0]?.code).toBe('module-definition-not-found');
  });

  it('returns [] without querying sql_modules when there are no views', async () => {
    const connection = createScriptedConnection([{ pattern: 'from sys.views v', rows: [] }]);
    const result = await loadViews(connection);
    expect(result).toEqual({ views: [], diagnostics: [] });
    expect(connection.calls).toHaveLength(1); // only the header query ran
  });
});

describe('loadRoutines', () => {
  it('maps sys.objects.type to the correct routine kind and reads isSchemaBound from sql_modules', async () => {
    const connection = createScriptedConnection([
      {
        pattern: 'from sys.objects o',
        rows: [
          row({
            objectId: 1,
            schemaName: 'dbo',
            pureName: 'usp_DoThing',
            objectType: 'P',
            comment: null,
          }),
          row({
            objectId: 2,
            schemaName: 'dbo',
            pureName: 'fn_Scalar',
            objectType: 'FN',
            comment: null,
          }),
          row({
            objectId: 3,
            schemaName: 'dbo',
            pureName: 'fn_Inline',
            objectType: 'IF',
            comment: null,
          }),
          row({
            objectId: 4,
            schemaName: 'dbo',
            pureName: 'fn_MultiStatement',
            objectType: 'TF',
            comment: null,
          }),
        ],
      },
      {
        pattern: 'from sys.sql_modules m',
        rows: [
          row({
            objectId: 1,
            definition: 'CREATE PROCEDURE ...',
            usesAnsiNulls: true,
            usesQuotedIdentifier: true,
            isEncrypted: false,
            isSchemaBound: false,
          }),
          row({
            objectId: 2,
            definition: 'CREATE FUNCTION ...',
            usesAnsiNulls: true,
            usesQuotedIdentifier: true,
            isEncrypted: false,
            isSchemaBound: true,
          }),
          row({
            objectId: 3,
            definition: 'CREATE FUNCTION ...',
            usesAnsiNulls: true,
            usesQuotedIdentifier: true,
            isEncrypted: false,
            isSchemaBound: false,
          }),
          row({
            objectId: 4,
            definition: 'CREATE FUNCTION ...',
            usesAnsiNulls: true,
            usesQuotedIdentifier: true,
            isEncrypted: false,
            isSchemaBound: false,
          }),
        ],
      },
    ]);

    const result = await loadRoutines(connection);
    expect(result.routines.map(r => r.kind)).toEqual([
      'procedure',
      'scalar-function',
      'inline-table-function',
      'table-function',
    ]);
    expect(result.routines[1]?.isSchemaBound).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });
});

describe('loadTriggers', () => {
  it('derives events from OBJECTPROPERTY flags and resolves the parent via the supplied ref map', async () => {
    const parentRefs = new Map([[2, { schemaName: 'dbo', pureName: 'Orders' }]]);
    const connection = createScriptedConnection([
      {
        pattern: 'from sys.triggers tr',
        rows: [
          row({
            objectId: 100,
            parentId: 2,
            triggerName: 'trg_Orders_AuditInsertUpdate',
            isDisabled: false,
            isInsteadOf: false,
            isInsertTrigger: true,
            isUpdateTrigger: true,
            isDeleteTrigger: false,
          }),
        ],
      },
      {
        pattern: 'from sys.sql_modules m',
        rows: [
          row({
            objectId: 100,
            definition: 'CREATE TRIGGER ...',
            usesAnsiNulls: true,
            usesQuotedIdentifier: true,
            isEncrypted: false,
            isSchemaBound: null,
          }),
        ],
      },
    ]);

    const result = await loadTriggers(connection, [2], parentRefs);
    expect(result.triggers).toEqual([
      {
        triggerName: 'trg_Orders_AuditInsertUpdate',
        objectId: 100,
        schemaName: 'dbo',
        parentName: 'Orders',
        definition: 'CREATE TRIGGER ...',
        isDisabled: false,
        isInsteadOf: false,
        events: ['INSERT', 'UPDATE'],
        usesAnsiNulls: true,
        usesQuotedIdentifier: true,
        isEncrypted: false,
      },
    ]);
  });

  it('returns empty results without querying when there are no parent ids', async () => {
    const connection = createScriptedConnection([]);
    const result = await loadTriggers(connection, [], new Map());
    expect(result).toEqual({ triggers: [], diagnostics: [] });
    expect(connection.calls).toHaveLength(0);
  });

  it('drops a trigger whose parent id is not in the supplied ref map', async () => {
    const connection = createScriptedConnection([
      {
        pattern: 'from sys.triggers tr',
        rows: [
          row({
            objectId: 100,
            parentId: 999,
            triggerName: 'trg_Orphan',
            isDisabled: false,
            isInsteadOf: false,
            isInsertTrigger: true,
            isUpdateTrigger: false,
            isDeleteTrigger: false,
          }),
        ],
      },
      { pattern: 'from sys.sql_modules m', rows: [] },
    ]);

    const result = await loadTriggers(connection, [999], new Map());
    expect(result.triggers).toEqual([]);
  });
});

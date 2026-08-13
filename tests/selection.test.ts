import { describe, expect, it } from 'vitest';
import {
  isSchemaSelected,
  isTableSelected,
  normalizeDumpSelection,
} from '../src/selection/index.js';

describe('normalizeDumpSelection', () => {
  it('excludes system schemas by default', () => {
    const selection = normalizeDumpSelection();
    expect(isSchemaSelected('sys', selection)).toBe(false);
    expect(isSchemaSelected('INFORMATION_SCHEMA', selection)).toBe(false);
    expect(isSchemaSelected('db_owner', selection)).toBe(false);
    expect(isSchemaSelected('dbo', selection)).toBe(true);
  });

  it('includes system schemas when requested', () => {
    const selection = normalizeDumpSelection({ includeSystemSchemas: true });
    expect(isSchemaSelected('sys', selection)).toBe(true);
  });

  it('restricts to an explicit schema allow-list', () => {
    const selection = normalizeDumpSelection({ schemas: ['app'] });
    expect(isSchemaSelected('app', selection)).toBe(true);
    expect(isSchemaSelected('other', selection)).toBe(false);
  });

  it('respects exact case-sensitive table names, never treated as patterns', () => {
    const selection = normalizeDumpSelection({
      tables: [{ schemaName: 'dbo', pureName: 'Orders' }],
    });
    expect(isTableSelected('dbo', 'Orders', selection)).toBe(true);
    expect(isTableSelected('dbo', 'orders', selection)).toBe(false);
    expect(isTableSelected('dbo', 'OrderLines', selection)).toBe(false);
  });

  it('applies excludeTables after the include list', () => {
    const selection = normalizeDumpSelection({
      excludeTables: [{ schemaName: 'dbo', pureName: 'AuditLog' }],
    });
    expect(isTableSelected('dbo', 'AuditLog', selection)).toBe(false);
    expect(isTableSelected('dbo', 'Orders', selection)).toBe(true);
  });

  it('excludes a table whose schema is excluded even if explicitly listed', () => {
    const selection = normalizeDumpSelection({
      tables: [{ schemaName: 'sys', pureName: 'objects' }],
    });
    expect(isTableSelected('sys', 'objects', selection)).toBe(false);
  });
});

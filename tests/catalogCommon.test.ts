import { describe, expect, it } from 'vitest';
import { buildObjectRefMap, toBigIntOrNull } from '../src/introspection/catalog/common.js';
import { objectIdFilter } from '../src/introspection/catalog/objectIdFilter.js';

describe('toBigIntOrNull', () => {
  it('passes through null/undefined as null', () => {
    expect(toBigIntOrNull(null)).toBeNull();
    expect(toBigIntOrNull(undefined)).toBeNull();
  });

  it('accepts a real bigint unchanged', () => {
    expect(toBigIntOrNull(9007199254740993n)).toBe(9007199254740993n);
  });

  it('converts a driver-returned string (the common case for BIGINT columns)', () => {
    expect(toBigIntOrNull('9007199254740993')).toBe(9007199254740993n);
  });

  it('converts a driver-returned number, truncating toward zero', () => {
    expect(toBigIntOrNull(42)).toBe(42n);
    expect(toBigIntOrNull(42.9)).toBe(42n);
  });

  it('throws for a value it cannot interpret', () => {
    expect(() => toBigIntOrNull(true)).toThrow();
    expect(() => toBigIntOrNull({})).toThrow();
  });
});

describe('objectIdFilter', () => {
  it('builds an OPENJSON-scoped IN clause and a JSON-encoded parameter', () => {
    const filter = objectIdFilter('t.object_id', 'tableIds', [1, 2, 3]);
    expect(filter.clause).toBe(
      't.object_id IN (SELECT CAST(value AS int) FROM OPENJSON(@tableIds))',
    );
    expect(filter.parameter).toEqual({ name: 'tableIds', value: '[1,2,3]', sqlType: 'NVarChar' });
  });

  it('produces valid SQL for an empty ID list rather than special-casing it', () => {
    const filter = objectIdFilter('t.object_id', 'tableIds', []);
    expect(filter.parameter.value).toBe('[]');
  });

  it('rejects a non-integer id rather than silently formatting it', () => {
    expect(() => objectIdFilter('t.object_id', 'tableIds', [1, 1.5])).toThrow();
  });

  it('rejects a negative id', () => {
    expect(() => objectIdFilter('t.object_id', 'tableIds', [-1])).toThrow();
  });
});

describe('buildObjectRefMap', () => {
  it('maps object_id to schemaName/pureName', () => {
    const map = buildObjectRefMap([
      { objectId: 1, schemaName: 'dbo', pureName: 'Customers' },
      { objectId: 2, schemaName: 'sales', pureName: 'Orders' },
    ]);
    expect(map.get(1)).toEqual({ schemaName: 'dbo', pureName: 'Customers' });
    expect(map.get(2)).toEqual({ schemaName: 'sales', pureName: 'Orders' });
    expect(map.get(99)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import type {
  MssqlConnection,
  MssqlQuery,
  MssqlQueryResult,
  MssqlRow,
} from '../src/connection/types.js';
import { detectSourceCapabilities } from '../src/version/capabilities.js';
import { detectMssqlVersion } from '../src/version/detect.js';
import { engineEditionFromServerProperty, parseMssqlProductVersion } from '../src/version/types.js';
import type { MssqlVersion } from '../src/version/types.js';

function createFakeConnection(row: MssqlRow | undefined): MssqlConnection {
  return {
    async query<Row extends MssqlRow = MssqlRow>(
      _query: MssqlQuery,
    ): Promise<MssqlQueryResult<Row>> {
      return { rows: row ? [row as Row] : [], columns: [], rowsAffected: row ? 1 : 0 };
    },
    stream<Row extends MssqlRow = MssqlRow>(): AsyncIterable<Row> {
      return (async function* () {})();
    },
    async cancel(): Promise<void> {},
  };
}

describe('parseMssqlProductVersion', () => {
  it('parses a standard four-part version string', () => {
    expect(parseMssqlProductVersion('16.0.1000.6')).toEqual({
      majorVersion: 16,
      minorVersion: 0,
      buildNumber: 1000,
      revision: 6,
    });
  });

  it('throws on malformed input', () => {
    expect(() => parseMssqlProductVersion('not-a-version')).toThrow();
  });
});

describe('engineEditionFromServerProperty', () => {
  it('maps known engine edition codes', () => {
    expect(engineEditionFromServerProperty(3)).toBe('enterprise');
    expect(engineEditionFromServerProperty(5)).toBe('azure-sql-database');
    expect(engineEditionFromServerProperty(999)).toBe('unknown');
  });
});

describe('detectMssqlVersion', () => {
  it('reads SERVERPROPERTY(...) and normalizes it, without parsing @@VERSION text', async () => {
    const connection = createFakeConnection({
      productVersion: '15.0.2000.5',
      productLevel: 'RTM',
      engineEdition: 3,
    });

    const version = await detectMssqlVersion(connection);

    expect(version).toEqual({
      productVersion: '15.0.2000.5',
      majorVersion: 15,
      minorVersion: 0,
      buildNumber: 2000,
      revision: 5,
      engineEdition: 'enterprise',
      productLevel: 'RTM',
      isAzure: false,
    });
  });

  it('detects Azure SQL Database from engine edition 5', async () => {
    const connection = createFakeConnection({
      productVersion: '12.0.2000.8',
      productLevel: null,
      engineEdition: 5,
    });

    const version = await detectMssqlVersion(connection);
    expect(version.engineEdition).toBe('azure-sql-database');
    expect(version.isAzure).toBe(true);
    expect(version.productLevel).toBeUndefined();
  });

  it('throws a clear error when SERVERPROPERTY returns no row', async () => {
    const connection = createFakeConnection(undefined);
    await expect(detectMssqlVersion(connection)).rejects.toThrow(/SERVERPROPERTY/);
  });
});

function version(overrides: Partial<MssqlVersion>): MssqlVersion {
  return {
    productVersion: '13.0.0.0',
    majorVersion: 13,
    minorVersion: 0,
    buildNumber: 0,
    revision: 0,
    engineEdition: 'standard',
    isAzure: false,
    ...overrides,
  };
}

describe('detectSourceCapabilities', () => {
  it('gates features by on-premises major version', () => {
    const sql2012 = detectSourceCapabilities(version({ majorVersion: 11 }));
    expect(sql2012.supportsSequences).toBe(true);
    expect(sql2012.supportsTemporalTables).toBe(false);

    const sql2016 = detectSourceCapabilities(version({ majorVersion: 13 }));
    expect(sql2016.supportsTemporalTables).toBe(true);
    expect(sql2016.supportsGraphTables).toBe(false);
  });

  it('treats Azure as always current', () => {
    const azure = detectSourceCapabilities(
      version({ majorVersion: 12, isAzure: true, engineEdition: 'azure-sql-database' }),
    );
    expect(azure.supportsGraphTables).toBe(true);
    expect(azure.supportsNativeJsonType).toBe(true);
  });
});

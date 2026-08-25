import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { dumpMssql } from '../src/api/dump.js';
import type {
  MssqlConnection,
  MssqlQuery,
  MssqlQueryResult,
  MssqlRow,
} from '../src/connection/types.js';
import { row } from './mockConnection.js';

/**
 * A minimal end-to-end scenario: one schema, one table with an identity
 * column, and two data rows. Every catalog query introspection issues gets
 * an (mostly empty) canned response via `query()`; the table's actual row
 * data is served through `stream()`, which introspection itself never
 * calls — only `exportTableDataAsInserts` does — so this cleanly separates
 * "schema metadata" from "row data" within one fake connection.
 */
function createEndToEndScenario() {
  const dataRows: MssqlRow[] = [row({ Id: 1, Name: 'Alpha' }), row({ Id: 2, Name: 'Beta' })];

  const connection: MssqlConnection = {
    async query<Row extends MssqlRow = MssqlRow>(
      query: MssqlQuery,
    ): Promise<MssqlQueryResult<Row>> {
      const respond = (rows: readonly MssqlRow[]): MssqlQueryResult<Row> => ({
        rows: rows as readonly Row[],
        columns: [],
        rowsAffected: rows.length,
      });

      if (query.sql.includes('SERVERPROPERTY')) {
        return respond([
          row({ productVersion: '16.0.1000.6', productLevel: 'RTM', engineEdition: 2 }),
        ]);
      }
      if (query.sql.includes('DATABASEPROPERTYEX')) {
        return respond([
          row({
            databaseName: 'WidgetsDb',
            collationName: 'SQL_Latin1_General_CP1_CI_AS',
            compatibilityLevel: 160,
          }),
        ]);
      }
      if (query.sql.includes('from sys.schemas s')) {
        return respond([row({ schemaName: 'dbo', ownerName: 'dbo' })]);
      }
      if (query.sql.includes('from sys.tables t')) {
        return respond([
          row({
            objectId: 1,
            schemaName: 'dbo',
            pureName: 'Widgets',
            createDate: null,
            modifyDate: null,
            isMemoryOptimized: false,
            durabilityDesc: null,
            temporalTypeDesc: 'NON_TEMPORAL_TABLE',
            historyTableSchemaName: null,
            historyTablePureName: null,
            comment: null,
          }),
        ]);
      }
      if (query.sql.includes('from sys.columns c')) {
        return respond([
          row({
            objectId: 1,
            columnId: 1,
            columnName: 'Id',
            dataType: 'int',
            maxLength: 4,
            precision: 10,
            scale: 0,
            isNullable: false,
            collationName: null,
            isRowGuidCol: false,
            isSparse: false,
            isIdentity: true,
            identitySeed: 1,
            identityIncrement: 1,
            computedExpression: null,
            isPersisted: null,
            defaultConstraintName: null,
            defaultExpression: null,
            comment: null,
          }),
          row({
            objectId: 1,
            columnId: 2,
            columnName: 'Name',
            dataType: 'nvarchar',
            maxLength: 100,
            precision: 0,
            scale: 0,
            isNullable: true,
            collationName: null,
            isRowGuidCol: false,
            isSparse: false,
            isIdentity: false,
            identitySeed: null,
            identityIncrement: null,
            computedExpression: null,
            isPersisted: null,
            defaultConstraintName: null,
            defaultExpression: null,
            comment: null,
          }),
        ]);
      }
      if (
        query.sql.includes('from sys.foreign_keys fk') ||
        query.sql.includes('from sys.key_constraints kc') ||
        query.sql.includes('from sys.check_constraints cc') ||
        query.sql.includes('from sys.default_constraints dc') ||
        query.sql.includes('from sys.indexes i') ||
        query.sql.includes('from sys.indexes vi') ||
        query.sql.includes('from sys.sequences seq') ||
        query.sql.includes('from sys.views v') ||
        query.sql.includes('from sys.objects o') ||
        query.sql.includes('from sys.triggers tr') ||
        query.sql.includes('from sys.sql_modules m') ||
        query.sql.includes('from sys.sql_expression_dependencies d')
      ) {
        return respond([]);
      }
      throw new Error(`No scripted response configured for query:\n${query.sql}`);
    },
    stream<Row extends MssqlRow = MssqlRow>(query: MssqlQuery): AsyncIterable<Row> {
      if (!query.sql.includes('FROM') || !query.sql.toLowerCase().includes('widgets')) {
        throw new Error(`Unexpected stream() query:\n${query.sql}`);
      }
      return (async function* () {
        for (const dataRow of dataRows) {
          yield dataRow as unknown as Row;
        }
      })();
    },
    async cancel(): Promise<void> {},
    async getTransactionStatus() {
      return 'idle' as const;
    },
  };

  return connection;
}

function collectOutput(): { stream: PassThrough; getText: () => string } {
  const chunks: Buffer[] = [];
  const stream = new PassThrough();
  stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
  return { stream, getText: () => Buffer.concat(chunks).toString('utf8') };
}

describe('dumpMssql end-to-end', () => {
  it('renders schema and streams table data in one continuous plain-SQL output', async () => {
    const connection = createEndToEndScenario();
    const { stream, getText } = collectOutput();

    const progressPhases: string[] = [];
    const result = await dumpMssql(connection, { mode: 'full' }, stream, event => {
      progressPhases.push(event.phase);
    });

    stream.end();

    expect(result.rowsExported).toBe(2);
    expect(result.warnings.some(w => w.code === 'data-not-rendered')).toBe(false);

    const text = getText();
    expect(text).toContain('CREATE TABLE dbo.Widgets');
    const createIdx = text.indexOf('CREATE TABLE dbo.Widgets');

    // Data is interleaved at its correct archive position: after the table definition.
    expect(text).toContain("(1, N'Alpha')");
    expect(text).toContain("(2, N'Beta')");
    const dataIdx = text.indexOf("(1, N'Alpha')");
    expect(dataIdx).toBeGreaterThan(createIdx);

    expect(progressPhases).toContain('connecting');
    expect(progressPhases).toContain('detecting-version');
    expect(progressPhases).toContain('planning-archive');
    expect(progressPhases).toContain('exporting-data');
    expect(progressPhases).toContain('finalizing');
  });

  it('does not export table data in schema-only mode', async () => {
    const connection = createEndToEndScenario();
    const { stream, getText } = collectOutput();

    const result = await dumpMssql(connection, { mode: 'schema-only' }, stream);
    stream.end();

    expect(result.rowsExported).toBe(0);
    const text = getText();
    expect(text).toContain('CREATE TABLE dbo.Widgets');
    expect(text).not.toContain('Alpha');
  });

  it('reports rows written incrementally via onProgress during data export', async () => {
    const connection = createEndToEndScenario();
    const { stream } = collectOutput();
    const rowCounts: number[] = [];

    await dumpMssql(connection, { mode: 'full' }, stream, event => {
      if (
        event.phase === 'exporting-data' &&
        event.exportState === 'progress' &&
        typeof event.objectsProcessed === 'number'
      ) {
        rowCounts.push(event.objectsProcessed);
      }
    });
    stream.end();

    expect(rowCounts).toEqual([1, 2]);
  });
});

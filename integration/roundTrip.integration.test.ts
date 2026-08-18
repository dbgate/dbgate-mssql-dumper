import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DumpResult } from '../src/api/types.js';
import { introspectMssql } from '../src/introspection/introspect.js';
import type { MssqlIntrospectionResult } from '../src/introspection/types.js';
import { restoreSqlDump } from '../src/restore/restoreSqlDump.js';
import type { SqlDumpRestoreResult } from '../src/restore/types.js';
import {
  BIG_TABLE_ROW_COUNT,
  KNOWN_LIMITATION_TABLE,
  STRICTLY_COMPARED_TABLES,
} from './fixture/data.js';
import { dumpToString, naivelySplitOnGoLines } from './helpers/dump.js';
import { createFixtureDatabases } from './helpers/fixtureDatabase.js';
import type { FixtureDatabases } from './helpers/fixtureDatabase.js';
import { normalizeDatabase } from './helpers/normalize.js';
import { probeServer } from './helpers/server.js';
import { readScalarText, readTableSnapshot } from './helpers/snapshot.js';

const availability = await probeServer();
const describeIntegration = availability.available ? describe : describe.skip;

describeIntegration('round-trip: source -> dump -> empty target -> restore -> verify', () => {
  let fixtures: FixtureDatabases;
  let dumpSql: string;
  let dumpResult: DumpResult;
  let restoreResult: SqlDumpRestoreResult;
  let targetIntrospection: MssqlIntrospectionResult;

  beforeAll(async () => {
    fixtures = await createFixtureDatabases('rt');

    const dumped = await dumpToString(fixtures.source.connection, { mode: 'full' });
    dumpSql = dumped.sql;
    dumpResult = dumped.result;

    restoreResult = await restoreSqlDump({
      connection: fixtures.target.connection,
      source: dumpSql,
    });

    targetIntrospection = await introspectMssql(fixtures.target.connection);
  });

  afterAll(async () => {
    await fixtures?.dispose();
  });

  // --------------------------------------------------------------- the dump

  it("produces a dump with this package's header and no leaked credentials", () => {
    expect(dumpSql.startsWith('-- dbgate-mssql-dumper plain SQL dump')).toBe(true);
    expect(dumpSql).toContain(`-- Database: ${fixtures.source.name}`);
    expect(dumpSql).toContain('-- Source: SQL Server ');
    expect(dumpSql).not.toContain('Str0ng!Passw0rd');
    expect(dumpSql).not.toMatch(/password/i);
  });

  it('reports no error-severity diagnostics for the fixture', () => {
    const errors = dumpResult.warnings.filter(w => w.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('exports every fixture row', () => {
    // 4 customers + 4 orders + 4 audit rows + 4 AllTypes + 2 LegacyLobs + 1
    // PrecisionLimits + 2 MutualA + 2 MutualB + 2 weird + 2 reserved +
    // 2 Unicode + BigTable.
    expect(dumpResult.rowsExported).toBe(31 + BIG_TABLE_ROW_COUNT);
  });

  // ------------------------------------------------------------ the restore

  it('restores every batch with no failures', () => {
    expect(restoreResult.errors).toEqual([]);
    expect(restoreResult.batchesFailed).toBe(0);
    expect(restoreResult.cancelled).toBe(false);
    expect(restoreResult.batchesExecuted).toBeGreaterThan(0);
  });

  // --------------------------------------------------- schema verification

  it('reproduces the complete normalized schema on the target', () => {
    // Compares every schema, table, column (type/nullability/identity/
    // computed/collation/default), PK, unique constraint, FK (including
    // referential actions), check constraint, default constraint, index
    // (including uniqueness/filter/INCLUDE/direction), sequence, view,
    // routine and trigger — everything except what legitimately differs
    // between two databases (see `normalizeDatabase`).
    expect(normalizeDatabase(targetIntrospection.database)).toEqual(
      normalizeDatabase(fixtures.sourceIntrospection.database),
    );
  });

  it('recreates every schema, including Unicode, spaced and reserved-word names', () => {
    const schemaNames = targetIntrospection.database.schemas.map(s => s.schemaName);
    expect(schemaNames).toContain('sales');
    expect(schemaNames).toContain('Ünïcødé');
    expect(schemaNames).toContain('weird schema');
    expect(schemaNames).toContain('select');
  });

  it('recreates a column whose name contains a closing bracket and an emoji', () => {
    const table = targetIntrospection.database.tables.find(
      t => t.schemaName === 'weird schema' && t.pureName === 'Table With Spaces',
    );
    const columnNames = table?.columns.map(c => c.columnName) ?? [];
    expect(columnNames).toContain('Col]Bracket');
    expect(columnNames).toContain('Ünïcødé Column 🚀');
    expect(columnNames).toContain('order');
  });

  it('recreates every programmable object kind', () => {
    const { views, routines, triggers } = targetIntrospection.database;
    expect(views.map(v => `${v.schemaName}.${v.pureName}`).sort()).toEqual([
      'dbo.vBaseForTrigger',
      'sales.vCustomerOrderSummary',
      'sales.vCustomerOrders',
    ]);
    const routineKeys = routines.map(r => `${r.kind}:${r.schemaName}.${r.pureName}`).sort();
    expect(routineKeys).toContain('scalar-function:dbo.fnDouble');
    expect(routineKeys).toContain('scalar-function:sales.fnCustomerName');
    expect(routineKeys).toContain('inline-table-function:sales.tvfOrdersForCustomer');
    expect(routineKeys).toContain('procedure:sales.uspGetCustomer');
    expect(routineKeys).toContain('procedure:dbo.uspGoTrap');
    // Includes an INSTEAD OF trigger whose parent is a *view*, not a table.
    expect(triggers.map(t => t.triggerName).sort()).toEqual(['trInsteadOfView', 'trOrdersAudit']);
    const insteadOf = triggers.find(t => t.triggerName === 'trInsteadOfView');
    expect(insteadOf?.isInsteadOf).toBe(true);
    expect(insteadOf?.parentName).toBe('vBaseForTrigger');
  });

  // ----------------------------------------------------- data verification

  it.each(STRICTLY_COMPARED_TABLES.map(t => [`${t.schemaName}.${t.pureName}`, t] as const))(
    'restores %s with byte-identical values for every comparable column',
    async (_label, table) => {
      const before = await readTableSnapshot(
        fixtures.source.connection,
        fixtures.sourceIntrospection.database,
        table.schemaName,
        table.pureName,
      );
      const after = await readTableSnapshot(
        fixtures.target.connection,
        targetIntrospection.database,
        table.schemaName,
        table.pureName,
      );

      expect(after.columns).toEqual(before.columns);
      expect(after.rows.length).toBe(before.rows.length);
      expect(after.rows).toEqual(before.rows);
    },
  );

  it('restores all 5000 streamed BigTable rows', async () => {
    const count = await readScalarText(
      fixtures.target.connection,
      'select cast(count(*) as nvarchar(32)) as value from [dbo].[BigTable]',
    );
    expect(count).toBe(String(BIG_TABLE_ROW_COUNT));
  });

  it('preserves identity values exactly, including the deliberate gap', async () => {
    const ids = await readTableSnapshot(
      fixtures.target.connection,
      targetIntrospection.database,
      'sales',
      'Customers',
    );
    expect(ids.rows.map(row => row[0])).toEqual(['1', '2', '3', '100']);
  });

  it('leaves the target identity counter past the highest restored value', async () => {
    // IDENTITY_INSERT-restored rows must still advance the counter, or the
    // next natural insert would collide with an existing key.
    const current = await readScalarText(
      fixtures.target.connection,
      "select cast(ident_current('sales.Customers') as nvarchar(32)) as value",
    );
    expect(Number(current)).toBeGreaterThanOrEqual(100);
  });

  it('does not re-fire the AFTER INSERT trigger while restoring table data', async () => {
    // The trigger writes one OrderAudit row per inserted order. Those rows are
    // themselves dumped and restored, so if the trigger also fired during the
    // data load the target would hold twice as many.
    const sourceCount = await readScalarText(
      fixtures.source.connection,
      'select cast(count(*) as nvarchar(32)) as value from [sales].[OrderAudit]',
    );
    const targetCount = await readScalarText(
      fixtures.target.connection,
      'select cast(count(*) as nvarchar(32)) as value from [sales].[OrderAudit]',
    );
    expect(sourceCount).toBe('4');
    expect(targetCount).toBe(sourceCount);
  });

  it('restores mutually referencing foreign keys with their rows intact', async () => {
    const value = await readScalarText(
      fixtures.target.connection,
      `select cast(count(*) as nvarchar(32)) as value
       from [dbo].[MutualA] a join [dbo].[MutualB] b on a.[BId] = b.[Id] and b.[AId] = a.[Id]`,
    );
    expect(value).toBe('2');
  });

  it('keeps computed columns computable and consistent after restore', async () => {
    const value = await readScalarText(
      fixtures.target.connection,
      `select cast(count(*) as nvarchar(32)) as value
       from [dbo].[AllTypes]
       where [ColComputedDouble] is not null
         and [ColComputedDouble] <> cast([ColInt] as bigint) * 2`,
    );
    expect(value).toBe('0');
  });

  // ------------------------------------------------- ordering / batch shape

  it('orders the dump so tables precede their foreign keys and indexes', () => {
    const createOrders = dumpSql.indexOf('CREATE TABLE sales.Orders');
    const createCustomers = dumpSql.indexOf('CREATE TABLE sales.Customers');
    const addForeignKey = dumpSql.indexOf('ADD CONSTRAINT FK_Orders_Customers');
    const createIndex = dumpSql.indexOf('CREATE NONCLUSTERED INDEX IX_Orders_Customer_Date');

    expect(createCustomers).toBeGreaterThan(-1);
    expect(createOrders).toBeGreaterThan(-1);
    expect(addForeignKey).toBeGreaterThan(createOrders);
    expect(addForeignKey).toBeGreaterThan(createCustomers);
    expect(createIndex).toBeGreaterThan(createOrders);
  });

  it('orders the dump so table data precedes foreign keys and the trigger', () => {
    // Module bodies are emitted verbatim from `sys.sql_modules`, so their
    // keyword case is whatever the original CREATE used — search case-
    // insensitively rather than assuming this package upper-cased them.
    const lower = dumpSql.toLowerCase();
    const firstDataInsert = lower.indexOf('insert into sales.orders');
    const addForeignKey = lower.indexOf('add constraint fk_orders_customers');
    const createTrigger = lower.indexOf('create trigger');

    expect(firstDataInsert).toBeGreaterThan(-1);
    expect(createTrigger).toBeGreaterThan(-1);
    expect(addForeignKey).toBeGreaterThan(firstDataInsert);
    expect(createTrigger).toBeGreaterThan(firstDataInsert);
  });

  it('orders the dump so a view depending on a view comes after it', () => {
    const lower = dumpSql.toLowerCase();
    const dependent = lower.indexOf('create view [sales].[vcustomerordersummary]');
    const base = lower.indexOf('create view [sales].[vcustomerorders]');
    expect(base).toBeGreaterThan(-1);
    expect(dependent).toBeGreaterThan(base);
  });

  it('wraps identity tables in SET IDENTITY_INSERT and balances every ON with an OFF', () => {
    const onCount = (dumpSql.match(/SET IDENTITY_INSERT .* ON;/g) ?? []).length;
    const offCount = (dumpSql.match(/SET IDENTITY_INSERT .* OFF;/g) ?? []).length;
    expect(onCount).toBeGreaterThan(0);
    expect(offCount).toBe(onCount);
    expect(dumpSql).toContain('SET IDENTITY_INSERT sales.Customers ON;');
  });

  it('splits streamed data across batches instead of emitting one giant batch', () => {
    // 5000 BigTable rows must not become a single T-SQL batch: that would
    // exceed the restore parser's batch-size bound and force the whole thing
    // into memory on the way back in.
    const batches = naivelySplitOnGoLines(dumpSql);
    const biggest = Math.max(...batches.map(batch => Buffer.byteLength(batch, 'utf8')));
    expect(biggest).toBeLessThan(8 * 1024 * 1024);
  });

  // --------------------------------------------- documented driver limits

  it('reports the known precision/offset limitations as structured warnings', () => {
    const codes = new Set(dumpResult.warnings.map(w => w.code));
    expect(codes).toContain('possible-precision-loss');
    expect(codes).toContain('datetimeoffset-normalized-to-utc');
    expect(dumpResult.warnings.every(w => w.severity !== 'error')).toBe(true);
  });

  it('preserves the datetimeoffset instant even though the display offset is lost', async () => {
    const table = KNOWN_LIMITATION_TABLE;
    const asUtc = (connectionName: 'source' | 'target'): Promise<string | null> =>
      readScalarText(
        fixtures[connectionName].connection,
        `select convert(nvarchar(64), [OffsetPlus] at time zone 'UTC', 121) as value
         from ${`[${table.schemaName}].[${table.pureName}]`} where [Id] = 1`,
      );

    // Same point in time on both sides...
    expect(await asUtc('target')).toBe(await asUtc('source'));

    // ...but the original +05:45 offset did not survive, because the Tedious
    // value parser discards it on read. This is asserted rather than tolerated
    // so the limitation cannot regress silently in either direction.
    const rawOffset = await readScalarText(
      fixtures.target.connection,
      `select convert(nvarchar(64), [OffsetPlus], 121) as value
       from ${`[${table.schemaName}].[${table.pureName}]`} where [Id] = 1`,
    );
    expect(rawOffset).toContain('+00:00');
  });

  it('loses precision only beyond ~15 significant digits, as documented', async () => {
    const read = (connectionName: 'source' | 'target'): Promise<string | null> =>
      readScalarText(
        fixtures[connectionName].connection,
        'select convert(nvarchar(64), [HugeDecimal]) as value from [dbo].[PrecisionLimits] where [Id] = 1',
      );

    const sourceValue = await read('source');
    const targetValue = await read('target');

    expect(sourceValue).toBe('1234567890123456789012345678.1234567890');
    // The driver already read this back as a float64, so the exported literal
    // could not carry the full 38 digits. The leading ~15 digits still match.
    expect(targetValue).not.toBe(sourceValue);
    expect(targetValue?.slice(0, 15)).toBe(sourceValue?.slice(0, 15));
  });
});

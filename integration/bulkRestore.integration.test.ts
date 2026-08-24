import { describe, expect, it } from 'vitest';
import type {
  MssqlBulkInsertRequest,
  MssqlConnection,
  MssqlQuery,
  MssqlRow,
  MssqlStreamOptions,
} from '../src/connection/types.js';
import { restoreSqlDump } from '../src/restore/restoreSqlDump.js';
import { createEmptyDatabase } from './helpers/fixtureDatabase.js';
import { execBatches, probeServer } from './helpers/server.js';

const availability = await probeServer();
const describeIntegration = availability.available ? describe : describe.skip;

describeIntegration('native bulk restore', () => {
  it('preserves identity values and large multiline nvarchar data', async () => {
    const empty = await createEmptyDatabase('bulk_restore');
    try {
      await execBatches(empty.database.connection, [
        `create table dbo.Items (
          id int identity(1,1) not null,
          body nvarchar(max) null,
          payload varbinary(max) null,
          created datetime2(7) not null
        );`,
      ]);

      const base = empty.database.connection;
      let bulkCalls = 0;
      const observed: MssqlConnection = {
        query<Row extends MssqlRow = MssqlRow>(query: MssqlQuery, signal?: AbortSignal) {
          return base.query<Row>(query, signal);
        },
        stream<Row extends MssqlRow = MssqlRow>(query: MssqlQuery, options?: MssqlStreamOptions) {
          return base.stream<Row>(query, options);
        },
        execBatch: base.execBatch ? (sql, signal) => base.execBatch!(sql, signal) : undefined,
        bulkInsert: base.bulkInsert
          ? async (request: MssqlBulkInsertRequest, signal?: AbortSignal) => {
              bulkCalls++;
              return base.bulkInsert!(request, signal);
            }
          : undefined,
        getTransactionStatus: base.getTransactionStatus
          ? signal => base.getTransactionStatus!(signal)
          : undefined,
        cancel: () => base.cancel(),
      };

      const large = `before\nGO\nafter ${'ž'.repeat(100_000)}`;
      const escaped = large.replace(/'/g, "''");
      const result = await restoreSqlDump({
        connection: observed,
        source: `SET IDENTITY_INSERT dbo.Items ON;
INSERT INTO dbo.Items (id, body, payload, created) VALUES
(41, N'${escaped}', 0x00ff, '2026-08-24T12:00:00.1234567');
INSERT INTO dbo.Items (id, body, payload, created) VALUES
(99, NULL, NULL, '2026-08-24T12:01:00.0000000');
SET IDENTITY_INSERT dbo.Items OFF;
GO
`,
      });

      expect(result.errors).toEqual([]);
      expect(result.rowsRestored).toBe(2);
      expect(bulkCalls).toBe(1);

      const rows = await base.query<{
        id: number;
        body: string | null;
        payloadHex: string | null;
        createdText: string;
      }>({
        sql: `select id, body,
          convert(varchar(max), payload, 2) as payloadHex,
          convert(varchar(40), created, 126) as createdText
        from dbo.Items order by id`,
      });
      expect(rows.rows).toEqual([
        { id: 41, body: large, payloadHex: '00FF', createdText: '2026-08-24T12:00:00.1234567' },
        { id: 99, body: null, payloadHex: null, createdText: '2026-08-24T12:01:00' },
      ]);
    } finally {
      await empty.dispose();
    }
  });
});

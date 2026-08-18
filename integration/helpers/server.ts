import type { ConnectionConfiguration } from 'tedious';
import type { MssqlConnection } from '../../src/connection/types.js';
import { quoteIdentifier } from '../../src/security/identifiers.js';
import { connectTedious } from '../../src/tedious.js';

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  /** When true, an unreachable server is a hard failure instead of a skip. CI should set this. */
  readonly required: boolean;
  /** How long to keep retrying the initial connection (the container may still be starting). */
  readonly waitMs: number;
}

export function readServerConfig(): ServerConfig {
  return {
    host: process.env.MSSQL_TEST_HOST ?? '127.0.0.1',
    port: Number(process.env.MSSQL_TEST_PORT ?? 14330),
    user: process.env.MSSQL_TEST_USER ?? 'sa',
    password: process.env.MSSQL_TEST_PASSWORD ?? 'Str0ng!Passw0rd#2024',
    required: process.env.MSSQL_TEST_REQUIRED === '1',
    waitMs: Number(process.env.MSSQL_TEST_WAIT_MS ?? 30_000),
  };
}

function tediousConfig(database: string): ConnectionConfiguration {
  const config = readServerConfig();
  return {
    server: config.host,
    authentication: {
      type: 'default',
      options: { userName: config.user, password: config.password },
    },
    options: {
      port: config.port,
      database,
      // Local throwaway container with a self-signed certificate.
      encrypt: false,
      trustServerCertificate: true,
      connectTimeout: 15_000,
      requestTimeout: 300_000,
      // Keep tedious from coercing values on our behalf: the whole point of
      // these tests is to exercise this package's own value handling.
      useUTC: true,
    },
  };
}

export interface OpenConnection {
  readonly connection: MssqlConnection;
  close(): Promise<void>;
}

/** Opens one physical connection to `database` through this package's own Tedious adapter. */
export async function openConnection(database: string): Promise<OpenConnection> {
  return connectTedious(tediousConfig(database));
}

export interface ServerAvailability {
  readonly available: boolean;
  readonly reason?: string;
  readonly productVersion?: string;
}

let availabilityPromise: Promise<ServerAvailability> | null = null;

async function attemptProbe(): Promise<ServerAvailability> {
  const config = readServerConfig();
  const deadline = Date.now() + config.waitMs;
  let lastError = 'unknown error';

  for (;;) {
    let opened: OpenConnection | null = null;
    try {
      opened = await openConnection('master');
      const result = await opened.connection.query<{ version: string }>({
        sql: "select cast(serverproperty('ProductVersion') as nvarchar(128)) as version",
      });
      return { available: true, productVersion: result.rows[0]?.version };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      await opened?.close().catch(() => {});
    }

    if (Date.now() >= deadline) {
      return {
        available: false,
        reason:
          `No SQL Server reachable at ${config.host}:${config.port} after ${config.waitMs}ms — ${lastError}. ` +
          `Start one with "npm run docker:up", or point MSSQL_TEST_HOST/MSSQL_TEST_PORT/MSSQL_TEST_USER/MSSQL_TEST_PASSWORD at an existing instance.`,
      };
    }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
}

/**
 * Probes the configured server once per process. Integration suites gate
 * themselves on the result: absent a server they skip (so `npm run
 * test:integration` is runnable on a machine without Docker), unless
 * `MSSQL_TEST_REQUIRED=1`, which turns absence into a thrown error so the
 * suites can never silently no-op where they were meant to run.
 */
export function probeServer(): Promise<ServerAvailability> {
  availabilityPromise ??= attemptProbe().then(availability => {
    if (!availability.available) {
      const config = readServerConfig();
      if (config.required) {
        throw new Error(`MSSQL_TEST_REQUIRED=1 but ${availability.reason}`);
      }
      console.warn(`\n[integration] SKIPPING: ${availability.reason}\n`);
    }
    return availability;
  });
  return availabilityPromise;
}

/**
 * Executes a list of already-batch-delimited T-SQL strings sequentially.
 *
 * Deliberately does NOT go through `restoreSqlDump`/`SqlBatchParser`: the
 * fixture database must be created by something independent of the code
 * under test, otherwise a batch-splitting bug could corrupt the fixture and
 * mask itself. Each array element is one batch, so no `GO` handling is
 * involved at all here.
 */
export async function execBatches(
  connection: MssqlConnection,
  batches: readonly string[],
): Promise<void> {
  for (const [index, sql] of batches.entries()) {
    try {
      if (connection.execBatch) {
        await connection.execBatch(sql);
      } else {
        await connection.query({ sql });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Fixture batch #${index} failed: ${message}\n--- batch ---\n${sql}\n-------------`,
      );
    }
  }
}

let databaseCounter = 0;

export interface TestDatabase {
  readonly name: string;
  readonly connection: MssqlConnection;
  close(): Promise<void>;
}

/** Drops `name` if it exists, forcing out any lingering session first. */
export async function dropDatabaseIfExists(name: string): Promise<void> {
  const master = await openConnection('master');
  try {
    // Name comes from this test helper, never from user input, but quote it
    // properly anyway — the same rule the library itself follows.
    const ident = quoteIdentifier(name);
    await master.connection.query({
      sql: `if db_id(@name) is not null
begin
  alter database ${ident} set single_user with rollback immediate;
  drop database ${ident};
end`,
      parameters: [{ name: 'name', value: name, sqlType: 'NVarChar' }],
    });
  } finally {
    await master.close();
  }
}

/**
 * Creates a fresh, empty database with a unique name and returns an open
 * connection to it. Callers must `close()` it and then
 * {@link dropDatabaseIfExists} in an `afterAll`.
 */
export async function createTestDatabase(prefix: string): Promise<TestDatabase> {
  const name = `${prefix}_${Date.now().toString(36)}_${++databaseCounter}`;
  const master = await openConnection('master');
  try {
    await master.connection.query({ sql: `create database ${quoteIdentifier(name)}` });
  } finally {
    await master.close();
  }

  const opened = await openConnection(name);
  return { name, connection: opened.connection, close: opened.close };
}

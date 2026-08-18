import { introspectMssql } from '../../src/introspection/introspect.js';
import type { MssqlIntrospectionResult } from '../../src/introspection/types.js';
import { SOURCE_DATA_BATCHES } from '../fixture/data.js';
import { SOURCE_SCHEMA_BATCHES } from '../fixture/schema.js';
import type { TestDatabase } from './server.js';
import { createTestDatabase, dropDatabaseIfExists, execBatches } from './server.js';

export interface FixtureDatabases {
  readonly source: TestDatabase;
  readonly target: TestDatabase;
  /** Introspection of the fully-populated source, cached for reuse across assertions. */
  readonly sourceIntrospection: MssqlIntrospectionResult;
  dispose(): Promise<void>;
}

/**
 * Creates the source database (schema + data) and an empty target database
 * for one round-trip suite. The source is built with {@link execBatches},
 * which never touches this package's own batch parser, so a splitting bug
 * cannot corrupt the fixture and hide itself.
 */
export async function createFixtureDatabases(prefix: string): Promise<FixtureDatabases> {
  const source = await createTestDatabase(`${prefix}_src`);
  let target: TestDatabase | null = null;

  try {
    await execBatches(source.connection, SOURCE_SCHEMA_BATCHES);
    await execBatches(source.connection, SOURCE_DATA_BATCHES);
    const sourceIntrospection = await introspectMssql(source.connection);

    target = await createTestDatabase(`${prefix}_tgt`);
    const createdTarget = target;

    return {
      source,
      target: createdTarget,
      sourceIntrospection,
      dispose: async () => {
        await source.close().catch(() => {});
        await createdTarget.close().catch(() => {});
        await dropDatabaseIfExists(source.name).catch(() => {});
        await dropDatabaseIfExists(createdTarget.name).catch(() => {});
      },
    };
  } catch (error) {
    await source.close().catch(() => {});
    await dropDatabaseIfExists(source.name).catch(() => {});
    if (target) {
      await target.close().catch(() => {});
      await dropDatabaseIfExists(target.name).catch(() => {});
    }
    throw error;
  }
}

/** Creates just an empty database, for suites that build their own tiny schema. */
export async function createEmptyDatabase(prefix: string): Promise<{
  readonly database: TestDatabase;
  dispose(): Promise<void>;
}> {
  const database = await createTestDatabase(prefix);
  return {
    database,
    dispose: async () => {
      await database.close().catch(() => {});
      await dropDatabaseIfExists(database.name).catch(() => {});
    },
  };
}

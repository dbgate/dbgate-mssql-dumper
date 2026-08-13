import type {
  MssqlCheckConstraint,
  MssqlDefaultConstraint,
  MssqlForeignKey,
  MssqlPrimaryKey,
  MssqlUniqueConstraint,
} from './constraint.js';
import type { MssqlIndex } from './indexes.js';
import type { MssqlObjectDependency } from './objectDependency.js';
import type { MssqlRoutine } from './routine.js';
import type { MssqlSchema } from './schema.js';
import type { MssqlSequence } from './sequence.js';
import type { MssqlTable } from './table.js';
import type { MssqlTrigger } from './trigger.js';
import type { MssqlView } from './view.js';

/**
 * The complete normalized model of one database, as returned by
 * {@link introspectMssql}. Objects are independent collections rather than
 * a nested tree; consumers join them by `schemaName`/`pureName` (or
 * `constraintName`/`indexName`) as needed. This mirrors the flat catalog
 * shape SQL Server itself exposes and keeps archive planning free of
 * implicit parent/child traversal.
 */
export interface MssqlDatabase {
  readonly databaseName: string;
  readonly collationName: string | null;
  /** `sys.databases.compatibility_level`, e.g. `160` for SQL Server 2022. */
  readonly compatibilityLevel: number | null;
  readonly schemas: readonly MssqlSchema[];
  readonly tables: readonly MssqlTable[];
  readonly views: readonly MssqlView[];
  readonly routines: readonly MssqlRoutine[];
  readonly triggers: readonly MssqlTrigger[];
  readonly sequences: readonly MssqlSequence[];
  readonly primaryKeys: readonly MssqlPrimaryKey[];
  readonly uniqueConstraints: readonly MssqlUniqueConstraint[];
  readonly foreignKeys: readonly MssqlForeignKey[];
  readonly checkConstraints: readonly MssqlCheckConstraint[];
  readonly defaultConstraints: readonly MssqlDefaultConstraint[];
  readonly indexes: readonly MssqlIndex[];
  /**
   * Discovered view/routine/trigger cross-references (`sys.sql_expression_dependencies`).
   * Optional: absent for a hand-built model (e.g. in tests) or when the
   * introspection run that produced it predates this field; the archive
   * planner treats a missing value the same as an empty array.
   */
  readonly objectDependencies?: readonly MssqlObjectDependency[];
}

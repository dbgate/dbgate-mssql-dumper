import type { MssqlColumn } from './column.js';

export type MssqlTableDurability = 'schema-and-data' | 'schema-only';

/** An ordinary or memory-optimized user table (`sys.tables`, type `'U'`). */
export interface MssqlTable {
  readonly schemaName: string;
  readonly pureName: string;
  readonly objectId: number;
  readonly createDate: Date | null;
  readonly modifyDate: Date | null;
  readonly comment: string | null;
  readonly isMemoryOptimized: boolean;
  readonly durability: MssqlTableDurability | null;
  readonly isSystemVersioned: boolean;
  readonly historyTableSchemaName: string | null;
  readonly historyTablePureName: string | null;
  readonly columns: readonly MssqlColumn[];
}

import type { MssqlModuleMetadata } from './module.js';

export interface MssqlView extends MssqlModuleMetadata {
  readonly schemaName: string;
  readonly pureName: string;
  readonly objectId: number;
  /** `sys.sql_modules.definition`; the full `CREATE VIEW` text, or `null` if unavailable (see {@link MssqlModuleMetadata.isEncrypted}). */
  readonly definition: string | null;
  readonly isSchemaBound: boolean;
  readonly comment: string | null;
}

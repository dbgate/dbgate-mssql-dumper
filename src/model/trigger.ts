import type { MssqlModuleMetadata } from './module.js';

export type MssqlTriggerEvent = 'INSERT' | 'UPDATE' | 'DELETE';

export interface MssqlTrigger extends MssqlModuleMetadata {
  readonly triggerName: string;
  readonly objectId: number;
  readonly schemaName: string;
  /** Table or view the trigger is bound to. */
  readonly parentName: string;
  readonly definition: string | null;
  readonly isDisabled: boolean;
  readonly isInsteadOf: boolean;
  readonly events: readonly MssqlTriggerEvent[];
}

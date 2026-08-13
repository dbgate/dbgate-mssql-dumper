import type { MssqlModuleMetadata } from './module.js';

export type MssqlRoutineKind =
  'procedure' | 'scalar-function' | 'table-function' | 'inline-table-function';

export interface MssqlRoutineParameter {
  readonly parameterName: string;
  readonly ordinalPosition: number;
  readonly dataType: string;
  readonly maxLength: number | null;
  readonly precision: number | null;
  readonly scale: number | null;
  readonly isOutput: boolean;
  readonly hasDefault: boolean;
}

/** A stored procedure or user-defined function (`sys.objects` type `'P'`, `'FN'`, `'TF'`, `'IF'`). */
export interface MssqlRoutine extends MssqlModuleMetadata {
  readonly kind: MssqlRoutineKind;
  readonly schemaName: string;
  readonly pureName: string;
  readonly objectId: number;
  /** Full `CREATE [PROCEDURE|FUNCTION]` text, from `sys.sql_modules`, or `null` if unavailable. */
  readonly definition: string | null;
  readonly isSchemaBound: boolean;
  /**
   * Not yet populated by `introspectMssql()` (always `[]` today); parameter
   * introspection via `sys.parameters` is planned future work.
   */
  readonly parameters: readonly MssqlRoutineParameter[];
  readonly comment: string | null;
}

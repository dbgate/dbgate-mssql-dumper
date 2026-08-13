/** Discriminates every catalog object kind the model can represent. */
export type MssqlObjectKind =
  | 'schema'
  | 'table'
  | 'column'
  | 'view'
  | 'procedure'
  | 'scalar-function'
  | 'table-function'
  | 'inline-table-function'
  | 'trigger'
  | 'sequence'
  | 'primaryKey'
  | 'uniqueConstraint'
  | 'foreignKey'
  | 'checkConstraint'
  | 'defaultConstraint'
  | 'index';

/**
 * A lightweight, denormalized pointer to a catalog object. Used for
 * diagnostics and archive dependency edges, not for storing the object
 * itself.
 */
export interface MssqlObjectReference {
  readonly kind: MssqlObjectKind;
  readonly schemaName: string;
  readonly name: string;
  /** Owning table/view name, for column-, constraint-, index-, and trigger-like kinds. */
  readonly parentName?: string;
}

/**
 * Maps an archive object type (which additionally distinguishes
 * `tableData`/`sequenceState` and uses `'function'` for every function
 * flavor) onto the corresponding {@link MssqlObjectKind} used by
 * diagnostics.
 */
export function archiveObjectTypeToKind(
  objectType: MssqlObjectKind | 'function' | 'tableData' | 'sequenceState',
): MssqlObjectKind {
  if (objectType === 'function') {
    return 'scalar-function';
  }
  if (objectType === 'tableData') {
    return 'table';
  }
  if (objectType === 'sequenceState') {
    return 'sequence';
  }
  return objectType;
}

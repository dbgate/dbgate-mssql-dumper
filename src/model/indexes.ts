/**
 * Matches `sys.indexes.type_desc` verbatim (including its embedded spaces),
 * so mapping from the catalog never needs a translation table.
 */
export type MssqlIndexType =
  | 'HEAP'
  | 'CLUSTERED'
  | 'NONCLUSTERED'
  | 'XML'
  | 'SPATIAL'
  | 'CLUSTERED COLUMNSTORE'
  | 'NONCLUSTERED COLUMNSTORE';

export interface MssqlIndexColumn {
  readonly columnName: string;
  readonly ordinalPosition: number;
  readonly isDescending: boolean;
  /** `INCLUDE (...)` column, not part of the key. */
  readonly isIncluded: boolean;
}

/** An independent, non-constraint-backed index (`sys.indexes` where `is_primary_key = 0`). */
export interface MssqlIndex {
  readonly indexName: string;
  readonly schemaName: string;
  readonly pureName: string;
  readonly indexType: MssqlIndexType;
  readonly isUnique: boolean;
  readonly isUniqueConstraint: boolean;
  readonly isDisabled: boolean;
  /** `sys.indexes.filter_definition`, for filtered indexes. */
  readonly filterDefinition: string | null;
  readonly columns: readonly MssqlIndexColumn[];
}

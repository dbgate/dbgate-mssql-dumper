/** One column participating in a key or index, in ordinal order. */
export interface MssqlKeyColumn {
  readonly columnName: string;
  readonly ordinalPosition: number;
  readonly isDescending: boolean;
}

export interface MssqlPrimaryKey {
  readonly constraintName: string;
  readonly schemaName: string;
  /** Owning table name. */
  readonly pureName: string;
  readonly isClustered: boolean;
  readonly columns: readonly MssqlKeyColumn[];
}

export interface MssqlUniqueConstraint {
  readonly constraintName: string;
  readonly schemaName: string;
  readonly pureName: string;
  readonly isClustered: boolean;
  readonly columns: readonly MssqlKeyColumn[];
}

/**
 * `FOREIGN KEY ... REFERENCES` referential actions. Normalized from
 * `sys.foreign_keys.update_referential_action_desc`/
 * `delete_referential_action_desc`, which use `NO_ACTION`/`SET_NULL`/
 * `SET_DEFAULT` (underscores, not spaces).
 */
export type MssqlForeignKeyAction = 'NO ACTION' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT';

export interface MssqlForeignKeyColumn {
  readonly columnName: string;
  readonly refColumnName: string;
  readonly ordinalPosition: number;
}

export interface MssqlForeignKey {
  readonly constraintName: string;
  readonly schemaName: string;
  readonly pureName: string;
  readonly refSchemaName: string;
  readonly refTableName: string;
  readonly updateAction: MssqlForeignKeyAction;
  readonly deleteAction: MssqlForeignKeyAction;
  /** `sys.foreign_keys.is_not_trusted`; true means `WITH NOCHECK` was used and never re-validated. */
  readonly isNotTrusted: boolean;
  readonly isDisabled: boolean;
  readonly columns: readonly MssqlForeignKeyColumn[];
}

export interface MssqlCheckConstraint {
  readonly constraintName: string;
  readonly schemaName: string;
  readonly pureName: string;
  /** `sys.check_constraints.definition`, including the enclosing parentheses. */
  readonly definition: string;
  readonly isNotTrusted: boolean;
  readonly isDisabled: boolean;
}

export interface MssqlDefaultConstraint {
  readonly constraintName: string;
  readonly schemaName: string;
  readonly pureName: string;
  readonly columnName: string;
  readonly definition: string;
}

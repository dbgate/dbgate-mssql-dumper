/** One column of a table, view, or table-valued function result set. */
export interface MssqlColumn {
  readonly columnName: string;
  readonly ordinalPosition: number;
  /** `sys.types.name`, e.g. `"varchar"`, `"int"`, `"datetime2"`. */
  readonly dataType: string;
  /** `sys.columns.max_length` (bytes; `-1` means `varchar(max)`/`nvarchar(max)`/`varbinary(max)`). */
  readonly maxLength: number | null;
  /** `INFORMATION_SCHEMA.COLUMNS.CHARACTER_MAXIMUM_LENGTH` (character count, not bytes). */
  readonly characterMaxLength: number | null;
  readonly precision: number | null;
  readonly scale: number | null;
  readonly isNullable: boolean;
  readonly isIdentity: boolean;
  readonly identitySeed: number | null;
  readonly identityIncrement: number | null;
  readonly isComputed: boolean;
  readonly computedExpression: string | null;
  readonly isPersisted: boolean | null;
  readonly isSparse: boolean;
  readonly isRowGuidCol: boolean;
  readonly collationName: string | null;
  readonly defaultConstraintName: string | null;
  readonly defaultExpression: string | null;
  /** `sys.extended_properties` value named `MS_Description`, when present. */
  readonly comment: string | null;
}

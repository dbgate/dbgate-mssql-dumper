import type { MssqlColumn } from '../model/column.js';
import { quoteIdentifier } from '../security/identifiers.js';

const CHARACTER_TYPES = new Set(['char', 'varchar', 'nchar', 'nvarchar', 'binary', 'varbinary']);
const PRECISION_SCALE_TYPES = new Set(['decimal', 'numeric']);
/**
 * `datetime2(n)`/`datetimeoffset(n)`/`time(n)` take **fractional-seconds
 * scale**, not precision. `sys.columns.precision` for these holds the total
 * digit count instead — 27, 34 and 16 respectively for scale 7 — so using it
 * as the type argument produces `datetimeoffset(34)`, which SQL Server
 * rejects with "Specified scale 34 is invalid".
 */
const SCALE_ONLY_TYPES = new Set(['datetime2', 'datetimeoffset', 'time']);

/**
 * Every SQL Server system type name. Anything outside this set came from
 * `sys.types` as a user-defined alias or CLR type, whose name is an ordinary
 * identifier — it must keep its original case (the database collation may be
 * case-sensitive) and be bracket-quoted (it may contain a space or a `]`),
 * unlike a built-in keyword.
 */
const BUILT_IN_TYPES = new Set([
  'bigint',
  'binary',
  'bit',
  'char',
  'date',
  'datetime',
  'datetime2',
  'datetimeoffset',
  'decimal',
  'float',
  'geography',
  'geometry',
  'hierarchyid',
  'image',
  'int',
  'json',
  'money',
  'nchar',
  'ntext',
  'numeric',
  'nvarchar',
  'real',
  'rowversion',
  'smalldatetime',
  'smallint',
  'smallmoney',
  'sql_variant',
  'sysname',
  'text',
  'time',
  'timestamp',
  'tinyint',
  'uniqueidentifier',
  'varbinary',
  'varchar',
  'xml',
]);

/**
 * Formats a column's data type for use in `CREATE TABLE`, e.g.
 * `varchar(50)`, `nvarchar(max)`, `decimal(18,2)`, `datetime2(7)`.
 */
export function formatColumnDataType(column: MssqlColumn): string {
  const type = column.dataType.toLowerCase();

  if (!BUILT_IN_TYPES.has(type)) {
    // A user-defined alias/CLR type: emit the identifier verbatim and
    // quoted. Lowercasing it (correct for a built-in keyword) would break
    // resolution under a case-sensitive collation, and its length/precision
    // is part of the type definition rather than the column declaration.
    return quoteIdentifier(column.dataType);
  }

  if (CHARACTER_TYPES.has(type)) {
    const isUnicode = type.startsWith('n');
    const length = isUnicode
      ? (column.characterMaxLength ?? (column.maxLength !== null ? column.maxLength / 2 : null))
      : (column.characterMaxLength ?? column.maxLength);
    if (length === -1) {
      return `${type}(max)`;
    }
    if (length !== null && length !== undefined) {
      return `${type}(${length})`;
    }
    return type;
  }

  if (PRECISION_SCALE_TYPES.has(type) && column.precision !== null && column.scale !== null) {
    return `${type}(${column.precision},${column.scale})`;
  }

  if (SCALE_ONLY_TYPES.has(type) && column.scale !== null) {
    return `${type}(${column.scale})`;
  }

  return type;
}

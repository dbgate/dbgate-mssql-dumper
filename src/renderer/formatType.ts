import type { MssqlColumn } from '../model/column.js';

const CHARACTER_TYPES = new Set(['char', 'varchar', 'nchar', 'nvarchar', 'binary', 'varbinary']);
const PRECISION_SCALE_TYPES = new Set(['decimal', 'numeric']);
const PRECISION_ONLY_TYPES = new Set(['datetime2', 'datetimeoffset', 'time']);

/**
 * Formats a column's data type for use in `CREATE TABLE`, e.g.
 * `varchar(50)`, `nvarchar(max)`, `decimal(18,2)`, `datetime2(7)`.
 */
export function formatColumnDataType(column: MssqlColumn): string {
  const type = column.dataType.toLowerCase();

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

  if (PRECISION_ONLY_TYPES.has(type) && column.precision !== null) {
    return `${type}(${column.precision})`;
  }

  return type;
}

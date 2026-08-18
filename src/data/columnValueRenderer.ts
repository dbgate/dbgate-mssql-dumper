import type { MssqlColumnValue } from '../connection/types.js';
import type { MssqlColumn } from '../model/column.js';
import type { MssqlDiagnostic } from '../model/diagnostics.js';
import {
  formatApproximateNumber,
  formatFiniteNumber,
  quoteBinaryLiteral,
  quoteDateTimeLiteral,
  quoteHighPrecisionDateTimeLiteral,
  quoteStringLiteral,
  quoteUnicodeStringLiteral,
  renderSqlLiteral,
} from '../security/literals.js';
import type { SqlLiteralValue } from '../security/literals.js';

const INTEGER_TYPES = new Set(['tinyint', 'smallint', 'int', 'bigint']);
const EXACT_DECIMAL_TYPES = new Set(['decimal', 'numeric', 'money', 'smallmoney']);
const APPROXIMATE_NUMERIC_TYPES = new Set(['float', 'real']);
const NON_UNICODE_CHARACTER_TYPES = new Set(['char', 'varchar', 'text']);
const UNICODE_CHARACTER_TYPES = new Set(['nchar', 'nvarchar', 'ntext']);
const BINARY_TYPES = new Set(['binary', 'varbinary', 'image']);

/** Never explicitly insertable: SQL Server generates and maintains these values itself. */
const GENERATED_TYPES = new Set(['timestamp', 'rowversion']);

/**
 * Types this exporter does not attempt to serialize generically. Excluded
 * from `INSERT` entirely (with a diagnostic) rather than risking a
 * corrupted or misleading literal — `sql_variant`'s runtime type is not
 * known without an extra query per value, and `xml`/`geography`/
 * `geometry`/`hierarchyid` all need type-specific constructor syntax
 * (`geography::STGeomFromText(...)`, etc.) this package does not generate.
 */
const UNSUPPORTED_TYPES = new Set(['sql_variant', 'xml', 'geography', 'geometry', 'hierarchyid']);

export type ColumnExportClassification = 'insertable' | 'computed' | 'generated' | 'unsupported';

/**
 * Decides whether a column's data should be part of `INSERT` output at all.
 * Computed columns are never insertable (SQL Server derives their value);
 * `rowversion`/`timestamp` columns are server-generated and rejected by
 * `INSERT` if a value is supplied explicitly; unsupported types are
 * excluded defensively rather than risking a corrupted literal.
 */
export function classifyColumnForExport(column: MssqlColumn): ColumnExportClassification {
  if (column.isComputed) {
    return 'computed';
  }
  const type = column.dataType.toLowerCase();
  if (GENERATED_TYPES.has(type)) {
    return 'generated';
  }
  if (UNSUPPORTED_TYPES.has(type)) {
    return 'unsupported';
  }
  return 'insertable';
}

/**
 * Structured, one-time-per-column diagnostics for known driver/type
 * limitations — reported instead of silently exporting a value that may
 * not round-trip exactly. Returns `[]` when nothing applies.
 */
export function columnExportDiagnostics(
  column: MssqlColumn,
  schemaName: string,
  pureName: string,
): MssqlDiagnostic[] {
  const diagnostics: MssqlDiagnostic[] = [];
  const type = column.dataType.toLowerCase();
  const objectReference = {
    kind: 'column' as const,
    schemaName,
    name: column.columnName,
    parentName: pureName,
  };

  const classification = classifyColumnForExport(column);

  if (classification === 'unsupported') {
    diagnostics.push({
      severity: 'warning',
      code: 'unsupported-column-type',
      message: `Column "${schemaName}"."${pureName}"."${column.columnName}" has type "${column.dataType}", which this exporter does not support; its data was not exported`,
      objectReference,
    });
  }

  if (classification !== 'insertable') {
    // The remaining diagnostics describe how a value would be *carried
    // through* an INSERT. A computed, generated or excluded column's data is
    // never exported at all, so warning about its round-trip fidelity would
    // be pure noise — a computed `decimal(22,5)` column cannot lose precision
    // it is never asked to reproduce.
    return diagnostics;
  }

  if ((type === 'decimal' || type === 'numeric') && (column.precision ?? 0) > 15) {
    diagnostics.push({
      severity: 'warning',
      code: 'possible-precision-loss',
      message: `Column "${schemaName}"."${pureName}"."${column.columnName}" is ${type}(${column.precision},${column.scale ?? 0}); a driver that reads it back as a JS number (an IEEE 754 double, ~15-17 significant digits) cannot represent every value at this precision exactly`,
      objectReference,
    });
  }

  if (type === 'money' || type === 'smallmoney') {
    // `money` carries 19 digits of precision and `smallmoney` 10, both at a
    // fixed scale of 4, and Tedious reads them by dividing an integer by
    // 10000 in floating point — so a `money` value always risks rounding.
    // Worth its own notice because the failure mode is harsher than for
    // `decimal`: `money`'s maximum, 922337203685477.5807, rounds *up* to
    // 922337203685477.6 as a double, which is outside the type's range, so
    // the generated INSERT fails with an overflow instead of storing an
    // approximation.
    diagnostics.push({
      severity: 'warning',
      code: 'possible-precision-loss',
      message: `Column "${schemaName}"."${pureName}"."${column.columnName}" is ${type}; the Tedious value parser reads it as a JS number (an IEEE 754 double) by dividing by 10000, so values needing more than ~15 significant digits are rounded — and a value at the very edge of ${type}'s range may round outside it and fail to restore`,
      objectReference,
    });
  }

  if (type === 'datetimeoffset') {
    diagnostics.push({
      severity: 'warning',
      code: 'datetimeoffset-normalized-to-utc',
      message: `Column "${schemaName}"."${pureName}"."${column.columnName}" is datetimeoffset; the Tedious adapter's value parser discards the original UTC offset and always returns the value normalized to UTC (+00:00) — the point in time is preserved, but the source row's original display offset is not`,
      objectReference,
    });
  }

  return diagnostics;
}

/** A numeric-looking string: safe to emit as a bare literal without any risk of breaking statement syntax. */
const SAFE_NUMERIC_TEXT = /^-?\d+(\.\d+)?$/;

/**
 * Renders one column's value using the target SQL Server type to choose
 * unicode vs. non-unicode string quoting, exact vs. approximate numeric
 * formatting, and date/time precision — rather than guessing from the JS
 * runtime type alone, as the generic {@link renderSqlLiteral} must.
 * Callers are expected to have already excluded columns classified as
 * `'computed'`/`'generated'`/`'unsupported'` via
 * {@link classifyColumnForExport}; this function does not check that
 * itself; it always renders *some* literal for a supported type, falling
 * back to {@link renderSqlLiteral} for any input shape it does not
 * specifically recognize, so a classification gap degrades gracefully
 * instead of throwing mid-export.
 */
export function renderColumnValue(value: MssqlColumnValue, column: MssqlColumn): string {
  if (value === null) {
    return 'NULL';
  }
  const type = column.dataType.toLowerCase();

  if (type === 'bit') {
    return value ? '1' : '0';
  }

  if (
    INTEGER_TYPES.has(type) ||
    EXACT_DECIMAL_TYPES.has(type) ||
    APPROXIMATE_NUMERIC_TYPES.has(type)
  ) {
    // A driver-supplied numeric *string* is emitted verbatim and unquoted:
    // it is the only representation that carries more precision than an IEEE
    // 754 double without this package reintroducing loss of its own. This is
    // not hypothetical — Tedious's value parser returns every `bigint`
    // column as a decimal string (`readBigInt` calls `.toString()` on the
    // 64-bit value precisely to avoid a lossy JS number), so without this
    // branch a `bigint` would fall through to the generic literal renderer
    // and be emitted as a quoted `N'...'` string. Validated against
    // SAFE_NUMERIC_TEXT first so unexpected text can never break statement
    // syntax; anything else is quoted defensively.
    if (typeof value === 'string') {
      return SAFE_NUMERIC_TEXT.test(value) ? value : quoteStringLiteral(value);
    }
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number') {
      // `float`/`real` are approximate numerics: T-SQL accepts exponential
      // notation for them, and near the edges of the double range it is the
      // only valid form — expanding 1.7976931348623157e+308 into 309 plain
      // digits yields a literal SQL Server parses as `decimal` (maximum
      // precision 38) and rejects with an overflow error.
      return APPROXIMATE_NUMERIC_TYPES.has(type)
        ? formatApproximateNumber(value)
        : formatFiniteNumber(value);
    }
  }

  if (NON_UNICODE_CHARACTER_TYPES.has(type) && typeof value === 'string') {
    return quoteStringLiteral(value);
  }

  if (UNICODE_CHARACTER_TYPES.has(type) && typeof value === 'string') {
    return quoteUnicodeStringLiteral(value);
  }

  if (BINARY_TYPES.has(type) && (Buffer.isBuffer(value) || value instanceof Uint8Array)) {
    return quoteBinaryLiteral(value);
  }

  if (type === 'uniqueidentifier' && typeof value === 'string') {
    return quoteStringLiteral(value);
  }

  if (type === 'date' && value instanceof Date) {
    return quoteStringLiteral(value.toISOString().slice(0, 10));
  }

  if ((type === 'datetime' || type === 'smalldatetime') && value instanceof Date) {
    return quoteDateTimeLiteral(value);
  }

  if ((type === 'datetime2' || type === 'time') && value instanceof Date) {
    return quoteHighPrecisionDateTimeLiteral(value);
  }

  if (type === 'datetimeoffset' && value instanceof Date) {
    return quoteHighPrecisionDateTimeLiteral(value, { appendUtcOffset: true });
  }

  return renderSqlLiteral(value as SqlLiteralValue);
}

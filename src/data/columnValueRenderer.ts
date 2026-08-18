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
/**
 * Every character type — Unicode or not — is rendered with the `N'...'` prefix.
 *
 * An un-prefixed literal is typed as `varchar` in the **restoring database's
 * default collation**, and characters outside that code page are replaced with
 * `?` at parse time, before the value is ever assigned to the target column.
 * Verified against SQL Server: under `SQL_Latin1_General_CP1_CI_AS`,
 * `'Привет 日本語'` stores as `?????? ???`, while `N'Привет 日本語'` survives —
 * because an `nvarchar` literal is converted using the *assignment target's*
 * collation instead. A `varchar` column with a Cyrillic/Greek/UTF-8 collation
 * therefore loses its data through the un-prefixed form.
 *
 * `N'...'` is always accepted for a non-Unicode target (SQL Server converts it
 * implicitly), so there is no downside: anything the source column could hold,
 * the target column can still hold.
 */
const CHARACTER_TYPES = new Set(['char', 'varchar', 'text', 'nchar', 'nvarchar', 'ntext']);
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

  // `smallmoney` is deliberately excluded: its full range (±214748.3647) is 10
  // significant digits, so the int32/10000 division Tedious performs is always
  // exactly representable as a double and the value round-trips bit-exactly.
  // Warning about it would be a guaranteed false positive.
  if (type === 'money') {
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
      message: `Column "${schemaName}"."${pureName}"."${column.columnName}" is money; the Tedious value parser reads it as a JS number (an IEEE 754 double) by dividing by 10000, so values needing more than ~15 significant digits are rounded — and a value at the very edge of money's range may round outside it and fail to restore`,
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
const SAFE_NUMERIC_TEXT = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;

/**
 * Expands scientific notation without passing through a JS number. Exact SQL
 * numerics must not be routed through `float` merely because a client returned
 * their text in exponent form: doing so can lose significant digits before
 * SQL Server converts the value to the target decimal/bigint column.
 */
function formatExactNumericText(value: string, match: RegExpExecArray): string {
  const exponentText = match[5];
  if (exponentText === undefined) {
    return value;
  }

  const exponent = Number(exponentText);
  // SQL Server exact numerics top out at precision 38. This generous bound is
  // only a memory-safety guard against a malicious exponent with millions of
  // digits; an out-of-range but reasonably sized literal is left for SQL
  // Server to reject with its normal overflow error.
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1_000) {
    throw new Error(`Cannot render exact numeric text with exponent ${exponentText}`);
  }

  const sign = match[1] === '-' ? '-' : '';
  const integer = match[2] ?? '0';
  const fraction = match[2] === undefined ? (match[4] ?? '') : (match[3] ?? '');
  const digits = integer + fraction;
  const point = integer.length + exponent;

  if (point <= 0) {
    return `${sign}0.${'0'.repeat(-point)}${digits}`;
  }
  if (point >= digits.length) {
    return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  }
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

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
      const match = SAFE_NUMERIC_TEXT.exec(value);
      if (!match) return quoteStringLiteral(value);
      return APPROXIMATE_NUMERIC_TYPES.has(type) ? value : formatExactNumericText(value, match);
    }
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number') {
      // `float`/`real` are approximate numerics: T-SQL accepts exponential
      // notation for them, and near the edges of the double range it is the
      // only valid form — expanding 1.7976931348623157e+308 into 309 plain
      // digits yields a literal SQL Server parses as `decimal` (maximum
      // precision 38) and rejects with an overflow error.
      if (APPROXIMATE_NUMERIC_TYPES.has(type)) {
        return formatApproximateNumber(value);
      }
      const expanded = formatFiniteNumber(value);
      // Clamp to the column's declared scale. At scale >= 23 the driver's
      // `value / 10^scale` division yields a double whose shortest round-trip
      // form expands to more fractional digits than `decimal` permits at all
      // (up to 53 at scale 37), producing a literal outside the exact-numeric
      // grammar this expansion exists to satisfy. A dot in `expanded` implies a
      // magnitude below 1e21, where `toFixed` is well defined.
      const dot = expanded.indexOf('.');
      const scale = column.scale;
      if (dot >= 0 && scale !== null && scale >= 0 && expanded.length - dot - 1 > scale) {
        return value.toFixed(Math.min(scale, 38));
      }
      return expanded;
    }
  }

  if (CHARACTER_TYPES.has(type) && typeof value === 'string') {
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

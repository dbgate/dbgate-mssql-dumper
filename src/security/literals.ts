/** Escapes and single-quotes an ordinary (non-Unicode) string literal. */
export function quoteStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Escapes and single-quotes a Unicode (`N'...'`) string literal, for `nchar`/`nvarchar` targets. */
export function quoteUnicodeStringLiteral(value: string): string {
  return `N'${value.replace(/'/g, "''")}'`;
}

/** Renders a `Buffer` as a T-SQL binary literal, e.g. `0xDEADBEEF`. */
export function quoteBinaryLiteral(value: Buffer | Uint8Array): string {
  return `0x${Buffer.from(value).toString('hex')}`;
}

/**
 * Renders a `Date` as an ISO-8601 string literal (`'2024-01-02T03:04:05.6789012'`).
 * SQL Server parses the `T`-separated ISO-8601 form unambiguously regardless
 * of `LANGUAGE`/`DATEFORMAT` session settings, so no explicit `CONVERT`
 * style code is required. Callers targeting `datetime`/`smalldatetime`
 * columns should be aware those types round fractional seconds.
 */
export function quoteDateTimeLiteral(value: Date): string {
  return quoteStringLiteral(value.toISOString());
}

/**
 * Renders a finite JS number as a plain decimal string for an **exact**
 * numeric target (`int`/`bigint`/`decimal`/`numeric`/`money`/`smallmoney`),
 * never exponential notation. `String(value)` switches to exponential
 * notation for magnitudes `>= 1e21` or `< 1e-6`, and T-SQL's exact-numeric
 * literal grammar does not accept that form.
 *
 * Do **not** use this for `float`/`real` — see
 * {@link formatApproximateNumber}. Expanding a value near the edges of the
 * double range (`1.7976931348623157e+308`) would produce a 309-digit plain
 * literal, which SQL Server parses as `decimal` — whose maximum precision is
 * 38 — and rejects outright.
 */
export function formatFiniteNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Cannot render non-finite number as a SQL literal: ${value}`);
  }
  const text = String(value);
  const exponentIndex = text.indexOf('e');
  if (exponentIndex === -1) {
    return text;
  }

  const mantissa = text.slice(0, exponentIndex);
  const exponent = Number(text.slice(exponentIndex + 1));
  const negative = mantissa.startsWith('-');
  const unsignedMantissa = negative ? mantissa.slice(1) : mantissa;
  const dotIndex = unsignedMantissa.indexOf('.');
  const intPart = dotIndex === -1 ? unsignedMantissa : unsignedMantissa.slice(0, dotIndex);
  const fracPart = dotIndex === -1 ? '' : unsignedMantissa.slice(dotIndex + 1);
  const digits = intPart + fracPart;
  const pointIndex = intPart.length + exponent;

  let expanded: string;
  if (pointIndex <= 0) {
    expanded = `0.${'0'.repeat(-pointIndex)}${digits}`;
  } else if (pointIndex >= digits.length) {
    expanded = `${digits}${'0'.repeat(pointIndex - digits.length)}`;
  } else {
    expanded = `${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`;
  }
  return negative ? `-${expanded}` : expanded;
}

/**
 * Renders a finite JS number for an **approximate** numeric target
 * (`float`/`real`) as JS's own shortest round-trip representation, keeping
 * exponential notation when `String()` produces it. T-SQL's
 * approximate-numeric literal grammar accepts exponential notation, and at
 * the edges of the double range it is the only valid form (see
 * {@link formatFiniteNumber}). Every representation this produces converts
 * back to the identical double, so no precision is lost either way.
 */
export function formatApproximateNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Cannot render non-finite number as a SQL literal: ${value}`);
  }
  return String(value);
}

/**
 * A `Date` read by the Tedious adapter for a `time`/`datetime2`/
 * `datetimeoffset` column carries a non-enumerable `nanosecondsDelta`
 * property: the fractional-second remainder beyond JS `Date`'s millisecond
 * precision (tedious itself reads up to 100ns ticks off the wire). Absent
 * for values from any other source.
 */
export interface DateWithNanosecondsDelta extends Date {
  readonly nanosecondsDelta?: number;
}

function readNanosecondsDelta(value: Date): number | undefined {
  const delta = (value as DateWithNanosecondsDelta).nanosecondsDelta;
  return typeof delta === 'number' && Number.isFinite(delta) ? delta : undefined;
}

/**
 * Renders a `time`/`datetime2`/`datetimeoffset` value at up to 7 fractional
 * digits, recovering sub-millisecond precision from `nanosecondsDelta` when
 * present instead of silently truncating to JS `Date`'s native millisecond
 * precision. `appendUtcOffset` appends a literal `+00:00`: the Tedious
 * adapter's value parser always normalizes `datetimeoffset` to UTC (SQL
 * Server's own wire format carries the original offset, but tedious's
 * reader discards it — see `docs/architecture.md`), so an explicit `+00:00`
 * documents that the value is that UTC instant, not a claim about the
 * source row's original display offset.
 */
export function quoteHighPrecisionDateTimeLiteral(
  value: Date,
  options?: { readonly appendUtcOffset?: boolean },
): string {
  const iso = value.toISOString();
  let text = iso.slice(0, -1); // strip the trailing 'Z'; re-added (or replaced by an offset) below if needed

  const nanosecondsDelta = readNanosecondsDelta(value);
  if (nanosecondsDelta !== undefined && nanosecondsDelta > 0) {
    const extraTicks = Math.min(9999, Math.max(0, Math.round(nanosecondsDelta * 1e7)));
    text += String(extraTicks).padStart(4, '0');
  }
  if (options?.appendUtcOffset) {
    text += '+00:00';
  }
  return quoteStringLiteral(text);
}

export type SqlLiteralValue =
  string | number | bigint | boolean | Buffer | Uint8Array | Date | null;

/**
 * Renders one scalar value as a T-SQL literal. Strings are rendered with the
 * Unicode (`N'...'`) prefix, which is always valid (SQL Server implicitly
 * converts it for non-Unicode target columns) and safe for non-ASCII data
 * regardless of the database code page.
 */
export function renderSqlLiteral(value: SqlLiteralValue): string {
  if (value === null) {
    return 'NULL';
  }
  if (typeof value === 'string') {
    return quoteUnicodeStringLiteral(value);
  }
  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number') {
    // Type-unaware fallback. Plain-digit expansion is what an exact numeric
    // target needs, but a magnitude at or beyond 1e21 would expand past
    // `decimal`'s 38-digit maximum precision and be rejected — and a number
    // that large (or a non-integer that small) can only have come from an
    // approximate `float`/`real` value anyway, where exponential notation is
    // the correct literal form. Choose per value rather than guessing a type.
    return Number.isInteger(value) && Math.abs(value) < 1e21
      ? formatFiniteNumber(value)
      : formatApproximateNumber(value);
  }
  if (value instanceof Date) {
    return quoteDateTimeLiteral(value);
  }
  return quoteBinaryLiteral(value);
}

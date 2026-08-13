import { describe, expect, it } from 'vitest';
import {
  formatFiniteNumber,
  isSafeUnquotedIdentifier,
  quoteHighPrecisionDateTimeLiteral,
  quoteIdentifier,
  quoteQualifiedIdentifier,
  quoteStringLiteral,
  quoteUnicodeStringLiteral,
  renderSqlLiteral,
} from '../src/security/index.js';

describe('identifier quoting', () => {
  it('leaves safe identifiers unquoted by default', () => {
    expect(quoteIdentifier('dbo')).toBe('dbo');
    expect(quoteIdentifier('CustomerOrders')).toBe('CustomerOrders');
  });

  it('quotes reserved keywords', () => {
    expect(isSafeUnquotedIdentifier('select')).toBe(false);
    expect(quoteIdentifier('select')).toBe('[select]');
    expect(quoteIdentifier('Table')).toBe('[Table]');
  });

  it('quotes identifiers with special characters and escapes embedded brackets', () => {
    expect(quoteIdentifier('my column')).toBe('[my column]');
    expect(quoteIdentifier('weird]name')).toBe('[weird]]name]');
  });

  it('always quotes when policy is always-quote', () => {
    expect(quoteIdentifier('dbo', 'always-quote')).toBe('[dbo]');
  });

  it('quotes and joins qualified identifiers', () => {
    expect(quoteQualifiedIdentifier(['dbo', 'Orders'])).toBe('dbo.Orders');
    expect(quoteQualifiedIdentifier(['dbo', 'my table'])).toBe('dbo.[my table]');
  });

  it('quotes Unicode identifier names unquoted when they are otherwise safe', () => {
    // Non-ASCII letters do not match the plain-ASCII regular-identifier grammar this package
    // treats as "safe unquoted", so they are always bracket-quoted rather than risk a collation-
    // dependent guess about which Unicode letters SQL Server itself would accept unquoted.
    expect(quoteIdentifier('Zürich')).toBe('[Zürich]');
    expect(quoteIdentifier('北京')).toBe('[北京]');
    expect(quoteIdentifier('Ördér Lïné')).toBe('[Ördér Lïné]');
  });

  it('handles an identifier that is only brackets', () => {
    expect(quoteIdentifier(']]')).toBe('[]]]]]');
  });

  it('handles an empty identifier', () => {
    expect(quoteIdentifier('')).toBe('[]');
  });
});

describe('formatFiniteNumber', () => {
  it('renders ordinary numbers unchanged', () => {
    expect(formatFiniteNumber(42)).toBe('42');
    expect(formatFiniteNumber(-3.14)).toBe('-3.14');
    expect(formatFiniteNumber(0)).toBe('0');
  });

  it('expands large-magnitude exponential notation to plain digits', () => {
    expect(formatFiniteNumber(1e21)).toBe('1000000000000000000000');
    expect(formatFiniteNumber(1.5e21)).toBe('1500000000000000000000');
    expect(formatFiniteNumber(-2e21)).toBe('-2000000000000000000000');
  });

  it('expands small-magnitude exponential notation to plain digits', () => {
    expect(formatFiniteNumber(1e-7)).toBe('0.0000001');
    expect(formatFiniteNumber(1.5e-10)).toBe('0.00000000015');
  });

  it('rejects non-finite numbers', () => {
    expect(() => formatFiniteNumber(Number.NaN)).toThrow();
    expect(() => formatFiniteNumber(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe('quoteHighPrecisionDateTimeLiteral', () => {
  it('renders a plain Date (no nanosecondsDelta) at millisecond precision', () => {
    const date = new Date('2024-01-02T03:04:05.123Z');
    expect(quoteHighPrecisionDateTimeLiteral(date)).toBe("'2024-01-02T03:04:05.123'");
  });

  it('recovers sub-millisecond precision from a nanosecondsDelta property', () => {
    const date = new Date('2024-01-02T03:04:05.123Z');
    Object.defineProperty(date, 'nanosecondsDelta', { value: 0.0004567, enumerable: false });
    expect(quoteHighPrecisionDateTimeLiteral(date)).toBe("'2024-01-02T03:04:05.1234567'");
  });

  it('appends an explicit +00:00 offset when asked to, for datetimeoffset values', () => {
    const date = new Date('2024-01-02T03:04:05.000Z');
    expect(quoteHighPrecisionDateTimeLiteral(date, { appendUtcOffset: true })).toBe(
      "'2024-01-02T03:04:05.000+00:00'",
    );
  });
});

describe('string and scalar literals', () => {
  it('escapes single quotes in ordinary and unicode literals', () => {
    expect(quoteStringLiteral("O'Brien")).toBe("'O''Brien'");
    expect(quoteUnicodeStringLiteral("O'Brien")).toBe("N'O''Brien'");
  });

  it('renders scalars deterministically', () => {
    expect(renderSqlLiteral(null)).toBe('NULL');
    expect(renderSqlLiteral(true)).toBe('1');
    expect(renderSqlLiteral(false)).toBe('0');
    expect(renderSqlLiteral(42)).toBe('42');
    expect(renderSqlLiteral(3.14)).toBe('3.14');
    expect(renderSqlLiteral(10n)).toBe('10');
    expect(renderSqlLiteral('hello')).toBe("N'hello'");
  });

  it('renders binary literals as hex', () => {
    expect(renderSqlLiteral(Buffer.from([0xde, 0xad, 0xbe, 0xef]))).toBe('0xdeadbeef');
  });

  it('renders dates as ISO-8601 string literals', () => {
    const date = new Date('2024-01-02T03:04:05.000Z');
    expect(renderSqlLiteral(date)).toBe(`'${date.toISOString()}'`);
  });

  it('rejects non-finite numbers', () => {
    expect(() => renderSqlLiteral(Number.POSITIVE_INFINITY)).toThrow();
  });
});

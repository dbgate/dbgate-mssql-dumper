import { describe, expect, it } from 'vitest';
import {
  classifyColumnForExport,
  columnExportDiagnostics,
  renderColumnValue,
} from '../src/data/columnValueRenderer.js';
import type { MssqlColumn } from '../src/model/column.js';

function column(
  overrides: Partial<MssqlColumn> & { columnName: string; dataType: string },
): MssqlColumn {
  return {
    ordinalPosition: 1,
    maxLength: null,
    characterMaxLength: null,
    precision: null,
    scale: null,
    isNullable: true,
    isIdentity: false,
    identitySeed: null,
    identityIncrement: null,
    isComputed: false,
    computedExpression: null,
    isPersisted: null,
    isSparse: false,
    isRowGuidCol: false,
    collationName: null,
    defaultConstraintName: null,
    defaultExpression: null,
    comment: null,
    ...overrides,
  };
}

describe('classifyColumnForExport', () => {
  it('classifies a computed column as computed, regardless of its underlying type', () => {
    const col = column({
      columnName: 'Total',
      dataType: 'int',
      isComputed: true,
      computedExpression: '[Qty]*[Price]',
    });
    expect(classifyColumnForExport(col)).toBe('computed');
  });

  it('classifies rowversion/timestamp as generated', () => {
    expect(classifyColumnForExport(column({ columnName: 'RowVer', dataType: 'rowversion' }))).toBe(
      'generated',
    );
    expect(classifyColumnForExport(column({ columnName: 'Ts', dataType: 'timestamp' }))).toBe(
      'generated',
    );
  });

  it('classifies sql_variant/xml/geography/geometry/hierarchyid as unsupported', () => {
    for (const dataType of ['sql_variant', 'xml', 'geography', 'geometry', 'hierarchyid']) {
      expect(classifyColumnForExport(column({ columnName: 'X', dataType }))).toBe('unsupported');
    }
  });

  it('classifies ordinary types as insertable', () => {
    for (const dataType of ['int', 'nvarchar', 'decimal', 'datetime2', 'uniqueidentifier']) {
      expect(classifyColumnForExport(column({ columnName: 'X', dataType }))).toBe('insertable');
    }
  });
});

describe('columnExportDiagnostics', () => {
  it('warns once for an unsupported type', () => {
    const diagnostics = columnExportDiagnostics(
      column({ columnName: 'Doc', dataType: 'xml' }),
      'dbo',
      'T',
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ severity: 'warning', code: 'unsupported-column-type' });
  });

  it('warns about possible precision loss for high-precision decimal columns', () => {
    const diagnostics = columnExportDiagnostics(
      column({ columnName: 'Amount', dataType: 'decimal', precision: 38, scale: 10 }),
      'dbo',
      'T',
    );
    expect(diagnostics.some(d => d.code === 'possible-precision-loss')).toBe(true);
  });

  it('does not warn about precision for a decimal column within safe JS-number range', () => {
    const diagnostics = columnExportDiagnostics(
      column({ columnName: 'Amount', dataType: 'decimal', precision: 10, scale: 2 }),
      'dbo',
      'T',
    );
    expect(diagnostics.some(d => d.code === 'possible-precision-loss')).toBe(false);
  });

  it('warns that datetimeoffset is normalized to UTC by the Tedious adapter', () => {
    const diagnostics = columnExportDiagnostics(
      column({ columnName: 'At', dataType: 'datetimeoffset' }),
      'dbo',
      'T',
    );
    expect(diagnostics.some(d => d.code === 'datetimeoffset-normalized-to-utc')).toBe(true);
  });

  it('produces no diagnostics for an ordinary supported column', () => {
    expect(
      columnExportDiagnostics(column({ columnName: 'Name', dataType: 'nvarchar' }), 'dbo', 'T'),
    ).toEqual([]);
  });
});

describe('renderColumnValue', () => {
  it('renders NULL for any type', () => {
    expect(renderColumnValue(null, column({ columnName: 'X', dataType: 'int' }))).toBe('NULL');
    expect(renderColumnValue(null, column({ columnName: 'X', dataType: 'nvarchar' }))).toBe('NULL');
  });

  it('renders bit from a boolean', () => {
    const col = column({ columnName: 'Active', dataType: 'bit' });
    expect(renderColumnValue(true, col)).toBe('1');
    expect(renderColumnValue(false, col)).toBe('0');
  });

  it('renders integer family types without decimals or exponential notation', () => {
    const col = column({ columnName: 'X', dataType: 'int' });
    expect(renderColumnValue(42, col)).toBe('42');
    expect(renderColumnValue(-7, col)).toBe('-7');
    const bigintCol = column({ columnName: 'X', dataType: 'bigint' });
    expect(renderColumnValue(9007199254740993n, bigintCol)).toBe('9007199254740993');
  });

  it('renders decimal/numeric without precision loss for a driver-supplied numeric string', () => {
    const col = column({ columnName: 'Amount', dataType: 'decimal', precision: 38, scale: 10 });
    const huge = '123456789012345678901234567890.1234567890';
    expect(renderColumnValue(huge, col)).toBe(huge);
  });

  it('quotes a decimal string that is not safe numeric text, rather than emitting it bare', () => {
    const col = column({ columnName: 'Amount', dataType: 'decimal' });
    expect(renderColumnValue('1;DROP TABLE T', col)).toBe("'1;DROP TABLE T'");
  });

  it('renders decimal/numeric from a JS number without exponential notation', () => {
    const col = column({ columnName: 'Amount', dataType: 'decimal', precision: 30, scale: 0 });
    expect(renderColumnValue(1e21, col)).toBe('1000000000000000000000');
  });

  it('renders float/real from a JS number', () => {
    const col = column({ columnName: 'X', dataType: 'float' });
    expect(renderColumnValue(3.14159, col)).toBe('3.14159');
  });

  it('renders char/varchar/text with plain (non-unicode) quoting', () => {
    const col = column({ columnName: 'Code', dataType: 'varchar' });
    expect(renderColumnValue('AB-123', col)).toBe("'AB-123'");
  });

  it("renders nchar/nvarchar/ntext with Unicode N'...' quoting", () => {
    const col = column({ columnName: 'Name', dataType: 'nvarchar' });
    expect(renderColumnValue('Zürich café 北京', col)).toBe("N'Zürich café 北京'");
  });

  it('escapes an embedded single quote in both quoting styles', () => {
    expect(renderColumnValue("O'Brien", column({ columnName: 'X', dataType: 'varchar' }))).toBe(
      "'O''Brien'",
    );
    expect(renderColumnValue("O'Brien", column({ columnName: 'X', dataType: 'nvarchar' }))).toBe(
      "N'O''Brien'",
    );
  });

  it('preserves embedded CR/LF in string values', () => {
    const value = 'line one\r\nline two';
    expect(renderColumnValue(value, column({ columnName: 'X', dataType: 'nvarchar' }))).toBe(
      `N'${value}'`,
    );
  });

  it('renders binary/varbinary/image as 0x hex', () => {
    const col = column({ columnName: 'Data', dataType: 'varbinary' });
    expect(renderColumnValue(Buffer.from([0x00, 0xff, 0xab]), col)).toBe('0x00ffab');
  });

  it('renders uniqueidentifier as a quoted GUID string', () => {
    const col = column({ columnName: 'Id', dataType: 'uniqueidentifier' });
    expect(renderColumnValue('6F9619FF-8B86-D011-B42D-00C04FC964FF', col)).toBe(
      "'6F9619FF-8B86-D011-B42D-00C04FC964FF'",
    );
  });

  it('renders date using only the date portion', () => {
    const col = column({ columnName: 'D', dataType: 'date' });
    expect(renderColumnValue(new Date('2024-06-15T23:59:59.000Z'), col)).toBe("'2024-06-15'");
  });

  it('renders datetime/smalldatetime as an ISO literal', () => {
    const date = new Date('2024-01-02T03:04:05.000Z');
    expect(renderColumnValue(date, column({ columnName: 'X', dataType: 'datetime' }))).toBe(
      `'${date.toISOString()}'`,
    );
    expect(renderColumnValue(date, column({ columnName: 'X', dataType: 'smalldatetime' }))).toBe(
      `'${date.toISOString()}'`,
    );
  });

  it('renders datetime2/time recovering sub-millisecond precision from nanosecondsDelta', () => {
    const date = new Date('2024-01-02T03:04:05.123Z');
    Object.defineProperty(date, 'nanosecondsDelta', { value: 0.0004567, enumerable: false });
    const col = column({ columnName: 'X', dataType: 'datetime2', scale: 7 });
    expect(renderColumnValue(date, col)).toBe("'2024-01-02T03:04:05.1234567'");
  });

  it('renders datetimeoffset with an explicit +00:00 offset', () => {
    const date = new Date('2024-01-02T03:04:05.000Z');
    const col = column({ columnName: 'X', dataType: 'datetimeoffset' });
    expect(renderColumnValue(date, col)).toBe("'2024-01-02T03:04:05.000+00:00'");
  });

  it('falls back to the generic literal renderer for an unrecognized value/type combination', () => {
    // A string value for a column typed as `int` (should not happen with a well-behaved driver,
    // but must degrade gracefully rather than throw or corrupt the output).
    const col = column({ columnName: 'X', dataType: 'int' });
    expect(() => renderColumnValue('42', col)).not.toThrow();
  });
});

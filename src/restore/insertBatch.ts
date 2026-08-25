import type {
  MssqlBulkColumn,
  MssqlBulkInsertRequest,
  MssqlColumnValue,
  MssqlConnection,
  MssqlRow,
} from '../connection/types.js';

type ParsedLiteral =
  | { readonly kind: 'null'; readonly value: null }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'binary'; readonly value: Buffer }
  | { readonly kind: 'number'; readonly value: string };

interface TableReference {
  readonly schemaName: string;
  readonly tableName: string;
}

interface ParsedInsert {
  readonly kind: 'insert';
  /** Exact source statement, retained for a correctness-preserving SQL fallback. */
  readonly sql: string;
  readonly table: TableReference;
  readonly columnNames: readonly string[];
  readonly rows: readonly (readonly ParsedLiteral[])[];
}

interface ParsedSqlOperation {
  readonly kind: 'sql';
  readonly sql: string;
  readonly table: TableReference;
  readonly enabled: boolean;
}

type ParsedOperation = ParsedInsert | ParsedSqlOperation;

export type PreparedInsertBatchOperation =
  | {
      readonly kind: 'sql';
      readonly sql: string;
      readonly schemaName?: string;
      readonly tableName?: string;
    }
  | { readonly kind: 'bulk'; readonly request: MssqlBulkInsertRequest };

const NUMBER_PATTERN = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const BARE_IDENTIFIER_PATTERN = /[A-Za-z_#@][A-Za-z0-9_#$@]*/y;

class CanonicalInsertParser {
  private position = 0;

  constructor(private readonly sql: string) {}

  parse(): readonly ParsedOperation[] | null {
    const operations: ParsedOperation[] = [];
    let inserts = 0;
    this.skipWhitespace();
    while (!this.atEnd()) {
      const start = this.position;
      if (this.consumeKeyword('SET')) {
        if (!this.consumeKeyword('IDENTITY_INSERT')) return null;
        const table = this.parseTableReference();
        if (!table) return null;
        let enabled: boolean;
        if (this.consumeKeyword('ON')) enabled = true;
        else if (this.consumeKeyword('OFF')) enabled = false;
        else return null;
        if (!this.consumeCharacter(';')) return null;
        operations.push({
          kind: 'sql',
          sql: this.sql.slice(start, this.position).trim(),
          table,
          enabled,
        });
      } else if (this.consumeKeyword('INSERT')) {
        if (!this.consumeKeyword('INTO')) return null;
        const table = this.parseTableReference();
        if (!table || !this.consumeCharacter('(')) return null;
        const columnNames = this.parseIdentifierList();
        if (!columnNames || !this.consumeCharacter(')') || !this.consumeKeyword('VALUES')) {
          return null;
        }
        const rows = this.parseRows(columnNames.length);
        if (!rows) return null;
        operations.push({
          kind: 'insert',
          sql: this.sql.slice(start, this.position).trim(),
          table,
          columnNames,
          rows,
        });
        inserts++;
      } else {
        return null;
      }
      this.skipWhitespace();
    }
    return inserts > 0 ? operations : null;
  }

  private parseRows(columnCount: number): readonly (readonly ParsedLiteral[])[] | null {
    const rows: ParsedLiteral[][] = [];
    for (;;) {
      if (!this.consumeCharacter('(')) return null;
      const row: ParsedLiteral[] = [];
      for (let index = 0; index < columnCount; index++) {
        const literal = this.parseLiteral();
        if (!literal) return null;
        row.push(literal);
        if (index + 1 < columnCount && !this.consumeCharacter(',')) return null;
      }
      if (!this.consumeCharacter(')')) return null;
      rows.push(row);
      this.skipWhitespace();
      if (this.sql[this.position] === ',') {
        this.position++;
        continue;
      }
      if (!this.consumeCharacter(';')) return null;
      return rows;
    }
  }

  private parseLiteral(): ParsedLiteral | null {
    this.skipWhitespace();
    const start = this.position;

    if (this.consumeKeyword('NULL')) return { kind: 'null', value: null };

    let unicode = false;
    if (
      (this.sql[this.position] === 'N' || this.sql[this.position] === 'n') &&
      this.sql[this.position + 1] === "'"
    ) {
      unicode = true;
      this.position++;
    }
    if (this.sql[this.position] === "'") {
      this.position++;
      let segmentStart = this.position;
      const segments: string[] = [];
      while (this.position < this.sql.length) {
        if (this.sql[this.position] !== "'") {
          this.position++;
          continue;
        }
        if (this.sql[this.position + 1] === "'") {
          segments.push(this.sql.slice(segmentStart, this.position), "'");
          this.position += 2;
          segmentStart = this.position;
          continue;
        }
        segments.push(this.sql.slice(segmentStart, this.position));
        this.position++;
        return { kind: 'string', value: segments.join('') };
      }
      return null;
    }
    if (unicode) return null;

    if (this.sql.slice(this.position, this.position + 2).toLowerCase() === '0x') {
      this.position += 2;
      const hexStart = this.position;
      while (/[0-9A-Fa-f]/.test(this.sql[this.position] ?? '')) this.position++;
      const hex = this.sql.slice(hexStart, this.position);
      if (hex.length % 2 !== 0) return null;
      return { kind: 'binary', value: Buffer.from(hex, 'hex') };
    }

    NUMBER_PATTERN.lastIndex = start;
    const match = NUMBER_PATTERN.exec(this.sql);
    if (!match) return null;
    this.position = NUMBER_PATTERN.lastIndex;
    return { kind: 'number', value: match[0] };
  }

  private parseIdentifierList(): string[] | null {
    const identifiers: string[] = [];
    for (;;) {
      const identifier = this.parseIdentifier();
      if (identifier === null) return null;
      identifiers.push(identifier);
      this.skipWhitespace();
      if (this.sql[this.position] !== ',') return identifiers;
      this.position++;
    }
  }

  private parseTableReference(): TableReference | null {
    const schemaName = this.parseIdentifier();
    if (schemaName === null || !this.consumeCharacter('.')) return null;
    const tableName = this.parseIdentifier();
    return tableName === null ? null : { schemaName, tableName };
  }

  private parseIdentifier(): string | null {
    this.skipWhitespace();
    if (this.sql[this.position] === '[') {
      this.position++;
      const pieces: string[] = [];
      let segmentStart = this.position;
      while (this.position < this.sql.length) {
        if (this.sql[this.position] !== ']') {
          this.position++;
          continue;
        }
        if (this.sql[this.position + 1] === ']') {
          pieces.push(this.sql.slice(segmentStart, this.position), ']');
          this.position += 2;
          segmentStart = this.position;
          continue;
        }
        pieces.push(this.sql.slice(segmentStart, this.position));
        this.position++;
        return pieces.join('');
      }
      return null;
    }
    BARE_IDENTIFIER_PATTERN.lastIndex = this.position;
    const match = BARE_IDENTIFIER_PATTERN.exec(this.sql);
    if (!match) return null;
    this.position = BARE_IDENTIFIER_PATTERN.lastIndex;
    return match[0];
  }

  private consumeKeyword(keyword: string): boolean {
    this.skipWhitespace();
    if (this.sql.slice(this.position, this.position + keyword.length).toUpperCase() !== keyword) {
      return false;
    }
    const next = this.sql[this.position + keyword.length];
    if (next && /[A-Za-z0-9_#$@]/.test(next)) return false;
    this.position += keyword.length;
    this.skipWhitespace();
    return true;
  }

  private consumeCharacter(character: string): boolean {
    this.skipWhitespace();
    if (this.sql[this.position] !== character) return false;
    this.position++;
    this.skipWhitespace();
    return true;
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.sql[this.position] ?? '')) this.position++;
  }

  private atEnd(): boolean {
    return this.position >= this.sql.length;
  }
}

interface MetadataRow extends MssqlRow {
  readonly columnName: string;
  readonly dataType: string;
  readonly maxLength: number;
  readonly precision: number;
  readonly scale: number;
  readonly isNullable: number;
  readonly isIdentity: number;
}

const TABLE_COLUMN_METADATA_SQL = `select
  c.name as columnName,
  type_name(c.system_type_id) as dataType,
  c.max_length as maxLength,
  c.precision as precision,
  c.scale as scale,
  convert(int, c.is_nullable) as isNullable,
  convert(int, c.is_identity) as isIdentity
from sys.columns c
where c.object_id = object_id(quotename(@schemaName) + N'.' + quotename(@tableName))
order by c.column_id`;

// Tedious sends execSqlBatch text as UTF-16 over TDS. Keep fallback requests
// comfortably below the multi-megabyte GO batches produced by the dumper,
// while preserving each original INSERT statement as an atomic unit.
const SQL_FALLBACK_CHUNK_CHARACTERS = 256 * 1024;

function createSqlFallbackOperations(
  parsed: readonly ParsedOperation[],
): readonly PreparedInsertBatchOperation[] {
  const result: PreparedInsertBatchOperation[] = [];
  let chunk = '';
  let chunkTable: TableReference | null = null;

  const flush = (): void => {
    if (!chunk || !chunkTable) return;
    result.push({
      kind: 'sql',
      sql: chunk,
      schemaName: chunkTable.schemaName,
      tableName: chunkTable.tableName,
    });
    chunk = '';
    chunkTable = null;
  };

  for (const operation of parsed) {
    const statement = operation.sql;
    const candidate = chunk ? `${chunk}\n${statement}` : statement;
    const sameTable =
      chunkTable?.schemaName === operation.table.schemaName &&
      chunkTable.tableName === operation.table.tableName;
    if (chunk && (!sameTable || candidate.length > SQL_FALLBACK_CHUNK_CHARACTERS)) {
      flush();
      chunk = statement;
      chunkTable = operation.table;
    } else {
      chunk = candidate;
      chunkTable = operation.table;
    }
  }
  flush();
  return result;
}

export class InsertBatchPreparer {
  private readonly metadata = new Map<string, Promise<readonly MetadataRow[]>>();

  constructor(private readonly connection: MssqlConnection) {}

  async prepare(
    sql: string,
    signal?: AbortSignal,
  ): Promise<readonly PreparedInsertBatchOperation[] | null> {
    if (!this.connection.bulkInsert) return null;
    const parsed = new CanonicalInsertParser(sql).parse();
    if (!parsed) return null;

    const sqlFallback = (): readonly PreparedInsertBatchOperation[] =>
      createSqlFallbackOperations(parsed);

    const prepared: PreparedInsertBatchOperation[] = [];
    for (const operation of parsed) {
      if (operation.kind === 'sql') {
        prepared.push({
          kind: 'sql',
          sql: operation.sql,
          schemaName: operation.table.schemaName,
          tableName: operation.table.tableName,
        });
        continue;
      }
      const tableMetadata = await this.loadMetadata(operation.table, signal);
      const columns = this.matchColumns(operation.columnNames, tableMetadata);
      if (!columns) return sqlFallback();
      const rows: MssqlColumnValue[][] = [];
      for (const parsedRow of operation.rows) {
        const row: MssqlColumnValue[] = [];
        for (let index = 0; index < columns.length; index++) {
          const value = convertLiteral(parsedRow[index]!, columns[index]!);
          if (value === UNSUPPORTED) return sqlFallback();
          row.push(value);
        }
        rows.push(row);
      }

      const previous = prepared[prepared.length - 1];
      if (previous?.kind === 'bulk' && sameBulkTarget(previous.request, operation.table, columns)) {
        prepared[prepared.length - 1] = {
          kind: 'bulk',
          request: { ...previous.request, rows: [...previous.request.rows, ...rows] },
        };
      } else {
        prepared.push({
          kind: 'bulk',
          request: {
            schemaName: operation.table.schemaName,
            tableName: operation.table.tableName,
            columns,
            rows,
          },
        });
      }
    }
    return prepared;
  }

  private loadMetadata(
    table: TableReference,
    signal?: AbortSignal,
  ): Promise<readonly MetadataRow[]> {
    const key = `${table.schemaName}.${table.tableName}`.toLowerCase();
    let pending = this.metadata.get(key);
    if (!pending) {
      pending = this.connection
        .query<MetadataRow>(
          {
            sql: TABLE_COLUMN_METADATA_SQL,
            parameters: [
              { name: 'schemaName', value: table.schemaName, sqlType: 'NVarChar' },
              { name: 'tableName', value: table.tableName, sqlType: 'NVarChar' },
            ],
          },
          signal,
        )
        .then(result => result.rows);
      this.metadata.set(key, pending);
    }
    return pending;
  }

  private matchColumns(
    columnNames: readonly string[],
    metadata: readonly MetadataRow[],
  ): readonly MssqlBulkColumn[] | null {
    const byName = new Map(metadata.map(column => [column.columnName.toLowerCase(), column]));
    const result: MssqlBulkColumn[] = [];
    for (const name of columnNames) {
      const column = byName.get(name.toLowerCase());
      // Tedious builds INSERT BULK column declarations by surrounding the
      // supplied name with brackets, but does not escape a closing bracket.
      if (!column || column.columnName.includes(']')) return null;
      result.push({
        name: column.columnName,
        dataType: column.dataType,
        maxLength: Number(column.maxLength),
        precision: Number(column.precision),
        scale: Number(column.scale),
        nullable: Boolean(column.isNullable),
        ...(column.isIdentity ? { identity: true } : {}),
      });
    }
    return result;
  }
}

const UNSUPPORTED = Symbol('unsupported');

function convertLiteral(
  literal: ParsedLiteral,
  column: MssqlBulkColumn,
): MssqlColumnValue | typeof UNSUPPORTED {
  if (literal.kind === 'null') return null;
  const type = column.dataType.toLowerCase();

  if (['char', 'varchar', 'text'].includes(type)) {
    if (literal.kind !== 'string') return UNSUPPORTED;
    // Tedious bulk-load encodes non-Unicode strings using the connection's
    // collation, which may differ from a UTF-8 collation on this column.
    return Array.from(literal.value).every(character => character.charCodeAt(0) <= 0x7f)
      ? literal.value
      : UNSUPPORTED;
  }
  if (['nchar', 'nvarchar', 'ntext'].includes(type)) {
    return literal.kind === 'string' ? literal.value : UNSUPPORTED;
  }
  if (['binary', 'varbinary', 'image'].includes(type)) {
    return literal.kind === 'binary' ? literal.value : UNSUPPORTED;
  }
  if (type === 'uniqueidentifier') {
    return literal.kind === 'string' ? literal.value : UNSUPPORTED;
  }
  if (type === 'bit') {
    return literal.kind === 'number' && (literal.value === '0' || literal.value === '1')
      ? literal.value === '1'
      : UNSUPPORTED;
  }
  if (['tinyint', 'smallint', 'int'].includes(type)) {
    if (literal.kind !== 'number' || !/^[+-]?\d+$/.test(literal.value)) return UNSUPPORTED;
    const value = Number(literal.value);
    return Number.isSafeInteger(value) ? value : UNSUPPORTED;
  }
  if (type === 'bigint') {
    if (literal.kind !== 'number' || !/^[+-]?\d+$/.test(literal.value)) return UNSUPPORTED;
    try {
      return BigInt(literal.value);
    } catch {
      return UNSUPPORTED;
    }
  }
  if (type === 'decimal' || type === 'numeric') {
    if (literal.kind !== 'number') return UNSUPPORTED;
    const value = Number(literal.value);
    if (!Number.isFinite(value)) return UNSUPPORTED;
    // Tedious currently writes only the low 64 bits of bulk decimal values,
    // including decimal(20..38). Reject values whose scaled integer does not
    // fit so the original SQL text retains the existing restore semantics.
    const scaled = Math.round(Math.abs(value * 10 ** column.scale));
    return Number.isFinite(scaled) && scaled < 2 ** 64 ? value : UNSUPPORTED;
  }
  if (['money', 'smallmoney', 'float', 'real'].includes(type)) {
    if (literal.kind !== 'number') return UNSUPPORTED;
    const value = Number(literal.value);
    return Number.isFinite(value) ? value : UNSUPPORTED;
  }
  if (['date', 'datetime', 'smalldatetime', 'datetime2', 'datetimeoffset', 'time'].includes(type)) {
    if (literal.kind !== 'string') return UNSUPPORTED;
    return parseDateValue(literal.value, type);
  }
  return UNSUPPORTED;
}

function parseDateValue(text: string, type: string): Date | typeof UNSUPPORTED {
  let iso = text;
  if (type === 'date') iso = `${text}T00:00:00.000Z`;
  else if (type !== 'datetimeoffset' && !/[zZ]|[+-]\d\d:\d\d$/.test(text)) iso = `${text}Z`;
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return UNSUPPORTED;

  // Tedious validates bulk date values with local-time getters even when it
  // later serializes them as UTC. Near SQL Server's year limits, a timezone
  // shift can therefore turn a valid UTC value into year 0 or 10000. Let the
  // original SQL batch handle those rare values instead of risking a failed
  // bulk load.
  const localYear = value.getFullYear();
  if (localYear < 1 || localYear > 9999) return UNSUPPORTED;

  const fraction = /\.(\d{4,7})/.exec(text)?.[1];
  if (fraction) {
    const extraTicks = Number(fraction.slice(3).padEnd(4, '0'));
    const delta = extraTicks / 10_000_000;
    // Tedious's encoder reads the singular property; its decoder has exposed
    // the plural spelling in released versions. Keeping both makes the value
    // round-trip through either side without losing the final four 100ns
    // digits beyond JavaScript Date's millisecond precision.
    Object.defineProperties(value, {
      nanosecondDelta: { value: delta, enumerable: false },
      nanosecondsDelta: { value: delta, enumerable: false },
    });
  }
  return value;
}

function sameBulkTarget(
  request: MssqlBulkInsertRequest,
  table: TableReference,
  columns: readonly MssqlBulkColumn[],
): boolean {
  return (
    request.schemaName.toLowerCase() === table.schemaName.toLowerCase() &&
    request.tableName.toLowerCase() === table.tableName.toLowerCase() &&
    request.columns.length === columns.length &&
    request.columns.every(
      (column, index) => column.name.toLowerCase() === columns[index]!.name.toLowerCase(),
    )
  );
}

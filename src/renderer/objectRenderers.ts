import type {
  MssqlCheckConstraint,
  MssqlDefaultConstraint,
  MssqlForeignKey,
  MssqlPrimaryKey,
  MssqlUniqueConstraint,
} from '../model/constraint.js';
import type { MssqlIndex } from '../model/indexes.js';
import type { MssqlRoutine } from '../model/routine.js';
import type { MssqlSequence } from '../model/sequence.js';
import type { MssqlTable } from '../model/table.js';
import type { MssqlTrigger } from '../model/trigger.js';
import type { MssqlView } from '../model/view.js';
import { quoteIdentifier, quoteQualifiedIdentifier } from '../security/identifiers.js';
import { quoteUnicodeStringLiteral } from '../security/literals.js';
import { formatColumnDataType } from './formatType.js';
import type { ResolvedPlainSqlRenderOptions } from './types.js';

function qi(name: string, options: ResolvedPlainSqlRenderOptions): string {
  return quoteIdentifier(name, options.quoteAllIdentifiers ? 'always-quote' : 'quote-when-needed');
}

function qq(parts: readonly string[], options: ResolvedPlainSqlRenderOptions): string {
  return quoteQualifiedIdentifier(
    parts,
    options.quoteAllIdentifiers ? 'always-quote' : 'quote-when-needed',
  );
}

/**
 * Builds the `SET ANSI_NULLS`/`SET QUOTED_IDENTIFIER` preamble a module
 * (view/procedure/function/trigger) needs recreated ahead of it, from the
 * session settings SQL Server itself recorded when the module was created
 * (`sys.sql_modules.uses_ansi_nulls`/`uses_quoted_identifier`). A `null`
 * flag (no `sys.sql_modules` row was found — see `MssqlModuleMetadata`)
 * defaults to `ON`, matching every supported SQL Server version's own
 * default and SSMS's own generated scripts, rather than silently omitting
 * a setting the object may actually depend on.
 */
function moduleSessionSettingsPreamble(flags: {
  readonly usesAnsiNulls: boolean | null;
  readonly usesQuotedIdentifier: boolean | null;
}): string {
  const ansiNulls = flags.usesAnsiNulls ?? true;
  const quotedIdentifier = flags.usesQuotedIdentifier ?? true;
  return `SET ANSI_NULLS ${ansiNulls ? 'ON' : 'OFF'};\nGO\nSET QUOTED_IDENTIFIER ${quotedIdentifier ? 'ON' : 'OFF'};\nGO\n`;
}

export function renderSchemaCreate(
  schemaName: string,
  options: ResolvedPlainSqlRenderOptions,
): string {
  const literal = quoteUnicodeStringLiteral(schemaName);
  const ident = qi(schemaName, options);
  return `IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = ${literal})\nBEGIN\n${options.indentation}EXEC('CREATE SCHEMA ${ident}');\nEND;`;
}

export function renderSchemaDrop(
  schemaName: string,
  options: ResolvedPlainSqlRenderOptions,
): string {
  return `DROP SCHEMA IF EXISTS ${qi(schemaName, options)};`;
}

export function renderTableCreate(
  table: MssqlTable,
  options: ResolvedPlainSqlRenderOptions,
): string {
  const columns = table.columns
    .slice()
    .sort((a, b) => a.ordinalPosition - b.ordinalPosition)
    .map(column => {
      const parts = [options.indentation, qi(column.columnName, options), ' '];
      if (column.isComputed && column.computedExpression) {
        parts.push(`AS (${column.computedExpression})`);
        if (column.isPersisted) {
          parts.push(' PERSISTED');
        }
      } else {
        parts.push(formatColumnDataType(column));
        if (column.isIdentity) {
          parts.push(` IDENTITY(${column.identitySeed ?? 1},${column.identityIncrement ?? 1})`);
        }
        parts.push(column.isNullable ? ' NULL' : ' NOT NULL');
        if (column.defaultExpression) {
          parts.push(` DEFAULT ${column.defaultExpression}`);
        }
      }
      return parts.join('');
    });

  const tableName = qq([table.schemaName, table.pureName], options);
  return `CREATE TABLE ${tableName} (\n${columns.join(',\n')}\n);`;
}

export function renderTableDrop(table: MssqlTable, options: ResolvedPlainSqlRenderOptions): string {
  return `DROP TABLE IF EXISTS ${qq([table.schemaName, table.pureName], options)};`;
}

function renderKeyColumns(
  columns: readonly { columnName: string; ordinalPosition: number; isDescending: boolean }[],
  options: ResolvedPlainSqlRenderOptions,
): string {
  return columns
    .slice()
    .sort((a, b) => a.ordinalPosition - b.ordinalPosition)
    .map(col => `${qi(col.columnName, options)} ${col.isDescending ? 'DESC' : 'ASC'}`)
    .join(', ');
}

export function renderPrimaryKeyCreate(
  pk: MssqlPrimaryKey,
  options: ResolvedPlainSqlRenderOptions,
): string {
  const tableName = qq([pk.schemaName, pk.pureName], options);
  const clustering = pk.isClustered ? 'CLUSTERED' : 'NONCLUSTERED';
  return `ALTER TABLE ${tableName} ADD CONSTRAINT ${qi(pk.constraintName, options)} PRIMARY KEY ${clustering} (${renderKeyColumns(pk.columns, options)});`;
}

export function renderUniqueConstraintCreate(
  uq: MssqlUniqueConstraint,
  options: ResolvedPlainSqlRenderOptions,
): string {
  const tableName = qq([uq.schemaName, uq.pureName], options);
  const clustering = uq.isClustered ? 'CLUSTERED' : 'NONCLUSTERED';
  return `ALTER TABLE ${tableName} ADD CONSTRAINT ${qi(uq.constraintName, options)} UNIQUE ${clustering} (${renderKeyColumns(uq.columns, options)});`;
}

export function renderDefaultConstraintCreate(
  def: MssqlDefaultConstraint,
  options: ResolvedPlainSqlRenderOptions,
): string {
  const tableName = qq([def.schemaName, def.pureName], options);
  return `ALTER TABLE ${tableName} ADD CONSTRAINT ${qi(def.constraintName, options)} DEFAULT ${def.definition} FOR ${qi(def.columnName, options)};`;
}

export function renderCheckConstraintCreate(
  check: MssqlCheckConstraint,
  options: ResolvedPlainSqlRenderOptions,
): string {
  const tableName = qq([check.schemaName, check.pureName], options);
  const withClause = check.isNotTrusted ? 'WITH NOCHECK ' : '';
  return `ALTER TABLE ${tableName} ${withClause}ADD CONSTRAINT ${qi(check.constraintName, options)} CHECK ${check.definition};`;
}

const FOREIGN_KEY_ACTION_SQL: Record<MssqlForeignKey['updateAction'], string> = {
  'NO ACTION': 'NO ACTION',
  CASCADE: 'CASCADE',
  'SET NULL': 'SET NULL',
  'SET DEFAULT': 'SET DEFAULT',
};

export function renderForeignKeyCreate(
  fk: MssqlForeignKey,
  options: ResolvedPlainSqlRenderOptions,
): string {
  const tableName = qq([fk.schemaName, fk.pureName], options);
  const refTableName = qq([fk.refSchemaName, fk.refTableName], options);
  const sortedColumns = fk.columns.slice().sort((a, b) => a.ordinalPosition - b.ordinalPosition);
  const localColumns = sortedColumns.map(c => qi(c.columnName, options)).join(', ');
  const refColumns = sortedColumns.map(c => qi(c.refColumnName, options)).join(', ');
  const withClause = fk.isNotTrusted ? 'WITH NOCHECK ' : '';
  return (
    `ALTER TABLE ${tableName} ${withClause}ADD CONSTRAINT ${qi(fk.constraintName, options)} ` +
    `FOREIGN KEY (${localColumns}) REFERENCES ${refTableName} (${refColumns}) ` +
    `ON UPDATE ${FOREIGN_KEY_ACTION_SQL[fk.updateAction]} ON DELETE ${FOREIGN_KEY_ACTION_SQL[fk.deleteAction]};`
  );
}

const SUPPORTED_INDEX_TYPES = new Set(['CLUSTERED', 'NONCLUSTERED']);

/** Returns `null` when the index type cannot be expressed by this renderer yet (e.g. columnstore/XML/spatial). */
export function renderIndexCreate(
  index: MssqlIndex,
  options: ResolvedPlainSqlRenderOptions,
): string | null {
  if (!SUPPORTED_INDEX_TYPES.has(index.indexType)) {
    return null;
  }
  const tableName = qq([index.schemaName, index.pureName], options);
  const unique = index.isUnique ? 'UNIQUE ' : '';
  const keyColumns = index.columns.filter(c => !c.isIncluded);
  const includedColumns = index.columns.filter(c => c.isIncluded);
  const keyList = renderKeyColumns(keyColumns, options);
  const includeClause =
    includedColumns.length > 0
      ? ` INCLUDE (${includedColumns
          .slice()
          .sort((a, b) => a.ordinalPosition - b.ordinalPosition)
          .map(c => qi(c.columnName, options))
          .join(', ')})`
      : '';
  const whereClause = index.filterDefinition ? ` WHERE ${index.filterDefinition}` : '';
  return `CREATE ${unique}${index.indexType} INDEX ${qi(index.indexName, options)} ON ${tableName} (${keyList})${includeClause}${whereClause};`;
}

export function renderIndexDrop(index: MssqlIndex, options: ResolvedPlainSqlRenderOptions): string {
  const tableName = qq([index.schemaName, index.pureName], options);
  return `DROP INDEX IF EXISTS ${qi(index.indexName, options)} ON ${tableName};`;
}

export function renderConstraintDrop(
  schemaName: string,
  pureName: string,
  constraintName: string,
  options: ResolvedPlainSqlRenderOptions,
): string {
  const tableName = qq([schemaName, pureName], options);
  return `ALTER TABLE ${tableName} DROP CONSTRAINT IF EXISTS ${qi(constraintName, options)};`;
}

export function renderViewCreate(view: MssqlView, _options: ResolvedPlainSqlRenderOptions): string {
  if (!view.definition) {
    throw new Error(`View "${view.schemaName}"."${view.pureName}" has no stored definition`);
  }
  return `${moduleSessionSettingsPreamble(view)}${view.definition.trim()};`;
}

export function renderViewDrop(view: MssqlView, options: ResolvedPlainSqlRenderOptions): string {
  return `DROP VIEW IF EXISTS ${qq([view.schemaName, view.pureName], options)};`;
}

export function renderRoutineCreate(
  routine: MssqlRoutine,
  _options: ResolvedPlainSqlRenderOptions,
): string {
  if (!routine.definition) {
    throw new Error(
      `Routine "${routine.schemaName}"."${routine.pureName}" has no stored definition`,
    );
  }
  return `${moduleSessionSettingsPreamble(routine)}${routine.definition.trim()};`;
}

export function renderRoutineDrop(
  routine: MssqlRoutine,
  options: ResolvedPlainSqlRenderOptions,
): string {
  const keyword = routine.kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION';
  return `DROP ${keyword} IF EXISTS ${qq([routine.schemaName, routine.pureName], options)};`;
}

export function renderTriggerCreate(
  trigger: MssqlTrigger,
  _options: ResolvedPlainSqlRenderOptions,
): string {
  if (!trigger.definition) {
    throw new Error(
      `Trigger "${trigger.schemaName}"."${trigger.triggerName}" has no stored definition`,
    );
  }
  return `${moduleSessionSettingsPreamble(trigger)}${trigger.definition.trim()};`;
}

export function renderTriggerDrop(
  trigger: MssqlTrigger,
  options: ResolvedPlainSqlRenderOptions,
): string {
  return `DROP TRIGGER IF EXISTS ${qq([trigger.schemaName, trigger.triggerName], options)};`;
}

export function renderSequenceCreate(
  sequence: MssqlSequence,
  options: ResolvedPlainSqlRenderOptions,
): string {
  const name = qq([sequence.schemaName, sequence.pureName], options);
  const parts = [`CREATE SEQUENCE ${name} AS ${sequence.dataType}`];
  if (sequence.startValue !== null) parts.push(`START WITH ${sequence.startValue}`);
  if (sequence.increment !== null) parts.push(`INCREMENT BY ${sequence.increment}`);
  if (sequence.minValue !== null) parts.push(`MINVALUE ${sequence.minValue}`);
  if (sequence.maxValue !== null) parts.push(`MAXVALUE ${sequence.maxValue}`);
  parts.push(sequence.isCycling ? 'CYCLE' : 'NO CYCLE');
  return `${parts.join('\n' + options.indentation)};`;
}

export function renderSequenceDrop(
  sequence: MssqlSequence,
  options: ResolvedPlainSqlRenderOptions,
): string {
  return `DROP SEQUENCE IF EXISTS ${qq([sequence.schemaName, sequence.pureName], options)};`;
}

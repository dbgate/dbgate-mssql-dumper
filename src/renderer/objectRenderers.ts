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
function moduleSessionSettingsPreamble(flags: ModuleSessionFlags): string {
  const ansiNulls = flags.usesAnsiNulls ?? true;
  const quotedIdentifier = flags.usesQuotedIdentifier ?? true;
  return `SET ANSI_NULLS ${ansiNulls ? 'ON' : 'OFF'};\nGO\nSET QUOTED_IDENTIFIER ${quotedIdentifier ? 'ON' : 'OFF'};\nGO\n`;
}

interface ModuleSessionFlags {
  readonly usesAnsiNulls: boolean | null;
  readonly usesQuotedIdentifier: boolean | null;
}

/**
 * Restores `ANSI_NULLS`/`QUOTED_IDENTIFIER` to `ON` after a module that needed
 * either of them `OFF`.
 *
 * `SET` options are **session**-scoped, not batch-scoped, so the preamble above
 * keeps applying to everything that follows it in the restore. Two things break
 * without this reset:
 *
 * 1. `CREATE INDEX` for a filtered index, an indexed view, or an index on a
 *    computed column *requires* both options `ON` and is rejected outright
 *    ("CREATE INDEX failed because the following SET options have incorrect
 *    settings"). Functions sort before indexes within post-data, so a single
 *    `ANSI_NULLS OFF` function is enough to make the dump unrestorable.
 * 2. Whatever session the caller restored through is left with the options
 *    changed, silently altering NULL-comparison semantics for their later work.
 *
 * `ON` is SQL Server's own default and what every other object here expects, so
 * resetting to it — rather than to whatever the session had before — is the
 * correct target. Emitted only when something was actually turned off, so the
 * common all-`ON` case is unchanged.
 */
function moduleSessionSettingsPostamble(flags: ModuleSessionFlags): string {
  const ansiNulls = flags.usesAnsiNulls ?? true;
  const quotedIdentifier = flags.usesQuotedIdentifier ?? true;
  if (ansiNulls && quotedIdentifier) {
    return '';
  }
  const resets: string[] = [];
  if (!ansiNulls) resets.push('SET ANSI_NULLS ON;');
  if (!quotedIdentifier) resets.push('SET QUOTED_IDENTIFIER ON;');
  return `\nGO\n${resets.join('\nGO\n')}`;
}

/**
 * Matches a leading `ALTER <module-kind>` header, tolerating leading whitespace
 * and comments before it.
 */
const LEADING_ALTER_HEADER =
  /^((?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*)ALTER(\s+(?:PROC|PROCEDURE|VIEW|FUNCTION|TRIGGER)\b)/i;

/**
 * Rewrites a module definition's leading `ALTER` to `CREATE`.
 *
 * `sys.sql_modules.definition` stores the text of the **last** statement that
 * defined the module — which is `ALTER …` for any object modified after
 * creation (SSMS's "Modify" generates `ALTER`, and so does essentially every
 * migration script). Emitting that verbatim produces a dump that cannot be
 * restored into an empty database: `ALTER PROCEDURE dbo.P` fails with "Could
 * not find object 'dbo.P'", and because `stopOnError` defaults to true the
 * whole restore stops there, silently skipping every remaining batch.
 *
 * `CREATE OR ALTER …` is deliberately left alone — it is already restorable in
 * both directions.
 */
function normalizeModuleHeaderToCreate(definition: string): string {
  return definition.replace(LEADING_ALTER_HEADER, (_match, prefix: string, kind: string) => {
    return `${prefix}CREATE${kind}`;
  });
}

/** Wraps a module's verbatim definition in its recorded SET options, then restores them. */
function renderModuleWithSessionSettings(flags: ModuleSessionFlags, definition: string): string {
  const body = normalizeModuleHeaderToCreate(definition.trim());
  return `${moduleSessionSettingsPreamble(flags)}${body}${moduleSessionSettingsPostamble(flags)}`;
}

export function renderSchemaCreate(
  schemaName: string,
  options: ResolvedPlainSqlRenderOptions,
): string {
  const literal = quoteUnicodeStringLiteral(schemaName);
  const ident = qi(schemaName, options);
  // `CREATE SCHEMA` may not be the non-first statement of a conditional
  // block, so it has to run through `EXEC` of a string — which means the
  // bracket-quoted identifier ends up *nested inside a string literal* and
  // needs the literal layer of escaping too. Bracket quoting alone doubles
  // `]`, not `'`, so a schema named `O'Brien` would otherwise terminate the
  // EXEC argument early (and a hostile name could append statements to it).
  const execArgument = quoteUnicodeStringLiteral(`CREATE SCHEMA ${ident}`);
  return `IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = ${literal})\nBEGIN\n${options.indentation}EXEC(${execArgument});\nEND;`;
}

/**
 * Schemas SQL Server creates in every database and refuses to drop. `dbo` is
 * the one that matters in practice: it is a perfectly ordinary target for user
 * objects (so it *is* part of the archive), but `DROP SCHEMA dbo` fails
 * outright with "Cannot drop the schema 'dbo'".
 */
const UNDROPPABLE_SCHEMAS = new Set(['dbo', 'sys', 'INFORMATION_SCHEMA', 'guest']);

/** Returns `null` for a schema that cannot be dropped, so nothing is emitted for it. */
export function renderSchemaDrop(
  schemaName: string,
  options: ResolvedPlainSqlRenderOptions,
): string | null {
  if (UNDROPPABLE_SCHEMAS.has(schemaName)) {
    return null;
  }
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
          parts.push(` IDENTITY(${column.identitySeed ?? 1n},${column.identityIncrement ?? 1n})`);
        }
        parts.push(column.isNullable ? ' NULL' : ' NOT NULL');
        // No inline `DEFAULT` here on purpose. Every default constraint —
        // named or auto-named — is its own archive entry rendered as
        // `ALTER TABLE ... ADD CONSTRAINT <name> DEFAULT ... FOR <column>`,
        // which is what preserves the original constraint name. Emitting it
        // inline as well would give the column two defaults and fail the
        // restore with "There is already a DEFAULT constraint on column".
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
  return `ALTER TABLE ${tableName} ${withClause}ADD CONSTRAINT ${qi(check.constraintName, options)} CHECK ${check.definition};${constraintDisableStatement(check, options)}`;
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
    `ON UPDATE ${FOREIGN_KEY_ACTION_SQL[fk.updateAction]} ON DELETE ${FOREIGN_KEY_ACTION_SQL[fk.deleteAction]};` +
    constraintDisableStatement(fk, options)
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
  const create = `CREATE ${unique}${index.indexType} INDEX ${qi(index.indexName, options)} ON ${tableName} (${keyList})${includeClause}${whereClause};`;
  // A disabled index keeps its definition but is neither maintained nor usable
  // by the optimizer. Recreating it enabled silently changes behaviour — the
  // target starts paying the write cost and the optimizer starts choosing it —
  // so the disabled state has to be reproduced explicitly. Safe in the same
  // batch as the CREATE.
  if (index.isDisabled) {
    return `${create}\nALTER INDEX ${qi(index.indexName, options)} ON ${tableName} DISABLE;`;
  }
  return create;
}

/**
 * Reproduces a constraint's *disabled* state.
 *
 * `WITH NOCHECK` on the `ADD CONSTRAINT` only makes a constraint **untrusted**
 * (existing rows were not validated); the constraint is still enforced for new
 * DML. A constraint the source had disabled must additionally be turned off, or
 * the restored database starts enforcing a rule the source deliberately was
 * not — writes that succeed against the source would fail against the copy.
 */
function constraintDisableStatement(
  constraint: { schemaName: string; pureName: string; constraintName: string; isDisabled: boolean },
  options: ResolvedPlainSqlRenderOptions,
): string {
  if (!constraint.isDisabled) {
    return '';
  }
  const tableName = qq([constraint.schemaName, constraint.pureName], options);
  return `\nALTER TABLE ${tableName} NOCHECK CONSTRAINT ${qi(constraint.constraintName, options)};`;
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
  return renderModuleWithSessionSettings(view, view.definition);
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
  return renderModuleWithSessionSettings(routine, routine.definition);
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
  options: ResolvedPlainSqlRenderOptions,
): string {
  if (!trigger.definition) {
    throw new Error(
      `Trigger "${trigger.schemaName}"."${trigger.triggerName}" has no stored definition`,
    );
  }
  const create = renderModuleWithSessionSettings(trigger, trigger.definition);
  if (!trigger.isDisabled) {
    return create;
  }
  // A disabled trigger restored enabled fires on every later DML the source
  // deliberately left untouched — writing audit rows the source never writes,
  // or failing the write outright if the trigger raises. `CREATE TRIGGER` must
  // be alone in its batch, so the disable goes in a batch of its own.
  const triggerName = qi(trigger.triggerName, options);
  const parent = qq([trigger.schemaName, trigger.parentName], options);
  return `${create}\nGO\nDISABLE TRIGGER ${triggerName} ON ${parent};`;
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
  // All three caching states must be emitted explicitly, or a restored
  // sequence silently changes behaviour. `cacheSize` alone is not enough:
  // SQL Server reports it as NULL both for `NO CACHE` and for `CACHE` at the
  // server default size, which is why `isCached` is read alongside it.
  if (!sequence.isCached) {
    parts.push('NO CACHE');
  } else if (sequence.cacheSize === null) {
    parts.push('CACHE');
  } else {
    parts.push(`CACHE ${sequence.cacheSize}`);
  }
  return `${parts.join('\n' + options.indentation)};`;
}

export function renderSequenceDrop(
  sequence: MssqlSequence,
  options: ResolvedPlainSqlRenderOptions,
): string {
  return `DROP SEQUENCE IF EXISTS ${qq([sequence.schemaName, sequence.pureName], options)};`;
}

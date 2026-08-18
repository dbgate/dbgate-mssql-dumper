import type { ArchiveEntry } from '../archive/types.js';
import {
  renderCheckConstraintCreate,
  renderConstraintDrop,
  renderDefaultConstraintCreate,
  renderForeignKeyCreate,
  renderIndexCreate,
  renderIndexDrop,
  renderPrimaryKeyCreate,
  renderRoutineCreate,
  renderRoutineDrop,
  renderSchemaCreate,
  renderSchemaDrop,
  renderSequenceCreate,
  renderSequenceDrop,
  renderTableCreate,
  renderTableDrop,
  renderTriggerCreate,
  renderTriggerDrop,
  renderUniqueConstraintCreate,
  renderViewCreate,
  renderViewDrop,
} from './objectRenderers.js';
import { indexKey } from './lookups.js';
import type { RenderLookups } from './lookups.js';
import type { ResolvedPlainSqlRenderOptions } from './types.js';

function requireLookup<T>(map: ReadonlyMap<string, T>, entryKey: string, description: string): T {
  const value = map.get(entryKey);
  if (!value) {
    throw new Error(
      `Archive entry references ${description} "${entryKey}", which was not found in the introspected model`,
    );
  }
  return value;
}

/** Renders the `CREATE`/`ALTER ... ADD` statement for one archive entry, or `null` if unsupported. */
export function renderEntryCreate(
  entry: ArchiveEntry,
  lookups: RenderLookups,
  options: ResolvedPlainSqlRenderOptions,
): string | null {
  const parentKey = `${entry.schemaName}.${entry.parentName ?? ''}`;
  const ownKey = `${entry.schemaName}.${entry.name}`;

  switch (entry.objectType) {
    case 'schema':
      // Ownership comes from the model, so a non-`dbo`-owned schema keeps its
      // owner instead of silently becoming `dbo`-owned on restore.
      return renderSchemaCreate(entry.name, options, lookups.schemas.get(ownKey)?.ownerName);
    case 'table':
      return renderTableCreate(
        requireLookup(lookups.tables, ownKey, 'table'),
        options,
        lookups.databaseCollation,
      );
    case 'view':
      return renderViewCreate(requireLookup(lookups.views, ownKey, 'view'), options);
    case 'procedure':
    case 'function':
      return renderRoutineCreate(requireLookup(lookups.routines, ownKey, 'routine'), options);
    case 'sequence':
      return renderSequenceCreate(requireLookup(lookups.sequences, ownKey, 'sequence'), options);
    case 'trigger':
      return renderTriggerCreate(requireLookup(lookups.triggers, ownKey, 'trigger'), options);
    case 'primaryKey':
      return renderPrimaryKeyCreate(
        requireLookup(lookups.primaryKeys, ownKey, 'primary key'),
        options,
      );
    case 'uniqueConstraint':
      return renderUniqueConstraintCreate(
        requireLookup(lookups.uniqueConstraints, ownKey, 'unique constraint'),
        options,
      );
    case 'defaultConstraint':
      return renderDefaultConstraintCreate(
        requireLookup(lookups.defaultConstraints, ownKey, 'default constraint'),
        options,
      );
    case 'checkConstraint':
      return renderCheckConstraintCreate(
        requireLookup(lookups.checkConstraints, ownKey, 'check constraint'),
        options,
      );
    case 'foreignKey':
      return renderForeignKeyCreate(
        requireLookup(lookups.foreignKeys, ownKey, 'foreign key'),
        options,
      );
    case 'index':
      // Keyed by parent table too: index names are only unique per table.
      return renderIndexCreate(
        requireLookup(
          lookups.indexes,
          indexKey(entry.schemaName, entry.parentName ?? '', entry.name),
          'index',
        ),
        options,
      );
    case 'tableData':
    case 'sequenceState':
      return null;
    default: {
      const unreachable: never = entry.objectType;
      throw new Error(
        `Unhandled archive object type: ${String(unreachable)}. Referenced parent key was "${parentKey}".`,
      );
    }
  }
}

/** Renders the `DROP` statement for one archive entry, or `null` when nothing should be emitted. */
export function renderEntryDrop(
  entry: ArchiveEntry,
  lookups: RenderLookups,
  options: ResolvedPlainSqlRenderOptions,
): string | null {
  const ownKey = `${entry.schemaName}.${entry.name}`;

  switch (entry.objectType) {
    case 'schema':
      return renderSchemaDrop(entry.name, options);
    case 'table':
      return renderTableDrop(requireLookup(lookups.tables, ownKey, 'table'), options);
    case 'view':
      return renderViewDrop(requireLookup(lookups.views, ownKey, 'view'), options);
    case 'procedure':
    case 'function':
      return renderRoutineDrop(requireLookup(lookups.routines, ownKey, 'routine'), options);
    case 'sequence':
      return renderSequenceDrop(requireLookup(lookups.sequences, ownKey, 'sequence'), options);
    case 'trigger':
      return renderTriggerDrop(requireLookup(lookups.triggers, ownKey, 'trigger'), options);
    case 'primaryKey':
    case 'uniqueConstraint':
    case 'defaultConstraint':
    case 'checkConstraint':
    case 'foreignKey':
      return renderConstraintDrop(entry.schemaName, entry.parentName ?? '', entry.name, options);
    case 'index':
      return renderIndexDrop(
        requireLookup(
          lookups.indexes,
          indexKey(entry.schemaName, entry.parentName ?? '', entry.name),
          'index',
        ),
        options,
      );
    case 'tableData':
    case 'sequenceState':
      return null;
    default: {
      const unreachable: never = entry.objectType;
      throw new Error(`Unhandled archive object type: ${String(unreachable)}`);
    }
  }
}

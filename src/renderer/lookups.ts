import type {
  MssqlCheckConstraint,
  MssqlDefaultConstraint,
  MssqlForeignKey,
  MssqlPrimaryKey,
  MssqlUniqueConstraint,
} from '../model/constraint.js';
import type { MssqlDatabase } from '../model/database.js';
import type { MssqlIndex } from '../model/indexes.js';
import type { MssqlRoutine } from '../model/routine.js';
import type { MssqlSchema } from '../model/schema.js';
import type { MssqlSequence } from '../model/sequence.js';
import type { MssqlTable } from '../model/table.js';
import type { MssqlTrigger } from '../model/trigger.js';
import type { MssqlView } from '../model/view.js';

export interface RenderLookups {
  readonly schemas: ReadonlyMap<string, MssqlSchema>;
  readonly tables: ReadonlyMap<string, MssqlTable>;
  readonly views: ReadonlyMap<string, MssqlView>;
  readonly routines: ReadonlyMap<string, MssqlRoutine>;
  readonly sequences: ReadonlyMap<string, MssqlSequence>;
  readonly triggers: ReadonlyMap<string, MssqlTrigger>;
  readonly primaryKeys: ReadonlyMap<string, MssqlPrimaryKey>;
  readonly uniqueConstraints: ReadonlyMap<string, MssqlUniqueConstraint>;
  readonly checkConstraints: ReadonlyMap<string, MssqlCheckConstraint>;
  readonly defaultConstraints: ReadonlyMap<string, MssqlDefaultConstraint>;
  readonly foreignKeys: ReadonlyMap<string, MssqlForeignKey>;
  readonly indexes: ReadonlyMap<string, MssqlIndex>;
}

const key = (schemaName: string, name: string): string => `${schemaName}.${name}`;

export function buildRenderLookups(database: MssqlDatabase): RenderLookups {
  return {
    schemas: new Map(database.schemas.map(s => [key(s.schemaName, s.schemaName), s])),
    tables: new Map(database.tables.map(t => [key(t.schemaName, t.pureName), t])),
    views: new Map(database.views.map(v => [key(v.schemaName, v.pureName), v])),
    routines: new Map(database.routines.map(r => [key(r.schemaName, r.pureName), r])),
    sequences: new Map(database.sequences.map(s => [key(s.schemaName, s.pureName), s])),
    triggers: new Map(database.triggers.map(t => [key(t.schemaName, t.triggerName), t])),
    primaryKeys: new Map(
      database.primaryKeys.map(pk => [key(pk.schemaName, pk.constraintName), pk]),
    ),
    uniqueConstraints: new Map(
      database.uniqueConstraints.map(uq => [key(uq.schemaName, uq.constraintName), uq]),
    ),
    checkConstraints: new Map(
      database.checkConstraints.map(c => [key(c.schemaName, c.constraintName), c]),
    ),
    defaultConstraints: new Map(
      database.defaultConstraints.map(d => [key(d.schemaName, d.constraintName), d]),
    ),
    foreignKeys: new Map(
      database.foreignKeys.map(fk => [key(fk.schemaName, fk.constraintName), fk]),
    ),
    indexes: new Map(database.indexes.map(ix => [key(ix.schemaName, ix.indexName), ix])),
  };
}

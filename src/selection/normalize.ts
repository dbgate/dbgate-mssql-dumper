import { DEFAULT_EXCLUDED_SCHEMAS, tableSelectorKey } from './types.js';
import type { DumpSelection, NormalizedDumpSelection } from './types.js';

export function normalizeDumpSelection(selection?: DumpSelection): NormalizedDumpSelection {
  const includeSystemSchemas = selection?.includeSystemSchemas ?? false;

  const excludeSchemas = new Set<string>(selection?.excludeSchemas ?? []);
  if (!includeSystemSchemas) {
    for (const name of DEFAULT_EXCLUDED_SCHEMAS) {
      excludeSchemas.add(name);
    }
  }

  return {
    schemas: selection?.schemas ? new Set(selection.schemas) : undefined,
    excludeSchemas,
    tables: selection?.tables ? new Set(selection.tables.map(tableSelectorKey)) : undefined,
    excludeTables: new Set((selection?.excludeTables ?? []).map(tableSelectorKey)),
    includeSystemSchemas,
  };
}

export function isSchemaSelected(schemaName: string, selection: NormalizedDumpSelection): boolean {
  if (selection.excludeSchemas.has(schemaName)) {
    return false;
  }
  if (selection.schemas && !selection.schemas.has(schemaName)) {
    return false;
  }
  return true;
}

export function isTableSelected(
  schemaName: string,
  tableName: string,
  selection: NormalizedDumpSelection,
): boolean {
  if (!isSchemaSelected(schemaName, selection)) {
    return false;
  }
  const key = `${schemaName}.${tableName}`;
  if (selection.excludeTables.has(key)) {
    return false;
  }
  if (selection.tables && !selection.tables.has(key)) {
    return false;
  }
  return true;
}

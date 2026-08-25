import type { Writable } from 'node:stream';
import { inspectDumpArchive } from '../archive/planner.js';
import type { ArchiveEntry } from '../archive/types.js';
import { acquireMssqlConnection } from '../connection/acquire.js';
import type { MssqlConnectionInput } from '../connection/types.js';
import { exportTableDataAsInserts } from '../data/insertExport.js';
import { introspectMssql } from '../introspection/introspect.js';
import type { MssqlDiagnostic } from '../model/diagnostics.js';
import type { MssqlTable } from '../model/table.js';
import { renderPlainSql } from '../renderer/plainSql.js';
import { normalizeDumpSelection } from '../selection/normalize.js';
import { MssqlDumperError } from '../utils/errors.js';
import type { DumpProgressCallback } from '../utils/progress.js';
import { StreamDumpWriter } from '../writer/streamWriter.js';
import type { DumpMssqlOptions, DumpResult } from './types.js';

/**
 * Coordinates introspection, archive planning, plain-SQL rendering, and
 * (for `mode: 'full' | 'data-only'`) streaming table data export into one
 * end-to-end dump, all against **one** acquired physical connection —
 * introspection and data export must observe the same session (see
 * "Why one physical session" in `docs/architecture.md`).
 */
export async function dumpMssql(
  connectionInput: MssqlConnectionInput,
  options: DumpMssqlOptions,
  output: Writable,
  onProgress?: DumpProgressCallback,
  signal?: AbortSignal,
): Promise<DumpResult> {
  onProgress?.({ phase: 'connecting' });
  const acquired = await acquireMssqlConnection(connectionInput, signal);

  try {
    onProgress?.({ phase: 'introspecting' });
    const introspection = await introspectMssql(
      acquired.connection,
      { selection: options.selection },
      signal,
    );
    onProgress?.({ phase: 'detecting-version', message: introspection.version.productVersion });

    const normalizedSelection = normalizeDumpSelection(options.selection);
    const mode = options.mode ?? 'full';
    const archive = inspectDumpArchive(introspection.database, {
      mode,
      selection: normalizedSelection,
    });
    onProgress?.({ phase: 'planning-archive', objectsTotal: archive.entries.length });

    if (!archive.valid) {
      throw new MssqlDumperError(
        'invalid-archive',
        'Archive planning failed; inspect diagnostics/cycles returned by inspectDumpArchive for details',
      );
    }

    const writer = new StreamDumpWriter(output);
    const tablesByKey = new Map<string, MssqlTable>(
      introspection.database.tables.map(table => [`${table.schemaName}.${table.pureName}`, table]),
    );
    // Row data is read in primary-key order so two dumps of the same database
    // are byte-identical. Without an explicit ORDER BY, SQL Server is free to
    // return rows in any order (heap scans, parallel plans, page splits), and
    // this package's determinism guarantee would not extend to data.
    const primaryKeyColumnsByTable = new Map<string, readonly string[]>(
      introspection.database.primaryKeys.map(primaryKey => [
        `${primaryKey.schemaName}.${primaryKey.pureName}`,
        [...primaryKey.columns]
          .sort((a, b) => a.ordinalPosition - b.ordinalPosition)
          .map(column => column.columnName),
      ]),
    );

    let rowsExported = 0;
    const dataExportWarnings: MssqlDiagnostic[] = [];

    const onDataEntry = async (entry: ArchiveEntry): Promise<boolean> => {
      if (entry.objectType !== 'tableData') {
        // `sequenceState` (current sequence value) is not yet exported; falls back to the
        // renderer's default "not rendered" warning for that entry.
        return false;
      }
      const tableKey = `${entry.schemaName}.${entry.name}`;
      const table = tablesByKey.get(tableKey);
      const result = await exportTableDataAsInserts({
        connection: acquired.connection,
        schemaName: entry.schemaName,
        pureName: entry.name,
        writer,
        table,
        orderByColumns: primaryKeyColumnsByTable.get(tableKey),
        options: options.dataExport,
        signal,
        onProgress,
      });
      rowsExported += result.rowsExported;
      dataExportWarnings.push(...result.warnings);
      return true;
    };

    const renderResult = await renderPlainSql({
      database: introspection.database,
      archive,
      writer,
      options: options.render,
      signal,
      onProgress,
      sourceVersion: introspection.version,
      mode,
      onDataEntry,
    });

    onProgress?.({ phase: 'finalizing' });

    return {
      bytesWritten: renderResult.bytesWritten,
      renderedDumpIds: renderResult.renderedDumpIds,
      skippedDumpIds: renderResult.skippedDumpIds,
      warnings: [
        ...introspection.diagnostics,
        ...archive.diagnostics,
        ...renderResult.warnings,
        ...dataExportWarnings,
      ],
      cancelled: renderResult.cancelled,
      rowsExported,
    };
  } finally {
    await acquired.release();
  }
}

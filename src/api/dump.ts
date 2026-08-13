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

    let rowsExported = 0;
    const dataExportWarnings: MssqlDiagnostic[] = [];

    const onDataEntry = async (entry: ArchiveEntry): Promise<boolean> => {
      if (entry.objectType !== 'tableData') {
        // `sequenceState` (current sequence value) is not yet exported; falls back to the
        // renderer's default "not rendered" warning for that entry.
        return false;
      }
      const table = tablesByKey.get(`${entry.schemaName}.${entry.name}`);
      const result = await exportTableDataAsInserts({
        connection: acquired.connection,
        schemaName: entry.schemaName,
        pureName: entry.name,
        writer,
        table,
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

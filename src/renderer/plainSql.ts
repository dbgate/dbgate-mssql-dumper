import type { ArchiveEntry } from '../archive/types.js';
import type { MssqlDiagnostic } from '../model/diagnostics.js';
import { archiveObjectTypeToKind } from '../model/reference.js';
import { MssqlDumperError, throwIfAborted } from '../utils/errors.js';
import { renderEntryCreate, renderEntryDrop } from './dispatch.js';
import { buildRenderLookups } from './lookups.js';
import type { RenderLookups } from './lookups.js';
import { resolvePlainSqlRenderOptions } from './types.js';
import type {
  PlainSqlRenderRequest,
  PlainSqlRenderResult,
  ResolvedPlainSqlRenderOptions,
} from './types.js';

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'OperationCancelledError')
  );
}

/**
 * Renders a validated {@link DumpArchiveInspection} as deterministic plain
 * T-SQL text. Purely a function of the static model and archive plan: it
 * never queries the database, so it cannot render table row data (see
 * `exportTableDataAsInserts` in the `data` module for that).
 */
export async function renderPlainSql(
  request: PlainSqlRenderRequest,
): Promise<PlainSqlRenderResult> {
  const options = resolvePlainSqlRenderOptions(request.options);
  const { database, archive, writer, signal, onProgress, onDataEntry } = request;

  if (!archive.valid) {
    throw new MssqlDumperError(
      'invalid-archive',
      'Cannot render an archive inspection that failed validation; see archive.diagnostics and archive.cycles',
    );
  }

  const warnings: MssqlDiagnostic[] = [];
  const renderedDumpIds: string[] = [];
  const skippedDumpIds: string[] = [];
  const lookups = buildRenderLookups(database);

  const emit = async (text: string): Promise<void> => {
    // Match whole line breaks, not a bare `\n`: much of what is emitted is
    // verbatim catalog text (view/procedure/trigger definitions, check and
    // default expressions, computed columns, index filters), and SQL Server
    // stores those with CRLF whenever SSMS or any Windows client created
    // them. Replacing only `\n` would turn an existing `\r\n` into `\r\r\n`,
    // which is neither a valid line ending nor round-trippable. The `'\n'`
    // default short-circuits entirely, so a CR that is genuinely *data*
    // inside a string literal is left untouched in the common case.
    const normalized =
      options.lineEnding === '\n' ? text : text.replace(/\r\n|\r|\n/g, options.lineEnding);
    await writer.write(normalized + options.lineEnding, signal);
  };

  try {
    for (const line of buildHeaderLines(request, options)) {
      await emit(line);
    }
    await emit('');

    if (options.includeDropStatements) {
      for (const entry of [...archive.entries].reverse()) {
        throwIfAborted(signal);
        const dropSql = renderEntryDrop(entry, lookups, options);
        if (dropSql) {
          await emit(dropSql);
          await emit('GO');
        }
      }
      await emit('');
    }

    const total = archive.entries.length;
    let processed = 0;

    for (const entry of archive.entries) {
      throwIfAborted(signal);
      processed++;
      onProgress?.({ phase: 'rendering-schema', objectsProcessed: processed, objectsTotal: total });

      if (entry.section === 'data') {
        const handled = onDataEntry ? await onDataEntry(entry) : false;
        if (handled) {
          await emit('GO');
          renderedDumpIds.push(entry.dumpId);
        } else {
          warnings.push(dataNotRenderedDiagnostic(entry));
          skippedDumpIds.push(entry.dumpId);
        }
        continue;
      }

      const createSql = renderEntryCreateOrHandle(
        entry,
        lookups,
        options,
        warnings,
        skippedDumpIds,
      );
      if (createSql === undefined) {
        continue;
      }

      await emit(createSql);
      await emit('GO');
      renderedDumpIds.push(entry.dumpId);
    }

    return {
      bytesWritten: writer.bytesWritten,
      renderedDumpIds,
      skippedDumpIds,
      warnings,
      cancelled: false,
    };
  } catch (error) {
    if (isAbortError(error)) {
      return {
        bytesWritten: writer.bytesWritten,
        renderedDumpIds,
        skippedDumpIds,
        warnings,
        cancelled: true,
      };
    }
    throw error;
  }
}

/**
 * Builds the dump header: a recognizable, package-specific marker line
 * (`isDumperSqlDump()` checks for it verbatim, so its text never changes),
 * followed by source metadata safe to disclose (database name,
 * collation, compatibility level, source product version, dump mode) and
 * an optional timestamp. Never includes connection details or credentials —
 * none are reachable from `MssqlDatabase`/`MssqlVersion` in the first
 * place, so there is nothing to accidentally leak here.
 */
function buildHeaderLines(
  request: PlainSqlRenderRequest,
  options: ResolvedPlainSqlRenderOptions,
): string[] {
  const { database, sourceVersion, mode } = request;
  const lines = ['-- dbgate-mssql-dumper plain SQL dump'];
  lines.push(`-- Database: ${database.databaseName}`);
  if (database.collationName) {
    lines.push(`-- Collation: ${database.collationName}`);
  }
  if (database.compatibilityLevel !== null) {
    lines.push(`-- Compatibility level: ${database.compatibilityLevel}`);
  }
  if (sourceVersion) {
    lines.push(
      `-- Source: SQL Server ${sourceVersion.productVersion} (${sourceVersion.engineEdition}${sourceVersion.isAzure ? ', Azure' : ''})`,
    );
  }
  if (mode) {
    lines.push(`-- Mode: ${mode}`);
  }
  if (options.includeTimestamp) {
    lines.push(`-- Generated: ${new Date().toISOString()}`);
  }
  return lines;
}

function dataNotRenderedDiagnostic(entry: ArchiveEntry): MssqlDiagnostic {
  const { schemaName, name } = entry;
  if (entry.objectType === 'sequenceState') {
    return {
      severity: 'warning',
      code: 'data-not-rendered',
      message: `The current value of sequence "${schemaName}"."${name}" was selected but renderPlainSql only renders schema objects; a live connection is required to read and apply sequence state.`,
      objectReference: { kind: 'sequence', schemaName, name },
    };
  }
  return {
    severity: 'warning',
    code: 'data-not-rendered',
    message: `Table data for "${schemaName}"."${name}" was selected but renderPlainSql only renders schema objects; use exportTableDataAsInserts with a live connection to stream row data.`,
    objectReference: { kind: 'table', schemaName, name },
  };
}

function renderEntryCreateOrHandle(
  entry: ArchiveEntry,
  lookups: RenderLookups,
  options: ResolvedPlainSqlRenderOptions,
  warnings: MssqlDiagnostic[],
  skippedDumpIds: string[],
): string | undefined {
  let createSql: string | null;
  try {
    createSql = renderEntryCreate(entry, lookups, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.unsupportedFeaturePolicy === 'warn-omit') {
      warnings.push({
        severity: 'warning',
        code: 'render-failed',
        message,
        objectReference: {
          kind: archiveObjectTypeToKind(entry.objectType),
          schemaName: entry.schemaName,
          name: entry.name,
          parentName: entry.parentName,
        },
      });
      skippedDumpIds.push(entry.dumpId);
      return undefined;
    }
    throw new MssqlDumperError('render-failed', message, { cause: error });
  }

  if (createSql === null) {
    const message = `Object "${entry.schemaName}"."${entry.name}" (${entry.objectType}) is not supported by the plain SQL renderer yet`;
    if (options.unsupportedFeaturePolicy === 'warn-omit') {
      warnings.push({
        severity: 'warning',
        code: 'unsupported-object',
        message,
        objectReference: {
          kind: archiveObjectTypeToKind(entry.objectType),
          schemaName: entry.schemaName,
          name: entry.name,
          parentName: entry.parentName,
        },
      });
      skippedDumpIds.push(entry.dumpId);
      return undefined;
    }
    throw new MssqlDumperError('unsupported-object', message);
  }

  return createSql;
}

import type { ArchiveEntry, DumpArchiveInspection, DumpMode } from '../archive/types.js';
import type { MssqlDatabase } from '../model/database.js';
import type { MssqlDiagnostic } from '../model/diagnostics.js';
import type { DumpProgressCallback } from '../utils/progress.js';
import type { MssqlVersion } from '../version/types.js';
import type { DumpWriter } from '../writer/types.js';

export type KeywordCase = 'upper' | 'lower' | 'preserve';
export type LineEnding = '\n' | '\r\n';

/**
 * How the renderer reacts to a model feature it cannot express in plain SQL
 * yet (e.g. columnstore indexes). `error` (default) fails the render;
 * `warn-omit` skips the entry and records a warning diagnostic.
 */
export type UnsupportedFeaturePolicy = 'error' | 'warn-omit';

export interface PlainSqlRenderOptions {
  readonly keywordCase?: KeywordCase;
  readonly indentation?: string;
  readonly lineEnding?: LineEnding;
  /** Forces bracket-quoting on every identifier, even ones that would be safe unquoted. */
  readonly quoteAllIdentifiers?: boolean;
  /** Emits `DROP ... IF EXISTS` statements in reverse dependency order before creation. Minimum target: SQL Server 2016. */
  readonly includeDropStatements?: boolean;
  readonly includeTimestamp?: boolean;
  /** Emits `sp_addextendedproperty` calls for `MS_Description` comments. Defaults to true. */
  readonly includeComments?: boolean;
  readonly unsupportedFeaturePolicy?: UnsupportedFeaturePolicy;
}

export interface PlainSqlRenderRequest {
  readonly database: MssqlDatabase;
  readonly archive: DumpArchiveInspection;
  readonly writer: DumpWriter;
  readonly options?: PlainSqlRenderOptions;
  readonly signal?: AbortSignal;
  readonly onProgress?: DumpProgressCallback;
  /** Source server version; used only to enrich the dump header, never affects rendered SQL. */
  readonly sourceVersion?: MssqlVersion;
  /** Which dump mode produced `archive`; used only to enrich the dump header. */
  readonly mode?: DumpMode;
  /**
   * Called for each `data`-section entry (`tableData`/`sequenceState`)
   * instead of the default "not rendered" warning, for callers that can
   * actually stream the underlying state (see `dumpMssql`, which supplies
   * this backed by a live connection). Resolve `true` once the entry's
   * data has been written to `writer`; resolve `false` to fall back to the
   * default warning/skip for that entry (e.g. an object type this hook
   * does not handle). Never called for non-`data` sections.
   */
  readonly onDataEntry?: (entry: ArchiveEntry) => Promise<boolean>;
}

export interface PlainSqlRenderResult {
  readonly bytesWritten: number;
  readonly renderedDumpIds: readonly string[];
  readonly skippedDumpIds: readonly string[];
  readonly warnings: readonly MssqlDiagnostic[];
  readonly cancelled: boolean;
}

export interface ResolvedPlainSqlRenderOptions {
  readonly keywordCase: KeywordCase;
  readonly indentation: string;
  readonly lineEnding: LineEnding;
  readonly quoteAllIdentifiers: boolean;
  readonly includeDropStatements: boolean;
  readonly includeTimestamp: boolean;
  readonly includeComments: boolean;
  readonly unsupportedFeaturePolicy: UnsupportedFeaturePolicy;
}

export function resolvePlainSqlRenderOptions(
  options?: PlainSqlRenderOptions,
): ResolvedPlainSqlRenderOptions {
  return {
    keywordCase: options?.keywordCase ?? 'upper',
    indentation: options?.indentation ?? '  ',
    lineEnding: options?.lineEnding ?? '\n',
    quoteAllIdentifiers: options?.quoteAllIdentifiers ?? false,
    includeDropStatements: options?.includeDropStatements ?? false,
    includeTimestamp: options?.includeTimestamp ?? false,
    includeComments: options?.includeComments ?? true,
    unsupportedFeaturePolicy: options?.unsupportedFeaturePolicy ?? 'error',
  };
}

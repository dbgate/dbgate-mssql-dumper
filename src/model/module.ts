/**
 * Metadata shared by every object backed by a `sys.sql_modules` row (views,
 * procedures, functions, triggers): the session settings required to
 * recreate it correctly, and whether its definition could actually be read.
 */
export interface MssqlModuleMetadata {
  /**
   * `sys.sql_modules.uses_ansi_nulls`/`uses_quoted_identifier`. `null` when
   * no `sys.sql_modules` row exists for the object at all (for example, a
   * CLR-backed routine), as distinct from `false`.
   */
  readonly usesAnsiNulls: boolean | null;
  readonly usesQuotedIdentifier: boolean | null;
  /**
   * `OBJECTPROPERTY(object_id, 'IsEncrypted')`. When `true`, `definition` is
   * `null` by design — SQL Server itself returns no text for an encrypted
   * module — and an `encrypted-module-definition-unavailable` diagnostic is
   * reported. This is never inferred from `definition` being `null` alone,
   * since a missing `sys.sql_modules` row (e.g. a CLR routine) also leaves
   * `definition` `null` but is not encryption.
   */
  readonly isEncrypted: boolean;
}

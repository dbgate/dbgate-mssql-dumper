import type { MssqlObjectReference } from './reference.js';

export type MssqlDiagnosticSeverity = 'info' | 'warning' | 'error';

/**
 * A structured diagnostic surfaced by introspection, archive planning, or
 * rendering. Diagnostics are never thrown as exceptions for recoverable
 * conditions; callers inspect them explicitly instead of parsing log text.
 */
export interface MssqlDiagnostic {
  readonly severity: MssqlDiagnosticSeverity;
  /** Stable machine-readable identifier, e.g. `"unsupported-object-kind"`. */
  readonly code: string;
  readonly message: string;
  readonly objectReference?: MssqlObjectReference;
}

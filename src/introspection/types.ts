import type { MssqlIsolationLevel, MssqlTransactionMode } from '../connection/session.js';
import type { MssqlDatabase } from '../model/database.js';
import type { MssqlDiagnostic } from '../model/diagnostics.js';
import type { DumpSelection } from '../selection/types.js';
import type { MssqlVersion, SourceCapabilities } from '../version/types.js';

export interface IntrospectMssqlOptions {
  readonly selection?: DumpSelection;
  /** Defaults to `'none'`: introspection issues many independent reads and does not require a shared transaction unless asked for. */
  readonly transactionMode?: MssqlTransactionMode;
  readonly isolationLevel?: MssqlIsolationLevel;
}

export interface MssqlIntrospectionResult {
  readonly database: MssqlDatabase;
  readonly version: MssqlVersion;
  readonly capabilities: SourceCapabilities;
  readonly diagnostics: readonly MssqlDiagnostic[];
}

import type { MssqlConnectionInput } from '../connection/types.js';
import type { MssqlDiagnostic } from '../model/diagnostics.js';
import type { MssqlVersion, SourceCapabilities } from '../version/types.js';

export interface RestorePreflightRequest {
  readonly connection: MssqlConnectionInput;
  readonly signal?: AbortSignal;
}

/**
 * Result of checking a restore target before executing any statement.
 *
 * This is currently limited to target version/capability detection.
 * Planned additions (existing-object conflict detection, schema/role
 * mapping, dependency validation against the archive) are described in
 * `docs/architecture.md`.
 */
export interface RestorePreflightReport {
  readonly targetVersion: MssqlVersion;
  readonly targetCapabilities: SourceCapabilities;
  readonly warnings: readonly MssqlDiagnostic[];
}

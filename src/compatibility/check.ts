import type { MssqlDiagnostic } from '../model/diagnostics.js';
import { detectSourceCapabilities } from '../version/capabilities.js';
import type { RequiredFeatureCheck, TargetCapabilities } from './types.js';

export { detectSourceCapabilities as detectTargetCapabilities };

const FEATURE_LABELS: Record<keyof TargetCapabilities, string> = {
  supportsSequences: 'CREATE SEQUENCE (SQL Server 2012+)',
  supportsMemoryOptimizedTables: 'memory-optimized tables (SQL Server 2014+)',
  supportsTemporalTables: 'system-versioned temporal tables (SQL Server 2016+)',
  supportsJsonFunctions: 'native JSON functions (SQL Server 2016+)',
  supportsAlwaysEncrypted: 'Always Encrypted columns (SQL Server 2016+)',
  supportsGraphTables: 'graph (NODE/EDGE) tables (SQL Server 2017+)',
  supportsNativeJsonType: 'native JSON data type (SQL Server 2025+)',
  supportsExtendedProperties: 'extended properties',
};

/**
 * Checks a list of feature requirements against a restore target's
 * capabilities, returning one `error` diagnostic per unsupported feature.
 * Does not throw: callers decide whether an unsupported feature blocks the
 * restore or is merely reported.
 */
export function checkTargetCompatibility(
  target: TargetCapabilities,
  required: readonly RequiredFeatureCheck[],
): MssqlDiagnostic[] {
  const diagnostics: MssqlDiagnostic[] = [];
  for (const check of required) {
    if (!target[check.feature]) {
      diagnostics.push({
        severity: 'error',
        code: 'unsupported-target-feature',
        message: `Restore target does not support ${FEATURE_LABELS[check.feature]}`,
        objectReference: check.objectReference,
      });
    }
  }
  return diagnostics;
}

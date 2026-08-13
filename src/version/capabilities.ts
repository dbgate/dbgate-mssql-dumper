import type { MssqlVersion, SourceCapabilities } from './types.js';

/**
 * Derives structural {@link SourceCapabilities} from a detected
 * {@link MssqlVersion}. Azure SQL Database and Azure SQL Managed Instance
 * always track the latest on-premises major version's feature set.
 */
export function detectSourceCapabilities(version: MssqlVersion): SourceCapabilities {
  const alwaysCurrent = version.isAzure;
  const major = version.majorVersion;

  const atLeast = (target: number): boolean => alwaysCurrent || major >= target;

  return {
    supportsSequences: atLeast(11),
    supportsMemoryOptimizedTables: atLeast(12),
    supportsTemporalTables: atLeast(13),
    supportsJsonFunctions: atLeast(13),
    supportsAlwaysEncrypted: atLeast(13),
    supportsGraphTables: atLeast(14),
    supportsNativeJsonType: atLeast(17),
    supportsExtendedProperties: true,
  };
}

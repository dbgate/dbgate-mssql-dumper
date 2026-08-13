import { acquireMssqlConnection } from '../connection/acquire.js';
import { detectSourceCapabilities } from '../version/capabilities.js';
import { detectMssqlVersion } from '../version/detect.js';
import type { RestorePreflightReport, RestorePreflightRequest } from './types.js';

/** Detects the restore target's version and capabilities ahead of executing any statement. */
export async function preflightRestore(
  request: RestorePreflightRequest,
): Promise<RestorePreflightReport> {
  const acquired = await acquireMssqlConnection(request.connection, request.signal);
  try {
    const targetVersion = await detectMssqlVersion(acquired.connection, request.signal);
    return {
      targetVersion,
      targetCapabilities: detectSourceCapabilities(targetVersion),
      warnings: [],
    };
  } finally {
    await acquired.release();
  }
}

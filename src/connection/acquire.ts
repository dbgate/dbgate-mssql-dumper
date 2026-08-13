import type { AcquiredMssqlConnection, MssqlConnection, MssqlConnectionInput } from './types.js';
import { isMssqlConnectionSource } from './types.js';

/**
 * Normalizes an {@link MssqlConnectionInput} into an acquired connection with
 * a release callback. A direct connection resolves immediately with a no-op
 * release; a source is acquired through its own `acquire()`.
 */
export async function acquireMssqlConnection(
  input: MssqlConnectionInput,
  signal?: AbortSignal,
): Promise<AcquiredMssqlConnection> {
  if (isMssqlConnectionSource(input)) {
    return input.acquire(signal);
  }
  return {
    connection: input as MssqlConnection,
    release: async () => {},
  };
}

import { defineConfig } from 'vitest/config';

/**
 * Integration tests run against a real SQL Server instance and are kept in a
 * separate Vitest project from the unit tests on purpose: `npm test` must
 * stay fast and dependency-free (no Docker, no network), while
 * `npm run test:integration` opts in to a live server. See
 * `docs/round-trip-testing.md`.
 *
 * When no server is reachable, the suites skip themselves with a clear
 * message rather than failing — set `MSSQL_TEST_REQUIRED=1` (as CI should)
 * to turn "unreachable" into a hard error instead, so the tests can never
 * silently no-op in an environment that was supposed to run them.
 */
export default defineConfig({
  test: {
    include: ['integration/**/*.test.ts'],
    environment: 'node',
    // One physical SQL Server, and suites that create/drop databases on it:
    // run files sequentially so concurrent DDL never contends.
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 300_000,
  },
});

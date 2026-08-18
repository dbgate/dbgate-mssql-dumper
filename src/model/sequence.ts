/** `CREATE SEQUENCE`; SQL Server 2012 (11.x) and later, see {@link SourceCapabilities.supportsSequences}. */
export interface MssqlSequence {
  readonly schemaName: string;
  readonly pureName: string;
  readonly dataType: string;
  readonly startValue: bigint | null;
  readonly increment: bigint | null;
  readonly minValue: bigint | null;
  readonly maxValue: bigint | null;
  readonly isCycling: boolean;
  readonly currentValue: bigint | null;
  /** `sys.sequences.cache_size`; `null` means the engine chooses (`NO CACHE` is `0`, not `null`). */
  /**
   * Whether caching is on at all (`sys.sequences.is_cached`). Required to
   * disambiguate {@link cacheSize}: SQL Server reports `cache_size` as `NULL`
   * both for `NO CACHE` and for `CACHE` with the server-chosen default size,
   * so the size alone cannot tell the two apart.
   */
  readonly isCached: boolean;
  /** Explicit cache size, or `null` when the server default size applies. */
  readonly cacheSize: number | null;
  readonly comment: string | null;
}

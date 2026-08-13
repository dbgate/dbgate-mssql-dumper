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
  readonly cacheSize: number | null;
  readonly comment: string | null;
}

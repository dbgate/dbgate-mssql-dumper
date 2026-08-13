/**
 * Incremental output sink for rendered SQL text. Implementations never close
 * the underlying resource; callers own its lifecycle.
 */
export interface DumpWriter {
  /** Writes one chunk, resolving once it is safe to write again (respects backpressure). */
  write(chunk: string, signal?: AbortSignal): Promise<void>;
  /** Total UTF-8 bytes written so far. */
  readonly bytesWritten: number;
}

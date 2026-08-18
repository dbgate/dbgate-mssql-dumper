import type { Writable } from 'node:stream';
import type { DumpWriter } from './types.js';

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
}

/**
 * Writes incrementally to a caller-owned `Writable`, honoring backpressure
 * (awaiting the stream's own `drain` when `write()` returns `false`) and
 * `AbortSignal` cancellation. Never calls `end()`/`close()` on the stream.
 */
export class StreamDumpWriter implements DumpWriter {
  private readonly stream: Writable;
  private bytes = 0;

  constructor(stream: Writable) {
    this.stream = stream;
  }

  get bytesWritten(): number {
    return this.bytes;
  }

  async write(chunk: string, signal?: AbortSignal): Promise<void> {
    if (chunk.length === 0) {
      return;
    }
    throwIfAborted(signal);

    this.bytes += Buffer.byteLength(chunk, 'utf8');

    const canWriteMore = await new Promise<boolean>((resolve, reject) => {
      const cleanup = (): void => {
        this.stream.removeListener('error', onError);
        signal?.removeEventListener('abort', onAbort);
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      // Without this the promise settles only when the chunk is flushed, so
      // aborting while the consumer is stalled would hang the whole dump
      // forever — never resolving, never rejecting, never releasing the
      // connection — instead of returning `cancelled: true` as documented.
      const onAbort = (): void => {
        cleanup();
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      this.stream.once('error', onError);
      signal?.addEventListener('abort', onAbort, { once: true });
      const ok = this.stream.write(chunk, 'utf8', (error?: Error | null) => {
        cleanup();
        if (error) {
          reject(error);
        } else {
          resolve(ok);
        }
      });
    });

    if (canWriteMore === false) {
      throwIfAborted(signal);
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          this.stream.removeListener('drain', onDrain);
          this.stream.removeListener('error', onError);
          signal?.removeEventListener('abort', onAbort);
        };
        const onDrain = (): void => {
          cleanup();
          resolve();
        };
        const onError = (error: Error): void => {
          cleanup();
          reject(error);
        };
        // A consumer that stopped reading never emits `drain`, so this await is
        // exactly where a cancelled dump would otherwise stall indefinitely.
        const onAbort = (): void => {
          cleanup();
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        };
        this.stream.once('drain', onDrain);
        this.stream.once('error', onError);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }

    throwIfAborted(signal);
  }
}

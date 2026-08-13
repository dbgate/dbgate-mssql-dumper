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
      const onError = (error: Error): void => {
        reject(error);
      };
      this.stream.once('error', onError);
      const ok = this.stream.write(chunk, 'utf8', (error?: Error | null) => {
        this.stream.removeListener('error', onError);
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
        const onDrain = (): void => {
          this.stream.removeListener('error', onError);
          resolve();
        };
        const onError = (error: Error): void => {
          this.stream.removeListener('drain', onDrain);
          reject(error);
        };
        this.stream.once('drain', onDrain);
        this.stream.once('error', onError);
      });
    }

    throwIfAborted(signal);
  }
}

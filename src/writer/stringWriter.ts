import type { DumpWriter } from './types.js';

/** In-memory {@link DumpWriter}, for tests and bounded previews. Not for production dump sizes. */
export class StringDumpWriter implements DumpWriter {
  private chunks: string[] = [];
  private bytes = 0;

  get bytesWritten(): number {
    return this.bytes;
  }

  async write(chunk: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    this.chunks.push(chunk);
    this.bytes += Buffer.byteLength(chunk, 'utf8');
  }

  toString(): string {
    return this.chunks.join('');
  }
}

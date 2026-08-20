import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { StreamDumpWriter, StringDumpWriter } from '../src/writer/index.js';

describe('StringDumpWriter', () => {
  it('accumulates chunks and tracks UTF-8 byte counts', async () => {
    const writer = new StringDumpWriter();
    await writer.write('hello ');
    await writer.write('wörld');
    expect(writer.toString()).toBe('hello wörld');
    expect(writer.bytesWritten).toBe(Buffer.byteLength('hello wörld', 'utf8'));
  });

  it('rejects writes after the signal is aborted', async () => {
    const writer = new StringDumpWriter();
    const controller = new AbortController();
    controller.abort();
    await expect(writer.write('x', controller.signal)).rejects.toThrow();
  });
});

describe('StreamDumpWriter', () => {
  it('writes to the underlying stream without closing it', async () => {
    const stream = new PassThrough();
    const chunks: string[] = [];
    stream.on('data', chunk => chunks.push(chunk.toString('utf8')));

    const writer = new StreamDumpWriter(stream);
    await writer.write('one ');
    await writer.write('two');

    expect(chunks.join('')).toBe('one two');
    expect(stream.destroyed).toBe(false);
    expect(writer.bytesWritten).toBe(Buffer.byteLength('one two', 'utf8'));
  });

  it('propagates stream errors', async () => {
    const stream = new PassThrough();
    const writer = new StreamDumpWriter(stream);
    stream.destroy(new Error('boom'));
    await expect(writer.write('x')).rejects.toThrow('boom');
  });

  // Node emits 'drain' *before* invoking write()'s completion callback, so a
  // writer that awaits the callback and only then subscribes to 'drain' waits
  // for an event that has already fired. Every dump to a real file stream hung
  // at the first chunk that exceeded the stream's highWaterMark.
  it('resolves a write that exceeds the stream highWaterMark', async () => {
    const stream = new Writable({
      highWaterMark: 16,
      write(_chunk, _encoding, callback) {
        setTimeout(callback, 5);
      },
    });
    const writer = new StreamDumpWriter(stream);

    const outcome = await Promise.race([
      writer.write('x'.repeat(64)).then(() => 'resolved'),
      new Promise(resolve => setTimeout(() => resolve('hung'), 1000)),
    ]);

    expect(outcome).toBe('resolved');
  });

  it('keeps resolving across many backpressured writes', async () => {
    const stream = new Writable({
      highWaterMark: 16,
      write(_chunk, _encoding, callback) {
        setTimeout(callback, 1);
      },
    });
    const writer = new StreamDumpWriter(stream);

    const outcome = await Promise.race([
      (async () => {
        for (let index = 0; index < 25; index += 1) {
          await writer.write('y'.repeat(64));
        }
        return 'resolved';
      })(),
      new Promise(resolve => setTimeout(() => resolve('hung'), 2000)),
    ]);

    expect(outcome).toBe('resolved');
    expect(writer.bytesWritten).toBe(64 * 25);
  });
});

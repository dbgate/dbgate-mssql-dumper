import { PassThrough } from 'node:stream';
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
});

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { readSSE } from '../src/providers/sse.js';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]) {
  const frames = [];
  for await (const frame of readSSE(streamOf(chunks))) frames.push(frame);
  return frames;
}

describe('readSSE', () => {
  test('parses well-formed frames', async () => {
    const frames = await collect(['event: ping\ndata: {"a":1}\n\nevent: done\ndata: {}\n\n']);
    assert.deepEqual(frames, [
      { event: 'ping', data: '{"a":1}' },
      { event: 'done', data: '{}' },
    ]);
  });

  test('reassembles frames split across chunk boundaries', async () => {
    const frames = await collect(['event: pi', 'ng\ndata: {"a"', ':1}\n\n']);
    assert.deepEqual(frames, [{ event: 'ping', data: '{"a":1}' }]);
  });

  test('joins multi-line data payloads', async () => {
    const frames = await collect(['event: x\ndata: one\ndata: two\n\n']);
    assert.equal(frames[0]?.data, 'one\ntwo');
  });

  test('ignores comment keep-alives', async () => {
    const frames = await collect([': keep-alive\n\nevent: x\ndata: 1\n\n']);
    assert.deepEqual(frames, [{ event: 'x', data: '1' }]);
  });

  test('handles CRLF separators', async () => {
    const frames = await collect(['event: x\r\ndata: 1\r\n\r\n']);
    assert.deepEqual(frames, [{ event: 'x', data: '1' }]);
  });

  test('emits a trailing frame with no terminating blank line', async () => {
    const frames = await collect(['event: x\ndata: 1']);
    assert.deepEqual(frames, [{ event: 'x', data: '1' }]);
  });
});

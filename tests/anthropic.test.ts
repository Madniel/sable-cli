import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { AnthropicProvider } from '../src/providers/anthropic.js';
import type { CompletionRequest, StreamEvent } from '../src/providers/types.js';

function sseResponse(events: object[]): Response {
  const body = events
    .map(
      (event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const request: CompletionRequest = {
  system: 'be useful',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }],
  model: 'claude-sonnet-4-5',
  maxTokens: 1024,
};

describe('AnthropicProvider', () => {
  test('assembles text and usage from a stream', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'k',
      fetchImpl: async () =>
        sseResponse([
          { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 7 },
          },
          { type: 'message_stop' },
        ]),
    });

    const deltas: string[] = [];
    const result = await provider.complete(request, (event: StreamEvent) => {
      if (event.type === 'text_delta') deltas.push(event.text);
    });

    assert.deepEqual(deltas, ['Hello ', 'world']);
    assert.deepEqual(result.message.content, [{ type: 'text', text: 'Hello world' }]);
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.usage.inputTokens, 12);
    assert.equal(result.usage.outputTokens, 7);
  });

  test('reassembles a tool call from streamed JSON fragments', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'k',
      fetchImpl: async () =>
        sseResponse([
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'tu_1', name: 'read_file' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"pa' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: 'th":"a.ts"}' },
          },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        ]),
    });

    const result = await provider.complete(request, () => {});
    const block = result.message.content[0];

    assert.equal(block?.type, 'tool_use');
    assert.deepEqual(block?.type === 'tool_use' ? block.input : null, { path: 'a.ts' });
    assert.equal(result.stopReason, 'tool_use');
  });

  test('surfaces malformed tool JSON instead of crashing', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'k',
      fetchImpl: async () =>
        sseResponse([
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'tu_1', name: 'read_file' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"path"' },
          },
          { type: 'content_block_stop', index: 0 },
        ]),
    });

    const result = await provider.complete(request, () => {});
    const block = result.message.content[0];
    assert.ok(block?.type === 'tool_use' && '__malformed_json__' in (block.input as object));
  });

  test('retries a 429 and then succeeds', async () => {
    let calls = 0;
    const provider = new AnthropicProvider({
      apiKey: 'k',
      sleep: async () => {},
      fetchImpl: async () => {
        calls++;
        if (calls === 1) return new Response('{"error":{"message":"slow down"}}', { status: 429 });
        return sseResponse([
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        ]);
      },
    });

    const result = await provider.complete(request, () => {});
    assert.equal(calls, 2);
    assert.deepEqual(result.message.content, [{ type: 'text', text: 'ok' }]);
  });

  test('does not retry a 401, and says what to fix', async () => {
    let calls = 0;
    const provider = new AnthropicProvider({
      apiKey: 'bad',
      sleep: async () => {},
      fetchImpl: async () => {
        calls++;
        return new Response('{"error":{"message":"invalid x-api-key"}}', { status: 401 });
      },
    });

    await assert.rejects(() => provider.complete(request, () => {}), /Authentication failed/);
    assert.equal(calls, 1);
  });

  test('refuses to call out with no API key', async () => {
    const provider = new AnthropicProvider({ apiKey: undefined });
    await assert.rejects(() => provider.complete(request, () => {}), /No Anthropic API key/);
  });

  test('sends the request in the Anthropic wire shape', async () => {
    let captured: Record<string, unknown> = {};
    const provider = new AnthropicProvider({
      apiKey: 'k',
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
        return sseResponse([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }]);
      },
    });

    await provider.complete(request, () => {});

    assert.equal(captured['model'], 'claude-sonnet-4-5');
    assert.equal(captured['stream'], true);
    assert.equal(captured['max_tokens'], 1024);
    assert.ok(Array.isArray(captured['tools']));
    assert.equal((captured['tools'] as { name: string }[])[0]?.name, 'read_file');
  });
});

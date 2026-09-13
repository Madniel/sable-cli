import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { AnthropicProvider } from '../src/providers/anthropic.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import { readSSE } from '../src/providers/sse.js';
import type { CompletionRequest, StreamEvent } from '../src/providers/types.js';
import { dataOnlyResponse, sseResponse } from './helpers.js';

const request: CompletionRequest = {
  system: 'be useful',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }],
  model: 'test-model',
  maxTokens: 1024,
};

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collectFrames(chunks: string[]) {
  const frames = [];
  for await (const frame of readSSE(streamOf(chunks))) frames.push(frame);
  return frames;
}

describe('readSSE', () => {
  test('parses well-formed frames', async () => {
    const frames = await collectFrames(['event: ping\ndata: {"a":1}\n\nevent: done\ndata: {}\n\n']);

    assert.deepEqual(frames, [
      { event: 'ping', data: '{"a":1}' },
      { event: 'done', data: '{}' },
    ]);
  });

  test('reassembles frames split across chunk boundaries', async () => {
    const frames = await collectFrames(['event: pi', 'ng\ndata: {"a"', ':1}\n\n']);

    assert.deepEqual(frames, [{ event: 'ping', data: '{"a":1}' }]);
  });

  test('joins multi-line data payloads', async () => {
    const frames = await collectFrames(['event: x\ndata: one\ndata: two\n\n']);

    assert.equal(frames[0]?.data, 'one\ntwo');
  });

  test('ignores comment keep-alives', async () => {
    const frames = await collectFrames([': keep-alive\n\nevent: x\ndata: 1\n\n']);

    assert.deepEqual(frames, [{ event: 'x', data: '1' }]);
  });

  test('handles CRLF separators', async () => {
    const frames = await collectFrames(['event: x\r\ndata: 1\r\n\r\n']);

    assert.deepEqual(frames, [{ event: 'x', data: '1' }]);
  });

  test('emits a trailing frame with no terminating blank line', async () => {
    const frames = await collectFrames(['event: x\ndata: 1']);

    assert.deepEqual(frames, [{ event: 'x', data: '1' }]);
  });

  test('handles data-only frames, as OpenAI sends', async () => {
    const frames = await collectFrames(['data: {"a":1}\n\ndata: [DONE]\n\n']);

    assert.deepEqual(frames, [
      { event: undefined, data: '{"a":1}' },
      { event: undefined, data: '[DONE]' },
    ]);
  });
});

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

  test('honours a retry-after header', async () => {
    const delays: number[] = [];
    let calls = 0;

    const provider = new AnthropicProvider({
      apiKey: 'k',
      sleep: async (ms) => {
        delays.push(ms);
      },
      fetchImpl: async () => {
        calls++;
        if (calls === 1) {
          return new Response('{"error":{"message":"slow"}}', {
            status: 429,
            headers: { 'retry-after': '2' },
          });
        }
        return sseResponse([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }]);
      },
    });

    await provider.complete(request, () => {});

    assert.deepEqual(delays, [2000]);
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

    assert.equal(captured['model'], 'test-model');
    assert.equal(captured['stream'], true);
    assert.equal(captured['max_tokens'], 1024);
    assert.equal((captured['tools'] as { name: string }[])[0]?.name, 'read_file');
  });
});

describe('OpenAIProvider', () => {
  test('assembles streamed text and usage', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'k',
      fetchImpl: async () =>
        dataOnlyResponse([
          { choices: [{ delta: { content: 'Hello ' } }] },
          { choices: [{ delta: { content: 'world' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
          { choices: [], usage: { prompt_tokens: 30, completion_tokens: 9 } },
          '[DONE]',
        ]),
    });

    const deltas: string[] = [];
    const result = await provider.complete(request, (event) => {
      if (event.type === 'text_delta') deltas.push(event.text);
    });

    assert.deepEqual(deltas, ['Hello ', 'world']);
    assert.deepEqual(result.message.content, [{ type: 'text', text: 'Hello world' }]);
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.usage.inputTokens, 30);
    assert.equal(result.usage.outputTokens, 9);
  });

  test('reassembles a tool call split across chunks', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'k',
      fetchImpl: async () =>
        dataOnlyResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]),
    });

    const result = await provider.complete(request, () => {});
    const block = result.message.content[0];

    assert.equal(block?.type, 'tool_use');
    assert.equal(block?.type === 'tool_use' ? block.name : '', 'read_file');
    assert.deepEqual(block?.type === 'tool_use' ? block.input : null, { path: 'a.ts' });
    assert.equal(result.stopReason, 'tool_use');
  });

  test('maps tool results onto the tool role', async () => {
    let captured: Record<string, unknown> = {};

    const provider = new OpenAIProvider({
      apiKey: 'k',
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
        return dataOnlyResponse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]']);
      },
    });

    await provider.complete(
      {
        ...request,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'read it' }] },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a' } }],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolUseId: 'call_1', content: 'file body', isError: false },
            ],
          },
        ],
      },
      () => {},
    );

    const messages = captured['messages'] as { role: string; tool_call_id?: string }[];

    assert.equal(messages[0]?.role, 'system');
    assert.equal(messages[1]?.role, 'user');
    assert.equal(messages[2]?.role, 'assistant');
    assert.equal(messages[3]?.role, 'tool');
    assert.equal(messages[3]?.tool_call_id, 'call_1');
  });

  test('declares tools in the function-calling shape', async () => {
    let captured: Record<string, unknown> = {};

    const provider = new OpenAIProvider({
      apiKey: 'k',
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
        return dataOnlyResponse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]']);
      },
    });

    await provider.complete(request, () => {});

    const tools = captured['tools'] as { type: string; function: { name: string } }[];

    assert.equal(tools[0]?.type, 'function');
    assert.equal(tools[0]?.function.name, 'read_file');
    assert.equal(captured['tool_choice'], 'auto');
  });

  test('refuses to call out with no API key', async () => {
    const provider = new OpenAIProvider({ apiKey: undefined });

    await assert.rejects(() => provider.complete(request, () => {}), /No OpenAI API key/);
  });
});

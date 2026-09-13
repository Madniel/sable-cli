import { AuthError, ProviderError } from '../util/errors.js';
import {
  defaultSleep,
  describeFailure,
  requireStreamBody,
  withRetries,
  type Sleep,
} from './http.js';
import { parseToolInput } from './tool-input.js';
import { readSSE } from './sse.js';
import {
  EMPTY_USAGE,
  type CompletionRequest,
  type CompletionResult,
  type ContentBlock,
  type Message,
  type Provider,
  type StopReason,
  type StreamEvent,
  type Usage,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DONE_SENTINEL = '[DONE]';

export interface OpenAIOptions {
  apiKey: string | undefined;
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
}

interface WireToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface WireChunk {
  choices?: {
    index?: number;
    delta?: { content?: string | null; tool_calls?: WireToolCallDelta[] };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
  error?: { message?: string; type?: string };
}

interface PartialToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export class OpenAIProvider implements Provider {
  readonly id = 'openai';
  readonly label = 'OpenAI';
  readonly knownModels = ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o4-mini'] as const;

  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: Sleep;

  constructor(options: OpenAIOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async complete(
    request: CompletionRequest,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    if (!this.apiKey) {
      throw new AuthError(
        'No OpenAI API key found. Set OPENAI_API_KEY in your environment before starting sable.',
      );
    }

    return withRetries(() => this.sendOnce(request, onEvent, signal), this.sleep);
  }

  private async sendOnce(
    request: CompletionRequest,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey as string}`,
        accept: 'text/event-stream',
      },
      body: JSON.stringify(toWireRequest(request)),
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) throw await describeFailure(response);

    return this.readStream(requireStreamBody(response), onEvent, signal);
  }

  private async readStream(
    body: ReadableStream<Uint8Array>,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    const toolCalls = new Map<number, PartialToolCall>();
    const announced = new Set<number>();
    let text = '';
    let usage: Usage = { ...EMPTY_USAGE };
    let stopReason: StopReason = 'unknown';

    for await (const frame of readSSE(body, signal)) {
      if (frame.data === DONE_SENTINEL) break;

      const chunk = parseChunk(frame.data);
      if (!chunk) continue;

      if (chunk.error) {
        throw new ProviderError(
          chunk.error.message ?? 'The provider reported an error mid-stream.',
          {
            retryable: chunk.error.type === 'server_error',
          },
        );
      }

      if (chunk.usage) {
        usage = mergeUsage(chunk.usage);
        onEvent({ type: 'usage', usage });
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      const content = choice.delta?.content;
      if (typeof content === 'string' && content) {
        text += content;
        onEvent({ type: 'text_delta', text: content });
      }

      for (const delta of choice.delta?.tool_calls ?? []) {
        accumulateToolCall(toolCalls, announced, delta, onEvent);
      }

      if (choice.finish_reason) stopReason = toStopReason(choice.finish_reason);
    }

    for (const [index, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      onEvent({
        type: 'tool_use_end',
        id: call.id || `call_${index}`,
        name: call.name,
        input: parseToolInput(call.argumentsJson),
      });
    }

    return { message: assembleMessage(text, toolCalls), stopReason, usage };
  }
}

function toWireRequest(request: CompletionRequest): Record<string, unknown> {
  return {
    model: request.model,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: request.maxTokens,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    messages: [
      { role: 'system', content: request.system },
      ...request.messages.flatMap(toWireMessages),
    ],
    ...(request.tools.length > 0
      ? {
          tool_choice: 'auto',
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        }
      : {}),
  };
}

function toWireMessages(message: Message): Record<string, unknown>[] {
  const toolResults = message.content.filter((block) => block.type === 'tool_result');

  if (toolResults.length > 0) {
    return toolResults.map((block) => ({
      role: 'tool',
      tool_call_id: block.type === 'tool_result' ? block.toolUseId : '',
      content: block.type === 'tool_result' ? block.content : '',
    }));
  }

  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');

  if (message.role === 'user') {
    return [{ role: 'user', content: text }];
  }

  const toolCalls = message.content
    .filter((block) => block.type === 'tool_use')
    .map((block) =>
      block.type === 'tool_use'
        ? {
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          }
        : null,
    )
    .filter((call): call is NonNullable<typeof call> => call !== null);

  return [
    {
      role: 'assistant',
      content: text || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
  ];
}

function accumulateToolCall(
  calls: Map<number, PartialToolCall>,
  announced: Set<number>,
  delta: WireToolCallDelta,
  onEvent: (event: StreamEvent) => void,
): void {
  const index = delta.index ?? 0;
  const existing = calls.get(index) ?? { id: '', name: '', argumentsJson: '' };

  if (delta.id) existing.id = delta.id;
  if (delta.function?.name) existing.name += delta.function.name;
  if (delta.function?.arguments) {
    existing.argumentsJson += delta.function.arguments;
    onEvent({
      type: 'tool_use_input_delta',
      id: existing.id,
      partialJson: delta.function.arguments,
    });
  }

  calls.set(index, existing);

  if (existing.name && !announced.has(index)) {
    announced.add(index);
    onEvent({ type: 'tool_use_start', id: existing.id, name: existing.name });
  }
}

function assembleMessage(text: string, calls: Map<number, PartialToolCall>): Message {
  const content: ContentBlock[] = [];
  if (text) content.push({ type: 'text', text });

  for (const [index, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    content.push({
      type: 'tool_use',
      id: call.id || `call_${index}`,
      name: call.name,
      input: parseToolInput(call.argumentsJson),
    });
  }

  return { role: 'assistant', content };
}

function parseChunk(data: string): WireChunk | null {
  if (!data) return null;
  try {
    return JSON.parse(data) as WireChunk;
  } catch {
    return null;
  }
}

function mergeUsage(wire: NonNullable<WireChunk['usage']>): Usage {
  return {
    inputTokens: wire.prompt_tokens ?? 0,
    outputTokens: wire.completion_tokens ?? 0,
    cacheReadTokens: wire.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: 0,
  };
}

function toStopReason(reason: string): StopReason {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    default:
      return 'unknown';
  }
}

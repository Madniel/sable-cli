import { AuthError, ProviderError } from '../util/errors.js';
import { describeFailure, requireStreamBody, withRetries, type Sleep } from './http.js';
import { defaultSleep } from './http.js';
import { readSSE } from './sse.js';
import { parseToolInput } from './tool-input.js';
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

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';
const EPHEMERAL_CACHE = { type: 'ephemeral' as const };

export interface AnthropicOptions {
  apiKey: string | undefined;
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
}

interface WireUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface WireEvent {
  type: string;
  index?: number;
  message?: { usage?: WireUsage; stop_reason?: string | null };
  content_block?: { type: string; id?: string; name?: string; text?: string; thinking?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  usage?: WireUsage;
  error?: { type?: string; message?: string };
}

type BlockKind = 'text' | 'thinking' | 'tool_use';

interface PartialBlock {
  kind: BlockKind;
  text: string;
  thinking: string;
  signature: string | undefined;
  id: string;
  name: string;
  inputJson: string;
}

export class AnthropicProvider implements Provider {
  readonly id = 'anthropic';
  readonly label = 'Anthropic (Claude)';
  readonly knownModels = [
    'claude-sonnet-4-5',
    'claude-opus-4-1',
    'claude-haiku-4-5',
    'claude-3-5-haiku-latest',
  ] as const;

  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: Sleep;

  constructor(options: AnthropicOptions) {
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
        'No Anthropic API key found. Set ANTHROPIC_API_KEY in your environment before starting sable.',
      );
    }

    return withRetries(() => this.sendOnce(request, onEvent, signal), this.sleep);
  }

  private async sendOnce(
    request: CompletionRequest,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey as string,
        'anthropic-version': API_VERSION,
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
    const blocks = new Map<number, PartialBlock>();
    let usage: Usage = { ...EMPTY_USAGE };
    let stopReason: StopReason = 'unknown';

    for await (const frame of readSSE(body, signal)) {
      const event = parseEvent(frame.data);
      if (!event) continue;

      switch (event.type) {
        case 'message_start': {
          if (!event.message?.usage) break;
          usage = mergeUsage(usage, event.message.usage);
          onEvent({ type: 'usage', usage });
          break;
        }

        case 'content_block_start': {
          const block = startBlock(event);
          if (!block) break;

          blocks.set(event.index ?? 0, block);
          if (block.kind === 'tool_use') {
            onEvent({ type: 'tool_use_start', id: block.id, name: block.name });
          } else if (block.kind === 'text' && block.text) {
            onEvent({ type: 'text_delta', text: block.text });
          }
          break;
        }

        case 'content_block_delta': {
          const block = blocks.get(event.index ?? 0);
          if (block) applyDelta(block, event, onEvent);
          break;
        }

        case 'content_block_stop': {
          const block = blocks.get(event.index ?? 0);
          if (block?.kind === 'tool_use') {
            onEvent({
              type: 'tool_use_end',
              id: block.id,
              name: block.name,
              input: parseToolInput(block.inputJson),
            });
          }
          break;
        }

        case 'message_delta': {
          if (event.delta?.stop_reason) stopReason = toStopReason(event.delta.stop_reason);
          if (event.usage) {
            usage = mergeUsage(usage, event.usage);
            onEvent({ type: 'usage', usage });
          }
          break;
        }

        case 'error':
          throw streamError(event);

        default:
          break;
      }
    }

    return { message: assembleMessage(blocks), stopReason, usage };
  }
}

function toWireRequest(request: CompletionRequest): Record<string, unknown> {
  const lastToolIndex = request.tools.length - 1;

  return {
    model: request.model,
    max_tokens: request.maxTokens,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    stream: true,
    system: [{ type: 'text', text: request.system, cache_control: EPHEMERAL_CACHE }],
    tools: request.tools.map((tool, index) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
      ...(index === lastToolIndex ? { cache_control: EPHEMERAL_CACHE } : {}),
    })),
    messages: request.messages.map(toWireMessage),
  };
}

function toWireMessage(message: Message): Record<string, unknown> {
  return {
    role: message.role,
    content: message.content.map((block) => {
      switch (block.type) {
        case 'text':
          return { type: 'text', text: block.text };
        case 'thinking':
          return {
            type: 'thinking',
            thinking: block.thinking,
            ...(block.signature ? { signature: block.signature } : {}),
          };
        case 'tool_use':
          return { type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} };
        case 'tool_result':
          return {
            type: 'tool_result',
            tool_use_id: block.toolUseId,
            content: block.content,
            is_error: block.isError,
          };
      }
    }),
  };
}

function parseEvent(data: string): WireEvent | null {
  if (!data) return null;
  try {
    return JSON.parse(data) as WireEvent;
  } catch {
    return null;
  }
}

function startBlock(event: WireEvent): PartialBlock | null {
  const block = event.content_block;
  if (!block) return null;

  const kind: BlockKind =
    block.type === 'tool_use' ? 'tool_use' : block.type === 'thinking' ? 'thinking' : 'text';

  return {
    kind,
    text: block.text ?? '',
    thinking: block.thinking ?? '',
    signature: undefined,
    id: block.id ?? '',
    name: block.name ?? '',
    inputJson: '',
  };
}

function applyDelta(
  block: PartialBlock,
  event: WireEvent,
  onEvent: (event: StreamEvent) => void,
): void {
  const delta = event.delta;
  if (!delta) return;

  switch (delta.type) {
    case 'text_delta':
      if (typeof delta.text !== 'string') return;
      block.text += delta.text;
      onEvent({ type: 'text_delta', text: delta.text });
      return;

    case 'thinking_delta':
      if (typeof delta.thinking !== 'string') return;
      block.thinking += delta.thinking;
      onEvent({ type: 'thinking_delta', text: delta.thinking });
      return;

    case 'signature_delta':
      if (typeof delta.signature !== 'string') return;
      block.signature = (block.signature ?? '') + delta.signature;
      return;

    case 'input_json_delta':
      if (typeof delta.partial_json !== 'string') return;
      block.inputJson += delta.partial_json;
      onEvent({ type: 'tool_use_input_delta', id: block.id, partialJson: delta.partial_json });
      return;

    default:
      return;
  }
}

function assembleMessage(blocks: Map<number, PartialBlock>): Message {
  const indexes = [...blocks.keys()].sort((a, b) => a - b);
  const content: ContentBlock[] = [];

  for (const index of indexes) {
    const block = blocks.get(index);
    if (!block) continue;

    if (block.kind === 'text' && block.text) {
      content.push({ type: 'text', text: block.text });
    } else if (block.kind === 'thinking' && block.thinking) {
      content.push({
        type: 'thinking',
        thinking: block.thinking,
        ...(block.signature ? { signature: block.signature } : {}),
      });
    } else if (block.kind === 'tool_use') {
      content.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: parseToolInput(block.inputJson),
      });
    }
  }

  return { role: 'assistant', content };
}

function mergeUsage(current: Usage, wire: WireUsage): Usage {
  return {
    inputTokens: wire.input_tokens ?? current.inputTokens,
    outputTokens: wire.output_tokens ?? current.outputTokens,
    cacheReadTokens: wire.cache_read_input_tokens ?? current.cacheReadTokens,
    cacheWriteTokens: wire.cache_creation_input_tokens ?? current.cacheWriteTokens,
  };
}

function toStopReason(reason: string): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'stop_sequence':
      return reason;
    default:
      return 'unknown';
  }
}

function streamError(event: WireEvent): ProviderError {
  const message = event.error?.message ?? 'The provider reported an error mid-stream.';
  const type = event.error?.type ?? '';
  return new ProviderError(message, {
    retryable: type === 'overloaded_error' || type === 'api_error',
  });
}

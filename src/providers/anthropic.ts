import { AuthError, ProviderError, isAbort } from '../util/errors.js';
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

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';
const MAX_ATTEMPTS = 4;

export interface AnthropicOptions {
  apiKey: string | undefined;
  baseUrl?: string | undefined;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests so retries do not really sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Wire types (only the fields we actually consume)                           */
/* -------------------------------------------------------------------------- */

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

/** Partial state for one streaming content block. */
interface BlockState {
  type: 'text' | 'thinking' | 'tool_use';
  text: string;
  thinking: string;
  signature: string | undefined;
  id: string;
  name: string;
  json: string;
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
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: AnthropicOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async complete(
    request: CompletionRequest,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    if (!this.apiKey) {
      throw new AuthError(
        'No Anthropic API key found. Set ANTHROPIC_API_KEY in your environment or run `sable auth`.',
      );
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.attempt(request, onEvent, signal);
      } catch (error) {
        lastError = error;
        if (isAbort(error)) throw error;
        const retryable = error instanceof ProviderError && error.retryable;
        if (!retryable || attempt === MAX_ATTEMPTS) throw error;
        const backoff = Math.min(30_000, 500 * 2 ** (attempt - 1)) + Math.random() * 250;
        await this.sleep(backoff);
      }
    }
    throw lastError;
  }

  private async attempt(
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
      body: JSON.stringify(this.buildBody(request)),
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      throw await toProviderError(response);
    }
    if (!response.body) {
      throw new ProviderError('The provider returned an empty response body.', { retryable: true });
    }

    return this.consume(response.body, onEvent, signal);
  }

  private buildBody(request: CompletionRequest): Record<string, unknown> {
    const tools = request.tools.map((tool, index) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
      // Cache the tool definitions; they are stable across a whole session.
      ...(index === request.tools.length - 1
        ? { cache_control: { type: 'ephemeral' as const } }
        : {}),
    }));

    return {
      model: request.model,
      max_tokens: request.maxTokens,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      stream: true,
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
      tools,
      messages: request.messages.map(toWireMessage),
    };
  }

  private async consume(
    body: ReadableStream<Uint8Array>,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    const blocks = new Map<number, BlockState>();
    let usage: Usage = { ...EMPTY_USAGE };
    let stopReason: StopReason = 'unknown';

    for await (const frame of readSSE(body, signal)) {
      if (!frame.data) continue;
      let event: WireEvent;
      try {
        event = JSON.parse(frame.data) as WireEvent;
      } catch {
        continue; // A malformed keep-alive is not worth killing the turn over.
      }

      switch (event.type) {
        case 'message_start': {
          const wire = event.message?.usage;
          if (wire) {
            usage = mergeUsage(usage, wire);
            onEvent({ type: 'usage', usage });
          }
          break;
        }

        case 'content_block_start': {
          const index = event.index ?? 0;
          const block = event.content_block;
          if (!block) break;
          const state: BlockState = {
            type:
              block.type === 'tool_use'
                ? 'tool_use'
                : block.type === 'thinking'
                  ? 'thinking'
                  : 'text',
            text: block.text ?? '',
            thinking: block.thinking ?? '',
            signature: undefined,
            id: block.id ?? '',
            name: block.name ?? '',
            json: '',
          };
          blocks.set(index, state);
          if (state.type === 'tool_use') {
            onEvent({ type: 'tool_use_start', id: state.id, name: state.name });
          } else if (state.type === 'text' && state.text) {
            onEvent({ type: 'text_delta', text: state.text });
          }
          break;
        }

        case 'content_block_delta': {
          const index = event.index ?? 0;
          const state = blocks.get(index);
          const delta = event.delta;
          if (!state || !delta) break;
          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            state.text += delta.text;
            onEvent({ type: 'text_delta', text: delta.text });
          } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            state.thinking += delta.thinking;
            onEvent({ type: 'thinking_delta', text: delta.thinking });
          } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
            state.signature = (state.signature ?? '') + delta.signature;
          } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            state.json += delta.partial_json;
            onEvent({
              type: 'tool_use_input_delta',
              id: state.id,
              partialJson: delta.partial_json,
            });
          }
          break;
        }

        case 'content_block_stop': {
          const state = blocks.get(event.index ?? 0);
          if (state?.type === 'tool_use') {
            onEvent({
              type: 'tool_use_end',
              id: state.id,
              name: state.name,
              input: parseToolInput(state.json),
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

        case 'error': {
          const message = event.error?.message ?? 'The provider reported an error mid-stream.';
          const type = event.error?.type ?? '';
          throw new ProviderError(message, {
            retryable: type === 'overloaded_error' || type === 'api_error',
          });
        }

        default:
          break;
      }
    }

    return { message: assemble(blocks), stopReason, usage };
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function assemble(blocks: Map<number, BlockState>): Message {
  const content: ContentBlock[] = [];
  for (const index of [...blocks.keys()].sort((a, b) => a - b)) {
    const state = blocks.get(index);
    if (!state) continue;
    if (state.type === 'text') {
      if (state.text) content.push({ type: 'text', text: state.text });
    } else if (state.type === 'thinking') {
      if (state.thinking) {
        content.push({
          type: 'thinking',
          thinking: state.thinking,
          ...(state.signature ? { signature: state.signature } : {}),
        });
      }
    } else {
      content.push({
        type: 'tool_use',
        id: state.id,
        name: state.name,
        input: parseToolInput(state.json),
      });
    }
  }
  return { role: 'assistant', content };
}

function parseToolInput(json: string): unknown {
  const trimmed = json.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    // Surface the raw text so the tool layer can produce a useful error message.
    return { __malformed_json__: trimmed };
  }
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

async function toProviderError(response: Response): Promise<ProviderError> {
  let detail = '';
  try {
    const body = await response.text();
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      detail = parsed.error?.message ?? body;
    } catch {
      detail = body;
    }
  } catch {
    detail = response.statusText;
  }

  if (response.status === 401 || response.status === 403) {
    return new ProviderError(`Authentication failed (${response.status}). ${detail}`.trim(), {
      status: response.status,
    });
  }

  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  const prefix = response.status === 429 ? 'Rate limited' : `Request failed (${response.status})`;
  return new ProviderError(`${prefix}. ${detail}`.trim(), { status: response.status, retryable });
}

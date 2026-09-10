/**
 * Provider-agnostic message and streaming types.
 *
 * The agent loop only ever speaks this vocabulary; each provider adapter
 * translates to and from its own wire format.
 */

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError: boolean;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema describing the tool's input object. */
  parameters: Record<string, unknown>;
}

export interface CompletionRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  model: string;
  maxTokens: number;
  temperature?: number | undefined;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'unknown';

/** Incremental events emitted while a completion streams in. */
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_input_delta'; id: string; partialJson: string }
  | { type: 'tool_use_end'; id: string; name: string; input: unknown }
  | { type: 'usage'; usage: Usage };

export interface CompletionResult {
  /** The assistant message, assembled from the stream. */
  message: Message;
  stopReason: StopReason;
  usage: Usage;
}

export interface Provider {
  /** Stable identifier, e.g. `anthropic`. */
  readonly id: string;
  /** Human-readable name for help output. */
  readonly label: string;
  /** Models this adapter is known to work with; informational only. */
  readonly knownModels: readonly string[];

  complete(
    request: CompletionRequest,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<CompletionResult>;
}

/* -------------------------------------------------------------------------- */
/* Small helpers for working with content blocks                              */
/* -------------------------------------------------------------------------- */

export function textOf(message: Message): string {
  return message.content
    .filter((block): block is TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

export function toolUsesOf(message: Message): ToolUseBlock[] {
  return message.content.filter((block): block is ToolUseBlock => block.type === 'tool_use');
}

export function userText(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

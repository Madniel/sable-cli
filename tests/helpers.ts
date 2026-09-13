import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Session } from '../src/agent/session.js';
import { DEFAULT_CONFIG, DEFAULT_MODELS, type Config } from '../src/config/config.js';
import type {
  CompletionRequest,
  CompletionResult,
  Provider,
  StreamEvent,
  Usage,
} from '../src/providers/types.js';
import { FileTracker } from '../src/tools/file-tracker.js';
import type { ConfirmOutcome, ConfirmRequest, ToolContext } from '../src/tools/types.js';

export interface TestContext extends ToolContext {
  confirmations: ConfirmRequest[];
}

export function tempWorkspace(files: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sable-test-'));

  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }

  return root;
}

export function testConfig(root: string, overrides: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    model: DEFAULT_MODELS['anthropic'] as string,
    apiKey: 'test-key',
    baseUrl: undefined,
    workspaceRoot: root,
    persistSessions: false,
    ...overrides,
  };
}

export function testSession(root: string, model = 'test-model'): Session {
  return new Session({ provider: 'scripted', model, workspaceRoot: root });
}

export interface TestContextOptions {
  answer?: ConfirmOutcome;
  config?: Partial<Config>;
  files?: FileTracker;
  signal?: AbortSignal;
}

export function testContext(root: string, options: TestContextOptions = {}): TestContext {
  const confirmations: ConfirmRequest[] = [];

  return {
    config: testConfig(root, options.config ?? {}),
    root,
    signal: options.signal ?? new AbortController().signal,
    files: options.files ?? new FileTracker(),
    async confirm(request: ConfirmRequest): Promise<ConfirmOutcome> {
      confirmations.push(request);
      return options.answer ?? 'once';
    },
    progress(): void {},
    confirmations,
  };
}

export const TEST_USAGE: Usage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export class ScriptedProvider implements Provider {
  readonly id = 'scripted';
  readonly label = 'Scripted';
  readonly knownModels = ['test-model'] as const;
  readonly requests: CompletionRequest[] = [];

  constructor(private readonly script: CompletionResult[]) {}

  async complete(
    request: CompletionRequest,
    onEvent: (event: StreamEvent) => void,
  ): Promise<CompletionResult> {
    this.requests.push(structuredClone(request));

    const next = this.script.shift();
    if (!next) throw new Error('ScriptedProvider ran out of scripted responses');

    for (const block of next.message.content) {
      if (block.type === 'text') onEvent({ type: 'text_delta', text: block.text });
    }

    return next;
  }
}

export function reply(text: string): CompletionResult {
  return {
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    stopReason: 'end_turn',
    usage: TEST_USAGE,
  };
}

export function callTool(id: string, name: string, input: unknown): CompletionResult {
  return {
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    stopReason: 'tool_use',
    usage: TEST_USAGE,
  };
}

export function sseResponse(events: object[], eventName?: (event: object) => string): Response {
  const body = events
    .map((event) => {
      const name = eventName ? eventName(event) : ((event as { type?: string }).type ?? 'message');
      return `event: ${name}\ndata: ${JSON.stringify(event)}\n\n`;
    })
    .join('');

  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

export function dataOnlyResponse(payloads: (object | string)[]): Response {
  const body = payloads
    .map(
      (payload) => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`,
    )
    .join('');

  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

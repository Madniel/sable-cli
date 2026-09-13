import type { ApprovalPolicy } from '../approval/policy.js';
import type { Config } from '../config/config.js';
import {
  EMPTY_USAGE,
  addUsage,
  textOf,
  toolUsesOf,
  userText,
  type ContentBlock,
  type Provider,
  type StopReason,
  type ToolUseBlock,
  type Usage,
} from '../providers/types.js';
import { FileTracker } from '../tools/file-tracker.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { Tool, ToolContext, ToolKind, ToolResult } from '../tools/types.js';
import { AbortError, errorMessage, isAbort, isDenial } from '../util/errors.js';
import { compactSession, shouldCompact, type CompactionResult } from './compaction.js';
import { buildSystemPrompt } from './prompt.js';
import type { Session } from './session.js';

const DISPLAY_LINE_LENGTH = 100;

export interface ToolStartEvent {
  id: string;
  name: string;
  summary: string;
}

export interface ToolEndEvent {
  id: string;
  name: string;
  summary: string;
  ok: boolean;
  display: string;
  durationMs: number;
}

export interface AgentEvents {
  onStep?(step: number, maxSteps: number): void;
  onText?(delta: string): void;
  onThinking?(delta: string): void;
  onToolStart?(event: ToolStartEvent): void;
  onToolEnd?(event: ToolEndEvent): void;
  onUsage?(usage: Usage): void;
  onCompaction?(result: CompactionResult): void;
  onNotice?(message: string): void;
}

export interface TurnResult {
  text: string;
  steps: number;
  usage: Usage;
  stopReason: StopReason;
  exhausted: boolean;
}

export interface AgentOptions {
  config: Config;
  provider: Provider;
  tools: ToolRegistry;
  approval: ApprovalPolicy;
  session: Session;
  files?: FileTracker;
  onTurnComplete?: (session: Session) => void;
}

export class Agent {
  private readonly config: Config;
  private readonly provider: Provider;
  private readonly tools: ToolRegistry;
  private readonly approval: ApprovalPolicy;
  private readonly session: Session;
  private readonly files: FileTracker;
  private readonly onTurnComplete: ((session: Session) => void) | undefined;

  constructor(options: AgentOptions) {
    this.config = options.config;
    this.provider = options.provider;
    this.tools = options.tools;
    this.approval = options.approval;
    this.session = options.session;
    this.files = options.files ?? new FileTracker();
    this.onTurnComplete = options.onTurnComplete;
  }

  async run(input: string, events: AgentEvents = {}, signal?: AbortSignal): Promise<TurnResult> {
    const controller = linkedController(signal);

    await this.compactIfNeeded(events, controller.signal);

    this.session.append(userText(input));
    this.session.countTurn();

    const system = buildSystemPrompt({ config: this.config, tools: this.tools });
    let usage: Usage = { ...EMPTY_USAGE };
    let stopReason: StopReason = 'unknown';
    let step = 0;

    try {
      while (step < this.config.maxSteps) {
        step++;
        events.onStep?.(step, this.config.maxSteps);

        if (controller.signal.aborted) throw new AbortError();

        const completion = await this.provider.complete(
          {
            system,
            messages: this.session.history(),
            tools: this.tools.specs(),
            model: this.session.getModel(),
            maxTokens: this.config.maxTokens,
            temperature: this.config.temperature,
          },
          (event) => forwardStreamEvent(event, events),
          controller.signal,
        );

        usage = addUsage(usage, completion.usage);
        stopReason = completion.stopReason;
        this.session.recordUsage(completion.usage);
        this.session.append(completion.message);

        const calls = toolUsesOf(completion.message);

        if (calls.length === 0) {
          this.onTurnComplete?.(this.session);
          return {
            text: textOf(completion.message).trim(),
            steps: step,
            usage,
            stopReason,
            exhausted: false,
          };
        }

        const results = await this.executeCalls(calls, events, controller.signal);
        this.session.append({ role: 'user', content: results });
      }

      events.onNotice?.(
        `Stopped after ${this.config.maxSteps} steps without finishing. ` +
          'Ask me to continue, or raise --max-steps.',
      );

      this.onTurnComplete?.(this.session);

      return {
        text: this.lastAssistantText(),
        steps: step,
        usage,
        stopReason,
        exhausted: true,
      };
    } finally {
      controller.dispose();
    }
  }

  async compact(signal?: AbortSignal): Promise<CompactionResult> {
    return compactSession({
      session: this.session,
      provider: this.provider,
      config: this.config,
      ...(signal ? { signal } : {}),
    });
  }

  fileTracker(): FileTracker {
    return this.files;
  }

  private async compactIfNeeded(events: AgentEvents, signal: AbortSignal): Promise<void> {
    if (!shouldCompact(this.session, this.config)) return;

    try {
      const result = await this.compact(signal);
      if (result.compacted) events.onCompaction?.(result);
    } catch (error) {
      if (isAbort(error)) throw error;
      events.onNotice?.(`Could not compact the conversation: ${errorMessage(error)}`);
    }
  }

  private async executeCalls(
    calls: ToolUseBlock[],
    events: AgentEvents,
    signal: AbortSignal,
  ): Promise<ContentBlock[]> {
    const results: ContentBlock[] = [];

    for (const call of calls) {
      if (signal.aborted) {
        results.push(toolResult(call.id, 'Cancelled by the user before this tool ran.', true));
        continue;
      }

      results.push(await this.executeCall(call, events, signal));
    }

    return results;
  }

  private async executeCall(
    call: ToolUseBlock,
    events: AgentEvents,
    signal: AbortSignal,
  ): Promise<ContentBlock> {
    const startedAt = Date.now();
    const tool = this.tools.get(call.name);

    let params: Record<string, unknown>;
    let summary = call.name;

    try {
      params = this.tools.validateInput(call.name, call.input);
      summary = tool ? tool.summarize(params) : call.name;
    } catch (error) {
      const message = errorMessage(error);
      events.onToolStart?.({ id: call.id, name: call.name, summary });
      events.onToolEnd?.({
        id: call.id,
        name: call.name,
        summary,
        ok: false,
        display: message,
        durationMs: Date.now() - startedAt,
      });
      return toolResult(call.id, message, true);
    }

    events.onToolStart?.({ id: call.id, name: call.name, summary });

    const outcome = await this.invokeTool(tool as Tool, params, summary, signal);

    events.onToolEnd?.({
      id: call.id,
      name: call.name,
      summary,
      ok: !outcome.isError,
      display: outcome.display ?? firstLine(outcome.output),
      durationMs: Date.now() - startedAt,
    });

    return toolResult(call.id, outcome.output || '(no output)', outcome.isError === true);
  }

  private async invokeTool(
    tool: Tool,
    params: Record<string, unknown>,
    summary: string,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const context: ToolContext = {
      config: this.config,
      root: this.config.workspaceRoot,
      signal,
      files: this.files,
      confirm: (request) => this.approval.confirm(request),
      progress: () => {},
    };

    try {
      return await tool.run(params, context);
    } catch (error) {
      if (isAbort(error)) throw error;

      if (isDenial(error)) {
        return {
          output: this.approval.denialReason({
            toolName: tool.name,
            kind: tool.kind as ToolKind,
            summary,
          }),
          isError: true,
        };
      }

      return { output: `${tool.name} failed: ${errorMessage(error)}`, isError: true };
    }
  }

  private lastAssistantText(): string {
    const history = this.session.history();

    for (let index = history.length - 1; index >= 0; index--) {
      const message = history[index];
      if (message?.role !== 'assistant') continue;

      const text = textOf(message).trim();
      if (text) return text;
    }

    return '';
  }
}

interface LinkedController {
  signal: AbortSignal;
  dispose(): void;
}

function linkedController(signal: AbortSignal | undefined): LinkedController {
  const controller = new AbortController();

  if (signal?.aborted) {
    controller.abort();
    return { signal: controller.signal, dispose: () => {} };
  }

  const forward = () => controller.abort();
  signal?.addEventListener('abort', forward, { once: true });

  return {
    signal: controller.signal,
    dispose: () => signal?.removeEventListener('abort', forward),
  };
}

function forwardStreamEvent(
  event: { type: string; text?: string; usage?: Usage },
  events: AgentEvents,
): void {
  if (event.type === 'text_delta' && event.text !== undefined) events.onText?.(event.text);
  else if (event.type === 'thinking_delta' && event.text !== undefined) {
    events.onThinking?.(event.text);
  } else if (event.type === 'usage' && event.usage) events.onUsage?.(event.usage);
}

function toolResult(toolUseId: string, content: string, isError: boolean): ContentBlock {
  return { type: 'tool_result', toolUseId, content, isError };
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > DISPLAY_LINE_LENGTH ? `${line.slice(0, DISPLAY_LINE_LENGTH - 3)}...` : line;
}

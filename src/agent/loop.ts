import { ApprovalPolicy } from '../approval/policy.js';
import type { Config } from '../config/config.js';
import type { Provider, StopReason, ToolUseBlock, Usage } from '../providers/types.js';
import { EMPTY_USAGE, addUsage, textOf, toolUsesOf, userText } from '../providers/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ContentBlock } from '../providers/types.js';
import type { ToolContext, ToolResult } from '../tools/types.js';
import { AbortError, SableError, errorMessage, isAbort } from '../util/errors.js';
import { buildSystemPrompt } from './prompt.js';
import type { Session } from './session.js';

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

/** UI hooks. Every one is optional; the loop works headless with none of them. */
export interface AgentEvents {
  onStep?(step: number, maxSteps: number): void;
  onText?(delta: string): void;
  onThinking?(delta: string): void;
  onToolStart?(event: ToolStartEvent): void;
  onToolEnd?(event: ToolEndEvent): void;
  onUsage?(usage: Usage): void;
  /** Out-of-band note for the user (retries, limits reached). */
  onNotice?(message: string): void;
}

export interface TurnResult {
  /** The assistant's final prose for this turn. */
  text: string;
  steps: number;
  usage: Usage;
  stopReason: StopReason;
  /** True when the loop stopped because it hit `maxSteps`. */
  exhausted: boolean;
}

export interface AgentOptions {
  config: Config;
  provider: Provider;
  tools: ToolRegistry;
  approval: ApprovalPolicy;
  session: Session;
}

export class Agent {
  private readonly config: Config;
  private readonly provider: Provider;
  private readonly tools: ToolRegistry;
  private readonly approval: ApprovalPolicy;
  private readonly session: Session;

  constructor(options: AgentOptions) {
    this.config = options.config;
    this.provider = options.provider;
    this.tools = options.tools;
    this.approval = options.approval;
    this.session = options.session;
  }

  /**
   * Run one user turn to completion: call the model, execute whatever tools it
   * asks for, feed the results back, and repeat until it stops asking.
   */
  async run(input: string, events: AgentEvents = {}, signal?: AbortSignal): Promise<TurnResult> {
    const controller = new AbortController();
    const forward = () => controller.abort();
    // An already-aborted signal never fires its event, so mirror the state first.
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', forward, { once: true });

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

        const result = await this.provider.complete(
          {
            system,
            messages: this.session.history(),
            tools: this.tools.specs(),
            model: this.session.getModel(),
            maxTokens: this.config.maxTokens,
            temperature: this.config.temperature,
          },
          (event) => {
            switch (event.type) {
              case 'text_delta':
                events.onText?.(event.text);
                break;
              case 'thinking_delta':
                events.onThinking?.(event.text);
                break;
              case 'usage':
                events.onUsage?.(event.usage);
                break;
              default:
                break;
            }
          },
          controller.signal,
        );

        usage = addUsage(usage, result.usage);
        this.session.recordUsage(result.usage);
        stopReason = result.stopReason;
        this.session.append(result.message);

        const calls = toolUsesOf(result.message);
        if (calls.length === 0) {
          return {
            text: textOf(result.message).trim(),
            steps: step,
            usage,
            stopReason,
            exhausted: false,
          };
        }

        const resultBlocks = await this.executeCalls(calls, events, controller.signal);
        this.session.append({ role: 'user', content: resultBlocks });
      }

      events.onNotice?.(
        `Stopped after ${this.config.maxSteps} steps without finishing. ` +
          'Ask me to continue, or raise --max-steps.',
      );

      return {
        text: lastAssistantText(this.session),
        steps: step,
        usage,
        stopReason,
        exhausted: true,
      };
    } finally {
      signal?.removeEventListener('abort', forward);
    }
  }

  private async executeCalls(
    calls: ToolUseBlock[],
    events: AgentEvents,
    signal: AbortSignal,
  ): Promise<ContentBlock[]> {
    const blocks: ContentBlock[] = [];

    for (const call of calls) {
      if (signal.aborted) {
        blocks.push({
          type: 'tool_result',
          toolUseId: call.id,
          content: 'Cancelled by the user before this tool ran.',
          isError: true,
        });
        continue;
      }

      const started = Date.now();
      const tool = this.tools.get(call.name);
      let summary = call.name;
      let params: Record<string, unknown> = {};

      try {
        params = this.tools.validateInput(call.name, call.input);
        summary = tool ? tool.summarize(params) : call.name;
      } catch (error) {
        events.onToolStart?.({ id: call.id, name: call.name, summary });
        events.onToolEnd?.({
          id: call.id,
          name: call.name,
          summary,
          ok: false,
          display: errorMessage(error),
          durationMs: Date.now() - started,
        });
        blocks.push({
          type: 'tool_result',
          toolUseId: call.id,
          content: errorMessage(error),
          isError: true,
        });
        continue;
      }

      events.onToolStart?.({ id: call.id, name: call.name, summary });

      const context: ToolContext = {
        config: this.config,
        root: this.config.workspaceRoot,
        signal,
        confirm: (request) => this.approval.confirm(request),
        progress: (line) => events.onNotice?.(line),
      };

      let outcome: ToolResult;
      try {
        // `tool` is defined here: validateInput would have thrown otherwise.
        outcome = await (tool as NonNullable<typeof tool>).run(params, context);
      } catch (error) {
        if (isAbort(error)) throw error;
        const message =
          error instanceof SableError && error.code === 'TOOL_DENIED'
            ? this.approval.denialReason({
                toolName: call.name,
                kind: (tool?.kind ?? 'write') as 'read' | 'write' | 'execute',
                summary,
              })
            : `${call.name} failed: ${errorMessage(error)}`;
        outcome = { output: message, isError: true };
      }

      events.onToolEnd?.({
        id: call.id,
        name: call.name,
        summary,
        ok: !outcome.isError,
        display: outcome.display ?? firstLine(outcome.output),
        durationMs: Date.now() - started,
      });

      blocks.push({
        type: 'tool_result',
        toolUseId: call.id,
        content: outcome.output || '(no output)',
        isError: outcome.isError === true,
      });
    }

    return blocks;
  }
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > 100 ? `${line.slice(0, 97)}...` : line;
}

function lastAssistantText(session: Session): string {
  const history = session.history();
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message?.role !== 'assistant') continue;
    const text = textOf(message).trim();
    if (text) return text;
  }
  return '';
}

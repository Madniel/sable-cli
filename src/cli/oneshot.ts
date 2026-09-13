import { Agent, type AgentEvents } from '../agent/loop.js';
import type { Session } from '../agent/session.js';
import { saveSnapshot } from '../agent/store.js';
import { ApprovalPolicy } from '../approval/policy.js';
import type { Config } from '../config/config.js';
import type { Provider } from '../providers/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { style } from '../util/ansi.js';
import { errorMessage, isAbort } from '../util/errors.js';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_EXHAUSTED = 2;
export const EXIT_INTERRUPTED = 130;

export interface OneShotOptions {
  config: Config;
  provider: Provider;
  tools: ToolRegistry;
  session: Session;
  prompt: string;
  json: boolean;
}

export async function runOneShot(options: OneShotOptions): Promise<number> {
  const { config, provider, tools, session, prompt, json } = options;

  const approval = new ApprovalPolicy(config.approval, null);
  const agent = new Agent({
    config,
    provider,
    tools,
    approval,
    session,
    onTurnComplete: (completed) => persist(completed, config),
  });

  const controller = new AbortController();
  const cancel = () => controller.abort();

  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);

  try {
    const result = await agent.run(prompt, json ? jsonEvents() : textEvents(), controller.signal);

    if (json) {
      const totals = session.totals();
      emit({
        type: 'result',
        text: result.text,
        steps: result.steps,
        stopReason: result.stopReason,
        exhausted: result.exhausted,
        usage: totals.usage,
        costUsd: Number(totals.costUsd.toFixed(6)),
        sessionId: session.id,
      });
    } else if (result.text) {
      process.stdout.write(`${result.text}\n`);
    }

    return result.exhausted ? EXIT_EXHAUSTED : EXIT_OK;
  } catch (error) {
    if (isAbort(error)) {
      process.stderr.write(`${style.yellow('interrupted')}\n`);
      return EXIT_INTERRUPTED;
    }

    const message = errorMessage(error);
    if (json) emit({ type: 'error', message });
    else process.stderr.write(`${style.red('error: ')}${message}\n`);

    return EXIT_FAILED;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));

  return Buffer.concat(chunks).toString('utf8').trim();
}

function emit(event: object): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function jsonEvents(): AgentEvents {
  return {
    onToolStart: ({ name, summary }) => emit({ type: 'tool_start', name, summary }),
    onToolEnd: ({ name, ok, display, durationMs }) =>
      emit({ type: 'tool_end', name, ok, display, durationMs }),
    onCompaction: (result) =>
      emit({
        type: 'compaction',
        removedMessages: result.removedMessages,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
      }),
    onNotice: (message) => emit({ type: 'notice', message }),
  };
}

function textEvents(): AgentEvents {
  return {
    onToolStart: ({ name, summary }) =>
      process.stderr.write(`${style.gray(`› ${name} ${summary}`)}\n`),
    onToolEnd: ({ ok, display }) =>
      process.stderr.write(
        `${ok ? style.green('  ✓ ') : style.red('  ✗ ')}${style.gray(display)}\n`,
      ),
    onCompaction: (result) =>
      process.stderr.write(
        `${style.yellow(`! context compacted (${result.removedMessages} messages)`)}\n`,
      ),
    onNotice: (message) => process.stderr.write(`${style.yellow(`! ${message}`)}\n`),
  };
}

function persist(session: Session, config: Config): void {
  if (!config.persistSessions) return;

  try {
    saveSnapshot(session.snapshot());
  } catch {
    return;
  }
}

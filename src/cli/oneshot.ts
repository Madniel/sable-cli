import { Agent, type AgentEvents } from '../agent/loop.js';
import { Session } from '../agent/session.js';
import { ApprovalPolicy } from '../approval/policy.js';
import type { Config } from '../config/config.js';
import type { Provider } from '../providers/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { style } from '../util/ansi.js';
import { errorMessage, isAbort } from '../util/errors.js';

export interface OneShotOptions {
  config: Config;
  provider: Provider;
  tools: ToolRegistry;
  session: Session;
  prompt: string;
  /** Emit newline-delimited JSON events instead of prose. */
  json: boolean;
}

/**
 * Non-interactive run: no approval prompts exist, so anything needing one is
 * refused by the policy. Prose goes to stdout, progress to stderr, so the
 * output stays pipeable.
 */
export async function runOneShot(options: OneShotOptions): Promise<number> {
  const { config, provider, tools, session, prompt, json } = options;

  const approval = new ApprovalPolicy(config.approval, null);
  const agent = new Agent({ config, provider, tools, approval, session });

  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const emit = (event: object) => process.stdout.write(`${JSON.stringify(event)}\n`);

  const events: AgentEvents = json
    ? {
        onToolStart: ({ name, summary }) => emit({ type: 'tool_start', name, summary }),
        onToolEnd: ({ name, ok, display, durationMs }) =>
          emit({ type: 'tool_end', name, ok, display, durationMs }),
        onNotice: (message) => emit({ type: 'notice', message }),
      }
    : {
        onToolStart: ({ name, summary }) =>
          process.stderr.write(`${style.gray(`› ${name} ${summary}`)}\n`),
        onToolEnd: ({ ok, display }) =>
          process.stderr.write(
            `${ok ? style.green('  ✓ ') : style.red('  ✗ ')}${style.gray(display)}\n`,
          ),
        onNotice: (message) => process.stderr.write(`${style.yellow(`! ${message}`)}\n`),
      };

  try {
    const result = await agent.run(prompt, events, controller.signal);

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
      });
    } else if (result.text) {
      process.stdout.write(`${result.text}\n`);
    }

    return result.exhausted ? 2 : 0;
  } catch (error) {
    if (isAbort(error)) {
      process.stderr.write(`${style.yellow('interrupted')}\n`);
      return 130;
    }
    if (json) emit({ type: 'error', message: errorMessage(error) });
    else process.stderr.write(`${style.red('error: ')}${errorMessage(error)}\n`);
    return 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

/** Read a piped prompt from stdin, if any. */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').trim();
}

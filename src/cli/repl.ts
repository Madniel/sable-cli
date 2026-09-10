import readline from 'node:readline';

import { Agent, type AgentEvents } from '../agent/loop.js';
import { formatCost } from '../agent/pricing.js';
import { Session } from '../agent/session.js';
import { ApprovalPolicy, type ApprovalPrompt } from '../approval/policy.js';
import type { Config } from '../config/config.js';
import type { Provider } from '../providers/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ConfirmOutcome, ConfirmRequest } from '../tools/types.js';
import { style } from '../util/ansi.js';
import { errorMessage, isAbort } from '../util/errors.js';
import { tildify } from '../util/paths.js';
import {
  Spinner,
  StreamRenderer,
  banner,
  indentDetail,
  notice,
  toolEndLine,
  toolStartLine,
} from './render.js';
import { commandNames, handleSlash } from './slash.js';

export interface ReplOptions {
  config: Config;
  provider: Provider;
  tools: ToolRegistry;
  session: Session;
  /** Prompt to run immediately on start, before handing over to the user. */
  initialPrompt?: string | undefined;
}

export class Repl implements ApprovalPrompt {
  private readonly config: Config;
  private readonly provider: Provider;
  private readonly tools: ToolRegistry;
  private readonly session: Session;
  private readonly approval: ApprovalPolicy;
  private readonly agent: Agent;
  private readonly rl: readline.Interface;

  private busy = false;
  private exiting = false;
  private queue: string[] = [];
  private controller: AbortController | null = null;
  private interruptArmed = false;

  constructor(options: ReplOptions) {
    this.config = options.config;
    this.provider = options.provider;
    this.tools = options.tools;
    this.session = options.session;
    this.approval = new ApprovalPolicy(this.config.approval, this);
    this.agent = new Agent({
      config: this.config,
      provider: this.provider,
      tools: this.tools,
      approval: this.approval,
      session: this.session,
    });

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: style.cyan('› '),
      historySize: 200,
      completer: (line: string) => this.complete(line),
    });

    if (options.initialPrompt) this.queue.push(options.initialPrompt);
  }

  async start(): Promise<number> {
    process.stdout.write(
      banner(this.session.getModel(), tildify(this.config.workspaceRoot), this.approval.getMode()),
    );

    this.rl.on('line', (line) => {
      this.interruptArmed = false;
      const trimmed = line.trim();
      if (this.busy) {
        if (trimmed) this.queue.push(trimmed);
        return;
      }
      void this.handle(trimmed);
    });

    this.rl.on('SIGINT', () => this.onInterrupt());

    const closed = new Promise<void>((resolve) => {
      this.rl.on('close', () => resolve());
    });

    if (this.queue.length > 0) {
      void this.drain();
    } else {
      this.rl.prompt();
    }

    await closed;
    this.printFarewell();
    return 0;
  }

  /* ---------------------------------------------------------------- input */

  private async handle(input: string): Promise<void> {
    if (this.exiting) return;

    if (!input) {
      this.rl.prompt();
      return;
    }

    if (
      handleSlash(input, {
        config: this.config,
        session: this.session,
        approval: this.approval,
        tools: this.tools,
        provider: this.provider,
        agent: this.agent,
        print: (text) => process.stdout.write(`${text}\n`),
        requestExit: () => {
          this.exiting = true;
          this.rl.close();
        },
      })
    ) {
      if (!this.exiting) this.rl.prompt();
      return;
    }

    await this.runTurn(input);
    await this.drain();
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && !this.exiting) {
      const next = this.queue.shift();
      if (!next) continue;
      process.stdout.write(`${style.cyan('› ')}${next}\n`);
      await this.runTurn(next);
    }
    if (!this.exiting) this.rl.prompt();
  }

  private async runTurn(input: string): Promise<void> {
    this.busy = true;
    this.controller = new AbortController();

    const spinner = new Spinner();
    const renderer = new StreamRenderer(process.stdout);
    let streaming = false;

    const events: AgentEvents = {
      onStep: () => spinner.start('thinking'),

      onText: (delta) => {
        if (!streaming) {
          spinner.stop();
          streaming = true;
          process.stdout.write('\n');
        }
        renderer.write(delta);
      },

      onToolStart: ({ name, summary }) => {
        spinner.stop();
        if (streaming) {
          renderer.end();
          streaming = false;
        }
        process.stdout.write(`${toolStartLine(name, summary)}\n`);
        spinner.start(`${name}…`);
      },

      onToolEnd: ({ ok, display, durationMs }) => {
        spinner.stop();
        process.stdout.write(`${toolEndLine(ok, display, durationMs)}\n`);
      },

      onNotice: (message) => {
        spinner.stop();
        process.stdout.write(`${notice(message)}\n`);
      },
    };

    try {
      await this.agent.run(input, events, this.controller.signal);
      if (streaming) renderer.end();
    } catch (error) {
      spinner.stop();
      if (streaming) renderer.end();
      if (isAbort(error)) {
        process.stdout.write(`${style.yellow('  interrupted')}\n`);
      } else {
        process.stdout.write(`${style.red('  error: ')}${errorMessage(error)}\n`);
      }
    } finally {
      spinner.stop();
      this.busy = false;
      this.controller = null;
    }
  }

  /* ------------------------------------------------------------ approvals */

  async ask(request: ConfirmRequest): Promise<ConfirmOutcome> {
    const lines = [
      '',
      `${style.yellow('?')} ${style.bold(request.summary)}`,
      ...(request.detail ? [indentDetail(request.detail)] : []),
      style.gray(`  [y] yes   [a] always allow ${request.toolName}   [n] no`),
    ];
    process.stdout.write(`${lines.join('\n')}\n`);

    const answer = await this.question(style.cyan('  › '));
    if (answer === null) return 'reject'; // input closed mid-question

    const normalized = answer.trim().toLowerCase();
    if (normalized === 'a' || normalized === 'always') return 'always';
    if (normalized === '' || normalized === 'y' || normalized === 'yes') return 'once';
    return 'reject';
  }

  /** Resolves to null if stdin closes while we are waiting, so EOF never reads as consent. */
  private question(prompt: string): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        this.rl.off('close', onClose);
        resolve(value);
      };
      const onClose = () => finish(null);

      this.rl.once('close', onClose);
      // rl.question consumes the next line without emitting a 'line' event,
      // so the main input handler stays out of the way here.
      this.rl.question(prompt, (answer) => finish(answer));
    });
  }

  /* ------------------------------------------------------------- controls */

  private onInterrupt(): void {
    if (this.busy && this.controller) {
      this.controller.abort();
      process.stdout.write(`\n${style.yellow('  interrupting…')}\n`);
      return;
    }

    if (this.interruptArmed) {
      this.exiting = true;
      this.rl.close();
      return;
    }

    this.interruptArmed = true;
    process.stdout.write(`\n${style.gray('  press Ctrl+C again to exit, or Ctrl+D')}\n`);
    this.rl.prompt();
  }

  private complete(line: string): [string[], string] {
    if (line.startsWith('/')) {
      const matches = commandNames().filter((name) => name.startsWith(line));
      return [matches.length ? matches : commandNames(), line];
    }
    return [[], line];
  }

  private printFarewell(): void {
    const { costUsd, turns } = this.session.totals();
    if (turns === 0) {
      process.stdout.write('\n');
      return;
    }
    process.stdout.write(
      `\n${style.gray(`${turns} turn${turns === 1 ? '' : 's'} · estimated ${formatCost(costUsd)}`)}\n`,
    );
  }
}

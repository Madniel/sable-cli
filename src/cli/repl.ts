import readline from 'node:readline';

import { Agent, type AgentEvents } from '../agent/loop.js';
import { formatCost } from '../agent/pricing.js';
import type { Session } from '../agent/session.js';
import { findSession, saveSnapshot } from '../agent/store.js';
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

const HISTORY_SIZE = 200;

export interface ReplOptions {
  config: Config;
  provider: Provider;
  tools: ToolRegistry;
  session: Session;
  initialPrompt?: string | undefined;
}

export class Repl implements ApprovalPrompt {
  private readonly config: Config;
  private readonly provider: Provider;
  private readonly tools: ToolRegistry;
  private readonly session: Session;
  private readonly approval: ApprovalPolicy;
  private readonly agent: Agent;
  private readonly input: readline.Interface;

  private busy = false;
  private exiting = false;
  private queued: string[] = [];
  private turnController: AbortController | null = null;
  private interruptArmed = false;
  private activeWork: Promise<void> = Promise.resolve();

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
      onTurnComplete: (session) => this.persist(session),
    });

    this.input = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: style.cyan('› '),
      historySize: HISTORY_SIZE,
      completer: (line: string) => this.complete(line),
    });

    if (options.initialPrompt) this.queued.push(options.initialPrompt);
  }

  async start(): Promise<number> {
    process.stdout.write(
      banner(
        this.session.getModel(),
        tildify(this.config.workspaceRoot),
        this.approval.getMode(),
        this.config.provider,
      ),
    );

    this.input.on('line', (line) => this.onLine(line));
    this.input.on('SIGINT', () => this.onInterrupt());

    const closed = new Promise<void>((resolve) =>
      this.input.on('close', () => {
        this.exiting = true;
        this.queued = [];
        this.turnController?.abort();
        resolve();
      }),
    );

    if (this.queued.length > 0) this.track(this.drainQueue());
    else this.input.prompt();

    await closed;
    await this.activeWork;
    this.printFarewell();

    return 0;
  }

  async ask(request: ConfirmRequest): Promise<ConfirmOutcome> {
    process.stdout.write(
      [
        '',
        `${style.yellow('?')} ${style.bold(request.summary)}`,
        ...(request.detail ? [indentDetail(request.detail)] : []),
        style.gray(`  [y] yes   [a] always allow ${request.toolName}   [n] no`),
        '',
      ].join('\n'),
    );

    const answer = await this.question(style.cyan('  › '));
    if (answer === null) return 'reject';

    const normalized = answer.trim().toLowerCase();
    if (normalized === 'a' || normalized === 'always') return 'always';
    if (normalized === '' || normalized === 'y' || normalized === 'yes') return 'once';

    return 'reject';
  }

  private onLine(line: string): void {
    this.interruptArmed = false;
    const trimmed = line.trim();

    if (this.busy) {
      if (trimmed) this.queued.push(trimmed);
      return;
    }

    this.track(this.handle(trimmed));
  }

  private track(work: Promise<void>): void {
    this.activeWork = work.catch(() => undefined);
  }

  private async handle(input: string): Promise<void> {
    if (this.exiting) return;

    if (!input) {
      this.input.prompt();
      return;
    }

    const wasCommand = await handleSlash(input, this.slashContext());

    if (wasCommand) {
      if (!this.exiting) this.input.prompt();
      return;
    }

    await this.runTurn(input);
    await this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    while (this.queued.length > 0 && !this.exiting) {
      const next = this.queued.shift();
      if (!next) continue;

      process.stdout.write(`${style.cyan('› ')}${next}\n`);
      await this.runTurn(next);
    }

    if (!this.exiting) this.input.prompt();
  }

  private async runTurn(input: string): Promise<void> {
    if (this.exiting) return;

    this.busy = true;
    this.turnController = new AbortController();

    const spinner = new Spinner();
    const renderer = new StreamRenderer(process.stdout);
    let streaming = false;

    const stopStreaming = () => {
      spinner.stop();
      if (streaming) {
        renderer.end();
        streaming = false;
      }
    };

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
        stopStreaming();
        process.stdout.write(`${toolStartLine(name, summary)}\n`);
        spinner.start(`${name}…`);
      },

      onToolEnd: ({ ok, display, durationMs }) => {
        spinner.stop();
        process.stdout.write(`${toolEndLine(ok, display, durationMs)}\n`);
      },

      onCompaction: (result) => {
        spinner.stop();
        const freed = result.tokensBefore - result.tokensAfter;
        process.stdout.write(
          `${notice(`context compacted: ${result.removedMessages} messages, ~${freed.toLocaleString()} tokens freed`)}\n`,
        );
      },

      onNotice: (message) => {
        spinner.stop();
        process.stdout.write(`${notice(message)}\n`);
      },
    };

    try {
      await this.agent.run(input, events, this.turnController.signal);
      if (streaming) renderer.end();
    } catch (error) {
      stopStreaming();
      process.stdout.write(
        isAbort(error)
          ? `${style.yellow('  interrupted')}\n`
          : `${style.red('  error: ')}${errorMessage(error)}\n`,
      );
    } finally {
      spinner.stop();
      this.busy = false;
      this.turnController = null;
    }
  }

  private slashContext() {
    return {
      config: this.config,
      session: this.session,
      approval: this.approval,
      tools: this.tools,
      provider: this.provider,
      agent: this.agent,
      print: (text: string) => process.stdout.write(`${text}\n`),
      requestExit: () => {
        this.exiting = true;
        this.input.close();
      },
      requestResume: (id: string) => this.resume(id),
    };
  }

  private resume(id: string): void {
    const snapshot = findSession(id);

    if (!snapshot) {
      process.stdout.write(style.yellow(`  no session found for "${id}" — try /sessions\n`));
      return;
    }

    this.session.restore(snapshot);
    process.stdout.write(
      `  resumed ${style.cyan(snapshot.id.slice(0, 8))} ` +
        style.gray(`(${snapshot.messages.length} messages, ${snapshot.turns} turns)\n`),
    );
  }

  private persist(session: Session): void {
    if (!this.config.persistSessions) return;

    try {
      saveSnapshot(session.snapshot());
    } catch {
      return;
    }
  }

  private question(prompt: string): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false;

      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        this.input.off('close', onClose);
        resolve(value);
      };

      const onClose = () => finish(null);

      this.input.once('close', onClose);
      this.input.question(prompt, (answer) => finish(answer));
    });
  }

  private onInterrupt(): void {
    if (this.busy && this.turnController) {
      this.turnController.abort();
      process.stdout.write(`\n${style.yellow('  interrupting…')}\n`);
      return;
    }

    if (this.interruptArmed) {
      this.exiting = true;
      this.input.close();
      return;
    }

    this.interruptArmed = true;
    process.stdout.write(`\n${style.gray('  press Ctrl+C again to exit, or Ctrl+D')}\n`);
    this.input.prompt();
  }

  private complete(line: string): [string[], string] {
    if (!line.startsWith('/')) return [[], line];

    const matches = commandNames().filter((name) => name.startsWith(line));
    return [matches.length > 0 ? matches : commandNames(), line];
  }

  private printFarewell(): void {
    const { costUsd, turns } = this.session.totals();

    if (turns === 0) {
      process.stdout.write('\n');
      return;
    }

    const resumeHint = this.config.persistSessions
      ? ` · resume with sable --resume ${this.session.id.slice(0, 8)}`
      : '';

    process.stdout.write(
      `\n${style.gray(`${turns} turn${turns === 1 ? '' : 's'} · estimated ${formatCost(costUsd)}${resumeHint}`)}\n`,
    );
  }
}

import fs from 'node:fs';
import path from 'node:path';

import type { Agent } from '../agent/loop.js';
import { formatCost } from '../agent/pricing.js';
import type { Session } from '../agent/session.js';
import { listSessions } from '../agent/store.js';
import type { ApprovalPolicy } from '../approval/policy.js';
import { APPROVAL_MODES, type ApprovalMode, type Config } from '../config/config.js';
import type { Provider } from '../providers/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { style } from '../util/ansi.js';
import { errorMessage } from '../util/errors.js';
import { resolveWithin, tildify } from '../util/paths.js';

const SESSION_LIST_LIMIT = 10;
const SHORT_ID_LENGTH = 8;

export interface SlashContext {
  config: Config;
  session: Session;
  approval: ApprovalPolicy;
  tools: ToolRegistry;
  provider: Provider;
  agent: Agent;
  print(text: string): void;
  requestExit(): void;
  requestResume(id: string): void;
}

export interface SlashCommand {
  name: string;
  aliases?: string[];
  args?: string;
  description: string;
  run(args: string, context: SlashContext): void | Promise<void>;
}

export const COMMANDS: SlashCommand[] = [
  {
    name: 'help',
    aliases: ['?'],
    description: 'Show these commands',
    run(_args, context) {
      const width = Math.max(
        ...COMMANDS.map((command) => command.name.length + (command.args?.length ?? 0) + 2),
      );

      const lines = COMMANDS.map((command) => {
        const label = `/${command.name}${command.args ? ` ${command.args}` : ''}`;
        return `  ${style.cyan(label.padEnd(width + 1))} ${style.gray(command.description)}`;
      });

      context.print(
        [
          '',
          style.bold('Commands'),
          ...lines,
          '',
          style.gray('  Ctrl+C interrupts the current turn · Ctrl+D exits'),
          '',
        ].join('\n'),
      );
    },
  },

  {
    name: 'tools',
    description: 'List the tools available to the model',
    run(_args, context) {
      const rows = context.tools.list().map((tool) => {
        const kind = kindLabel(tool.kind);
        const summary = tool.description.split('.')[0] ?? '';
        return `  ${style.cyan(tool.name.padEnd(12))} ${kind.padEnd(16)} ${style.gray(summary)}`;
      });

      context.print(['', style.bold('Tools'), ...rows, ''].join('\n'));
    },
  },

  {
    name: 'model',
    args: '[name]',
    description: 'Show or switch the model for this session',
    run(args, context) {
      const requested = args.trim();

      if (!requested) {
        context.print(
          [
            `  model: ${style.cyan(context.session.getModel())}`,
            `  ${style.gray(`known: ${context.provider.knownModels.join(', ')}`)}`,
          ].join('\n'),
        );
        return;
      }

      context.session.setModel(requested);
      context.print(`  model set to ${style.cyan(requested)}`);
    },
  },

  {
    name: 'approval',
    args: '[mode]',
    description: `Show or set approval mode (${APPROVAL_MODES.join(' | ')})`,
    run(args, context) {
      const requested = args.trim();

      if (!requested) {
        const allowed = context.approval.allowlist();
        const extra = allowed.length ? ` ${style.gray(`(always: ${allowed.join(', ')})`)}` : '';
        context.print(`  approval: ${style.cyan(context.approval.getMode())}${extra}`);
        return;
      }

      if (!APPROVAL_MODES.includes(requested as ApprovalMode)) {
        context.print(
          style.yellow(`  unknown mode "${requested}". Expected: ${APPROVAL_MODES.join(', ')}`),
        );
        return;
      }

      context.approval.setMode(requested as ApprovalMode);
      context.config.approval = requested as ApprovalMode;
      context.print(`  approval set to ${style.cyan(requested)}`);
    },
  },

  {
    name: 'cost',
    description: 'Token usage and estimated spend for this session',
    run(_args, context) {
      const { usage, turns, messages, costUsd, estimatedTokens } = context.session.totals();
      const minutes = Math.max(
        1,
        Math.round((Date.now() - context.session.startedAt.getTime()) / 60_000),
      );

      context.print(
        [
          '',
          `  ${style.gray('turns')}      ${turns} (${messages} messages, ~${minutes}m)`,
          `  ${style.gray('input')}      ${usage.inputTokens.toLocaleString()} tokens`,
          `  ${style.gray('output')}     ${usage.outputTokens.toLocaleString()} tokens`,
          `  ${style.gray('cache')}      ${usage.cacheReadTokens.toLocaleString()} read / ${usage.cacheWriteTokens.toLocaleString()} written`,
          `  ${style.gray('context')}    ~${estimatedTokens.toLocaleString()} tokens, compacts at ${context.config.compactAtTokens.toLocaleString()}`,
          `  ${style.gray('estimate')}   ${style.bold(formatCost(costUsd))} ${style.gray('(local estimate, not a bill)')}`,
          '',
        ].join('\n'),
      );
    },
  },

  {
    name: 'compact',
    description: 'Summarise the conversation so far to free up context',
    async run(_args, context) {
      context.print(style.gray('  compacting…'));

      try {
        const result = await context.agent.compact();

        if (!result.compacted) {
          context.print(style.yellow(`  ${result.reason ?? 'nothing to compact'}`));
          return;
        }

        const saved = result.tokensBefore - result.tokensAfter;
        context.print(
          `  compacted ${result.removedMessages} messages, ` +
            `~${saved.toLocaleString()} tokens freed ` +
            style.gray(
              `(${result.tokensBefore.toLocaleString()} → ${result.tokensAfter.toLocaleString()})`,
            ),
        );
      } catch (error) {
        context.print(style.red(`  compaction failed: ${errorMessage(error)}`));
      }
    },
  },

  {
    name: 'sessions',
    description: 'List recent sessions you can resume',
    run(_args, context) {
      const sessions = listSessions(SESSION_LIST_LIMIT);

      if (sessions.length === 0) {
        context.print(style.gray('  no saved sessions yet'));
        return;
      }

      const rows = sessions.map((entry) => {
        const id = style.cyan(entry.id.slice(0, SHORT_ID_LENGTH));
        const when = new Date(entry.updatedAt).toLocaleString();
        return `  ${id}  ${style.gray(when.padEnd(22))} ${entry.title}`;
      });

      context.print(
        ['', style.bold('Recent sessions'), ...rows, '', style.gray('  /resume <id>'), ''].join(
          '\n',
        ),
      );
    },
  },

  {
    name: 'resume',
    args: '<id>',
    description: 'Load a previous session into this one',
    run(args, context) {
      const id = args.trim();

      if (!id) {
        context.print(style.yellow('  usage: /resume <id> — see /sessions'));
        return;
      }

      context.requestResume(id);
    },
  },

  {
    name: 'clear',
    description: 'Forget the conversation and start fresh',
    run(_args, context) {
      context.session.clear();
      context.print(style.gray('  history cleared'));
    },
  },

  {
    name: 'save',
    args: '<file>',
    description: 'Write the transcript to a JSON file',
    run(args, context) {
      const target = args.trim() || `sable-session-${Date.now()}.json`;
      const file = resolveWithin(context.config.workspaceRoot, target);

      if (!file) {
        context.print(style.yellow('  refusing to write outside the workspace'));
        return;
      }

      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(context.session.snapshot(), null, 2), 'utf8');
      context.print(`  saved to ${style.cyan(tildify(file))}`);
    },
  },

  {
    name: 'cwd',
    description: 'Show the workspace root tools are confined to',
    run(_args, context) {
      context.print(`  ${style.cyan(tildify(context.config.workspaceRoot))}`);
    },
  },

  {
    name: 'exit',
    aliases: ['quit', 'q'],
    description: 'Leave sable',
    run(_args, context) {
      context.requestExit();
    },
  },
];

const COMMANDS_BY_NAME = buildLookup(COMMANDS);

export function isSlashCommand(line: string): boolean {
  return line.startsWith('/');
}

export async function handleSlash(line: string, context: SlashContext): Promise<boolean> {
  if (!isSlashCommand(line)) return false;

  const [head = '', ...rest] = line.slice(1).trim().split(/\s+/);
  const command = COMMANDS_BY_NAME.get(head.toLowerCase());

  if (!command) {
    context.print(style.yellow(`  unknown command /${head} — try /help`));
    return true;
  }

  await command.run(rest.join(' '), context);
  return true;
}

export function commandNames(): string[] {
  return [...COMMANDS_BY_NAME.keys()].map((name) => `/${name}`);
}

function buildLookup(commands: SlashCommand[]): Map<string, SlashCommand> {
  const lookup = new Map<string, SlashCommand>();

  for (const command of commands) {
    lookup.set(command.name, command);
    for (const alias of command.aliases ?? []) lookup.set(alias, command);
  }

  return lookup;
}

function kindLabel(kind: 'read' | 'write' | 'execute'): string {
  if (kind === 'read') return style.green('read');
  if (kind === 'write') return style.yellow('write');
  return style.red('exec');
}

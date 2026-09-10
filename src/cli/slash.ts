import fs from 'node:fs';
import path from 'node:path';

import type { Agent } from '../agent/loop.js';
import { formatCost } from '../agent/pricing.js';
import type { Session } from '../agent/session.js';
import type { ApprovalPolicy } from '../approval/policy.js';
import { APPROVAL_MODES, type ApprovalMode, type Config } from '../config/config.js';
import type { Provider } from '../providers/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { style } from '../util/ansi.js';
import { resolveWithin, tildify } from '../util/paths.js';

export interface SlashContext {
  config: Config;
  session: Session;
  approval: ApprovalPolicy;
  tools: ToolRegistry;
  provider: Provider;
  agent: Agent;
  print(text: string): void;
  requestExit(): void;
}

export interface SlashCommand {
  name: string;
  aliases?: string[];
  args?: string;
  description: string;
  run(args: string, ctx: SlashContext): void;
}

export const COMMANDS: SlashCommand[] = [
  {
    name: 'help',
    aliases: ['?'],
    description: 'Show these commands',
    run(_args, ctx) {
      const width = Math.max(...COMMANDS.map((c) => c.name.length + (c.args?.length ?? 0) + 2));
      const lines = COMMANDS.map((command) => {
        const label = `/${command.name}${command.args ? ` ${command.args}` : ''}`;
        return `  ${style.cyan(label.padEnd(width + 1))} ${style.gray(command.description)}`;
      });
      ctx.print(
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
    run(_args, ctx) {
      const rows = ctx.tools.list().map((tool) => {
        const kind =
          tool.kind === 'read'
            ? style.green('read')
            : tool.kind === 'write'
              ? style.yellow('write')
              : style.red('exec');
        return `  ${style.cyan(tool.name.padEnd(12))} ${kind.padEnd(16)} ${style.gray(
          tool.description.split('.')[0] ?? '',
        )}`;
      });
      ctx.print(['', style.bold('Tools'), ...rows, ''].join('\n'));
    },
  },

  {
    name: 'model',
    args: '[name]',
    description: 'Show or switch the model for this session',
    run(args, ctx) {
      const next = args.trim();
      if (!next) {
        const known = ctx.provider.knownModels.join(', ');
        ctx.print(
          `  model: ${style.cyan(ctx.session.getModel())}\n  ${style.gray(`known: ${known}`)}`,
        );
        return;
      }
      ctx.session.setModel(next);
      ctx.print(`  model set to ${style.cyan(next)}`);
    },
  },

  {
    name: 'approval',
    args: '[mode]',
    description: `Show or set approval mode (${APPROVAL_MODES.join(' | ')})`,
    run(args, ctx) {
      const next = args.trim();
      if (!next) {
        const allowed = ctx.approval.allowlist();
        const extra = allowed.length ? ` ${style.gray(`(always: ${allowed.join(', ')})`)}` : '';
        ctx.print(`  approval: ${style.cyan(ctx.approval.getMode())}${extra}`);
        return;
      }
      if (!APPROVAL_MODES.includes(next as ApprovalMode)) {
        ctx.print(style.yellow(`  unknown mode "${next}". Expected: ${APPROVAL_MODES.join(', ')}`));
        return;
      }
      ctx.approval.setMode(next as ApprovalMode);
      ctx.config.approval = next as ApprovalMode;
      ctx.print(`  approval set to ${style.cyan(next)}`);
    },
  },

  {
    name: 'cost',
    description: 'Token usage and estimated spend for this session',
    run(_args, ctx) {
      const { usage, turns, messages, costUsd } = ctx.session.totals();
      const minutes = Math.max(
        1,
        Math.round((Date.now() - ctx.session.startedAt.getTime()) / 60000),
      );
      ctx.print(
        [
          '',
          `  ${style.gray('turns')}      ${turns} (${messages} messages, ~${minutes}m)`,
          `  ${style.gray('input')}      ${usage.inputTokens.toLocaleString()} tokens`,
          `  ${style.gray('output')}     ${usage.outputTokens.toLocaleString()} tokens`,
          `  ${style.gray('cache')}      ${usage.cacheReadTokens.toLocaleString()} read / ${usage.cacheWriteTokens.toLocaleString()} written`,
          `  ${style.gray('estimate')}   ${style.bold(formatCost(costUsd))} ${style.gray('(local estimate, not a bill)')}`,
          '',
        ].join('\n'),
      );
    },
  },

  {
    name: 'clear',
    description: 'Forget the conversation and start fresh',
    run(_args, ctx) {
      ctx.session.clear();
      ctx.print(style.gray('  history cleared'));
    },
  },

  {
    name: 'save',
    args: '<file>',
    description: 'Write the transcript to a JSON file',
    run(args, ctx) {
      const target = args.trim() || `sable-session-${Date.now()}.json`;
      const file = resolveWithin(ctx.config.workspaceRoot, target);
      if (!file) {
        ctx.print(style.yellow('  refusing to write outside the workspace'));
        return;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(ctx.session.toJSON(), null, 2), 'utf8');
      ctx.print(`  saved to ${style.cyan(tildify(file))}`);
    },
  },

  {
    name: 'cwd',
    description: 'Show the workspace root tools are confined to',
    run(_args, ctx) {
      ctx.print(`  ${style.cyan(tildify(ctx.config.workspaceRoot))}`);
    },
  },

  {
    name: 'exit',
    aliases: ['quit', 'q'],
    description: 'Leave sable',
    run(_args, ctx) {
      ctx.requestExit();
    },
  },
];

const LOOKUP = new Map<string, SlashCommand>();
for (const command of COMMANDS) {
  LOOKUP.set(command.name, command);
  for (const alias of command.aliases ?? []) LOOKUP.set(alias, command);
}

/** Returns true when the line was a slash command (handled or not recognised). */
export function handleSlash(line: string, ctx: SlashContext): boolean {
  if (!line.startsWith('/')) return false;

  const [head = '', ...rest] = line.slice(1).trim().split(/\s+/);
  const command = LOOKUP.get(head.toLowerCase());

  if (!command) {
    ctx.print(style.yellow(`  unknown command /${head} — try /help`));
    return true;
  }

  command.run(rest.join(' '), ctx);
  return true;
}

export function commandNames(): string[] {
  return [...LOOKUP.keys()].map((name) => `/${name}`);
}

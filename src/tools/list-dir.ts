import fs from 'node:fs';
import path from 'node:path';

import { objectSchema } from './schema.js';
import { IGNORED_DIRECTORIES, rel, resolveOrThrow } from './fs-utils.js';
import { fail, ok, type Tool, type ToolContext, type ToolResult } from './types.js';

const MAX_ENTRIES = 500;

export const listDirTool: Tool = {
  name: 'list_dir',
  kind: 'read',
  description: [
    'List a directory as a tree. Noise directories (node_modules, .git, build output)',
    'are skipped. Use this to orient yourself before reading files.',
  ].join(' '),
  schema: objectSchema(
    {
      path: {
        type: 'string',
        description: 'Directory to list, relative to the workspace root. Defaults to the root.',
        default: '.',
      },
      depth: {
        type: 'integer',
        description: 'How many levels to descend. Defaults to 2, maximum 6.',
        minimum: 1,
        maximum: 6,
        default: 2,
      },
      include_hidden: {
        type: 'boolean',
        description: 'Include dotfiles and dot-directories.',
        default: false,
      },
    },
    [],
  ),

  summarize(params) {
    return `list ${String(params['path'] ?? '.')}`;
  },

  async run(params, ctx: ToolContext): Promise<ToolResult> {
    const target = resolveOrThrow(ctx.root, String(params['path'] ?? '.'), 'list_dir');
    const depth = (params['depth'] as number | undefined) ?? 2;
    const includeHidden = params['include_hidden'] === true;

    if (!fs.existsSync(target)) {
      return fail(`list_dir: no such directory: ${rel(ctx.root, target)}`);
    }
    if (!fs.statSync(target).isDirectory()) {
      return fail(`list_dir: ${rel(ctx.root, target)} is a file, not a directory.`);
    }

    const lines: string[] = [`${rel(ctx.root, target)}/`];
    const state = { count: 0, truncated: false };
    walk(target, '', depth, includeHidden, lines, state, ctx);

    if (state.truncated) {
      lines.push(`... listing capped at ${MAX_ENTRIES} entries; narrow the path or reduce depth.`);
    }

    return ok(lines.join('\n'), `listed ${rel(ctx.root, target)} (${state.count} entries)`);
  },
};

interface WalkState {
  count: number;
  truncated: boolean;
}

function walk(
  dir: string,
  prefix: string,
  depth: number,
  includeHidden: boolean,
  lines: string[],
  state: WalkState,
  ctx: ToolContext,
): void {
  if (depth <= 0 || state.truncated || ctx.signal.aborted) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    lines.push(`${prefix}(unreadable)`);
    return;
  }

  const visible = entries
    .filter((entry) => includeHidden || !entry.name.startsWith('.'))
    .filter((entry) => !(entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  for (const [index, entry] of visible.entries()) {
    if (state.count >= MAX_ENTRIES) {
      state.truncated = true;
      return;
    }
    state.count++;

    const last = index === visible.length - 1;
    const branch = last ? '└── ' : '├── ';
    const child = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      lines.push(`${prefix}${branch}${entry.name}/`);
      walk(child, prefix + (last ? '    ' : '│   '), depth - 1, includeHidden, lines, state, ctx);
    } else {
      let size = '';
      try {
        size = ` (${formatBytes(fs.statSync(child).size)})`;
      } catch {
        size = '';
      }
      lines.push(`${prefix}${branch}${entry.name}${size}`);
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

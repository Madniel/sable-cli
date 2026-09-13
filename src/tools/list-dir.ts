import fs from 'node:fs';
import path from 'node:path';

import { IGNORED_DIRECTORIES, formatBytes, rel, resolveOrThrow } from './fs-utils.js';
import { objectSchema } from './schema.js';
import { fail, ok, type Tool, type ToolContext, type ToolResult } from './types.js';

const MAX_ENTRIES = 500;
const DEFAULT_DEPTH = 2;

interface TreeBuilder {
  lines: string[];
  count: number;
  truncated: boolean;
}

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
        description: `How many levels to descend. Defaults to ${DEFAULT_DEPTH}, maximum 6.`,
        minimum: 1,
        maximum: 6,
        default: DEFAULT_DEPTH,
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

  async run(params, context: ToolContext): Promise<ToolResult> {
    const target = resolveOrThrow(context.root, String(params['path'] ?? '.'), 'list_dir');
    const depth = Number(params['depth'] ?? DEFAULT_DEPTH);
    const includeHidden = params['include_hidden'] === true;

    if (!fs.existsSync(target)) {
      return fail(`list_dir: no such directory: ${rel(context.root, target)}`);
    }
    if (!fs.statSync(target).isDirectory()) {
      return fail(`list_dir: ${rel(context.root, target)} is a file, not a directory.`);
    }

    const builder: TreeBuilder = {
      lines: [`${rel(context.root, target)}/`],
      count: 0,
      truncated: false,
    };

    appendTree(target, '', depth, includeHidden, builder, context);

    if (builder.truncated) {
      builder.lines.push(
        `... listing capped at ${MAX_ENTRIES} entries; narrow the path or reduce depth.`,
      );
    }

    return ok(
      builder.lines.join('\n'),
      `listed ${rel(context.root, target)} (${builder.count} entries)`,
    );
  },
};

function appendTree(
  directory: string,
  prefix: string,
  depth: number,
  includeHidden: boolean,
  builder: TreeBuilder,
  context: ToolContext,
): void {
  if (depth <= 0 || builder.truncated || context.signal.aborted) return;

  const entries = visibleEntries(directory, includeHidden, builder);
  if (entries === null) return;

  for (const [index, entry] of entries.entries()) {
    if (builder.count >= MAX_ENTRIES) {
      builder.truncated = true;
      return;
    }
    builder.count++;

    const isLast = index === entries.length - 1;
    const branch = isLast ? '└── ' : '├── ';
    const child = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      builder.lines.push(`${prefix}${branch}${entry.name}/`);
      appendTree(
        child,
        prefix + (isLast ? '    ' : '│   '),
        depth - 1,
        includeHidden,
        builder,
        context,
      );
    } else {
      builder.lines.push(`${prefix}${branch}${entry.name}${sizeSuffix(child)}`);
    }
  }
}

function visibleEntries(
  directory: string,
  includeHidden: boolean,
  builder: TreeBuilder,
): fs.Dirent[] | null {
  let entries: fs.Dirent[];

  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    builder.lines.push('(unreadable)');
    return null;
  }

  return entries
    .filter((entry) => includeHidden || !entry.name.startsWith('.'))
    .filter((entry) => !(entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)))
    .sort(directoriesFirst);
}

function directoriesFirst(a: fs.Dirent, b: fs.Dirent): number {
  if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function sizeSuffix(file: string): string {
  try {
    return ` (${formatBytes(fs.statSync(file).size)})`;
  } catch {
    return '';
  }
}

import fs from 'node:fs';

import { formatBytes, rel, resolveOrThrow, walkFiles } from './fs-utils.js';
import { globToRegExp } from './glob-pattern.js';
import { objectSchema } from './schema.js';
import { fail, ok, type Tool, type ToolContext, type ToolResult } from './types.js';

const DEFAULT_LIMIT = 100;

interface MatchedFile {
  path: string;
  mtimeMs: number;
  size: number;
}

export const globTool: Tool = {
  name: 'glob',
  kind: 'read',
  description: [
    'Find files by path pattern, newest first. Supports `*`, `**`, `?`, character',
    'classes and `{a,b}` alternatives — for example "src/**/*.{ts,tsx}". Use this to',
    'locate files when you know roughly what they are called; use grep when you know',
    'what is inside them.',
  ].join(' '),
  schema: objectSchema(
    {
      pattern: {
        type: 'string',
        description: 'Glob pattern matched against workspace-relative paths.',
      },
      path: {
        type: 'string',
        description: 'Directory to search under. Defaults to the workspace root.',
        default: '.',
      },
      limit: {
        type: 'integer',
        description: `Maximum matches to return. Defaults to ${DEFAULT_LIMIT}.`,
        minimum: 1,
        maximum: 1000,
        default: DEFAULT_LIMIT,
      },
    },
    ['pattern'],
  ),

  summarize(params) {
    return `glob ${String(params['pattern'])} in ${String(params['path'] ?? '.')}`;
  },

  async run(params, context: ToolContext): Promise<ToolResult> {
    const pattern = String(params['pattern']);
    const root = resolveOrThrow(context.root, String(params['path'] ?? '.'), 'glob');
    const limit = Number(params['limit'] ?? DEFAULT_LIMIT);

    if (!fs.existsSync(root)) {
      return fail(`glob: no such directory: ${rel(context.root, root)}`);
    }

    const matcher = globToRegExp(pattern);
    const matches: MatchedFile[] = [];

    walkFiles(root, context, (file) => {
      const relative = rel(context.root, file);
      if (!matcher.test(relative)) return;

      try {
        const stat = fs.statSync(file);
        matches.push({ path: relative, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {
        return;
      }
    });

    if (matches.length === 0) {
      return ok(
        `No files matching ${pattern} under ${rel(context.root, root)}.`,
        'glob: no matches',
      );
    }

    matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const shown = matches.slice(0, limit);
    const lines = shown.map((match) => `${match.path} (${formatBytes(match.size)})`);
    const omitted = matches.length - shown.length;

    if (omitted > 0) lines.push(`... ${omitted} more matches`);

    return ok(
      `${matches.length} file${matches.length === 1 ? '' : 's'} matching ${pattern}:\n\n${lines.join('\n')}`,
      `glob: ${matches.length} files`,
    );
  },
};

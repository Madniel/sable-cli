import fs from 'node:fs';
import path from 'node:path';

import { ToolInputError } from '../util/errors.js';
import { objectSchema } from './schema.js';
import { IGNORED_DIRECTORIES, isProbablyBinary, rel, resolveOrThrow } from './fs-utils.js';
import { fail, ok, type Tool, type ToolContext, type ToolResult } from './types.js';

const MAX_FILE_BYTES = 2_000_000;

export const grepTool: Tool = {
  name: 'grep',
  kind: 'read',
  description: [
    'Search file contents with a JavaScript regular expression. Returns matching',
    'lines with file and line number. Filter with `glob` (for example "**/*.ts")',
    'to keep results tight.',
  ].join(' '),
  schema: objectSchema(
    {
      pattern: { type: 'string', description: 'JavaScript regular expression to search for.' },
      path: {
        type: 'string',
        description: 'Directory or file to search. Defaults to the workspace root.',
        default: '.',
      },
      glob: {
        type: 'string',
        description: 'Optional glob filter on file paths, e.g. "src/**/*.ts" or "*.json".',
      },
      case_sensitive: {
        type: 'boolean',
        description: 'Match case. Defaults to false.',
        default: false,
      },
      max_results: {
        type: 'integer',
        description: 'Maximum matching lines to return. Defaults to 100.',
        minimum: 1,
        maximum: 1000,
        default: 100,
      },
    },
    ['pattern'],
  ),

  summarize(params) {
    const where = String(params['path'] ?? '.');
    return `grep /${String(params['pattern'])}/ in ${where}`;
  },

  async run(params, ctx: ToolContext): Promise<ToolResult> {
    const pattern = String(params['pattern']);
    const target = resolveOrThrow(ctx.root, String(params['path'] ?? '.'), 'grep');
    const maxResults = (params['max_results'] as number | undefined) ?? 100;
    const globPattern = params['glob'] as string | undefined;

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, params['case_sensitive'] === true ? '' : 'i');
    } catch (cause) {
      throw new ToolInputError(`grep: invalid regular expression: ${(cause as Error).message}`);
    }

    if (!fs.existsSync(target)) {
      return fail(`grep: no such path: ${rel(ctx.root, target)}`);
    }

    const globRegex = globPattern ? globToRegExp(globPattern) : null;
    const files: string[] = [];
    if (fs.statSync(target).isDirectory()) {
      collectFiles(target, files, ctx);
    } else {
      files.push(target);
    }

    const matches: string[] = [];
    let scanned = 0;
    let capped = false;

    for (const file of files) {
      if (ctx.signal.aborted) break;
      const relative = rel(ctx.root, file);
      if (globRegex && !globRegex.test(relative)) continue;

      let buffer: Buffer;
      try {
        const stat = fs.statSync(file);
        if (stat.size > MAX_FILE_BYTES) continue;
        buffer = fs.readFileSync(file);
      } catch {
        continue;
      }
      if (isProbablyBinary(buffer)) continue;
      scanned++;

      const lines = buffer.toString('utf8').split('\n');
      for (const [index, line] of lines.entries()) {
        if (!regex.test(line)) continue;
        matches.push(`${relative}:${index + 1}: ${line.trim().slice(0, 300)}`);
        if (matches.length >= maxResults) {
          capped = true;
          break;
        }
      }
      if (capped) break;
    }

    if (matches.length === 0) {
      return ok(
        `No matches for /${pattern}/ in ${rel(ctx.root, target)} (${scanned} files searched).`,
        `grep: no matches (${scanned} files)`,
      );
    }

    const footer = capped ? `\n\n[capped at ${maxResults} matches]` : '';
    return ok(
      `${matches.length} match${matches.length === 1 ? '' : 'es'} in ${scanned} files:\n\n` +
        matches.join('\n') +
        footer,
      `grep: ${matches.length} matches`,
    );
  },
};

function collectFiles(dir: string, out: string[], ctx: ToolContext, depth = 0): void {
  if (depth > 12 || ctx.signal.aborted || out.length > 20_000) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      collectFiles(child, out, ctx, depth + 1);
    } else if (entry.isFile()) {
      out.push(child);
    }
  }
}

/** Translate a shell-style glob into a RegExp. Supports `*`, `**`, `?` and character classes. */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] as string;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches any number of leading directories, including none.
        if (glob[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '[') {
      const end = glob.indexOf(']', i);
      if (end === -1) {
        source += '\\[';
      } else {
        source += glob.slice(i, end + 1);
        i = end;
      }
    } else {
      source += char.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

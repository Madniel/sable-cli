import fs from 'node:fs';

import { ToolInputError } from '../util/errors.js';
import { isProbablyBinary, rel, resolveOrThrow, walkFiles } from './fs-utils.js';
import { globToRegExp } from './glob-pattern.js';
import { objectSchema } from './schema.js';
import { fail, ok, type Tool, type ToolContext, type ToolResult } from './types.js';

const MAX_FILE_BYTES = 2_000_000;
const MAX_LINE_LENGTH = 300;
const DEFAULT_LIMIT = 100;

interface Match {
  file: string;
  line: number;
  text: string;
  before: string[];
  after: string[];
}

export const grepTool: Tool = {
  name: 'grep',
  kind: 'read',
  description: [
    'Search file contents with a JavaScript regular expression. Returns matching',
    'lines with file and line number. Filter with `glob` (for example "**/*.ts")',
    'to keep results tight, and raise `context_lines` when you need to see the',
    'surrounding code.',
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
      context_lines: {
        type: 'integer',
        description: 'Lines of surrounding context to include with each match.',
        minimum: 0,
        maximum: 10,
        default: 0,
      },
      max_results: {
        type: 'integer',
        description: `Maximum matching lines to return. Defaults to ${DEFAULT_LIMIT}.`,
        minimum: 1,
        maximum: 1000,
        default: DEFAULT_LIMIT,
      },
    },
    ['pattern'],
  ),

  summarize(params) {
    return `grep /${String(params['pattern'])}/ in ${String(params['path'] ?? '.')}`;
  },

  async run(params, context: ToolContext): Promise<ToolResult> {
    const pattern = String(params['pattern']);
    const target = resolveOrThrow(context.root, String(params['path'] ?? '.'), 'grep');
    const maxResults = Number(params['max_results'] ?? DEFAULT_LIMIT);
    const contextLines = Number(params['context_lines'] ?? 0);
    const regex = compile(pattern, params['case_sensitive'] === true);

    if (!fs.existsSync(target)) {
      return fail(`grep: no such path: ${rel(context.root, target)}`);
    }

    const globFilter = params['glob'] ? globToRegExp(String(params['glob'])) : null;
    const files = collectSearchableFiles(target, context);

    const matches: Match[] = [];
    let scanned = 0;
    let capped = false;

    for (const file of files) {
      if (context.signal.aborted || capped) break;

      const relative = rel(context.root, file);
      if (globFilter && !globFilter.test(relative)) continue;

      const lines = readSearchableLines(file);
      if (!lines) continue;
      scanned++;

      for (const [index, line] of lines.entries()) {
        if (!regex.test(line)) continue;

        matches.push({
          file: relative,
          line: index + 1,
          text: line,
          before: contextLines > 0 ? lines.slice(Math.max(0, index - contextLines), index) : [],
          after: contextLines > 0 ? lines.slice(index + 1, index + 1 + contextLines) : [],
        });
        if (matches.length >= maxResults) {
          capped = true;
          break;
        }
      }
    }

    if (matches.length === 0) {
      return ok(
        `No matches for /${pattern}/ in ${rel(context.root, target)} (${scanned} files searched).`,
        `grep: no matches (${scanned} files)`,
      );
    }

    const rendered = contextLines > 0 ? renderWithContext(matches) : renderPlain(matches);
    const footer = capped ? `\n\n[capped at ${maxResults} matches]` : '';

    return ok(
      `${matches.length} match${matches.length === 1 ? '' : 'es'} in ${scanned} files:\n\n${rendered}${footer}`,
      `grep: ${matches.length} matches`,
    );
  },
};

function compile(pattern: string, caseSensitive: boolean): RegExp {
  try {
    return new RegExp(pattern, caseSensitive ? '' : 'i');
  } catch (cause) {
    throw new ToolInputError(`grep: invalid regular expression: ${(cause as Error).message}`);
  }
}

function collectSearchableFiles(target: string, context: ToolContext): string[] {
  if (!fs.statSync(target).isDirectory()) return [target];

  const files: string[] = [];
  walkFiles(target, context, (file) => files.push(file));
  return files;
}

function readSearchableLines(file: string): string[] | null {
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_FILE_BYTES) return null;

    const buffer = fs.readFileSync(file);
    if (isProbablyBinary(buffer)) return null;

    return buffer.toString('utf8').split('\n');
  } catch {
    return null;
  }
}

function renderPlain(matches: Match[]): string {
  return matches
    .map((match) => `${match.file}:${match.line}: ${match.text.trim().slice(0, MAX_LINE_LENGTH)}`)
    .join('\n');
}

function renderWithContext(matches: Match[]): string {
  return matches
    .map((match) => {
      const firstLine = match.line - match.before.length;
      const rendered = [
        ...match.before.map((text, offset) => gutter(firstLine + offset, text, false)),
        gutter(match.line, match.text, true),
        ...match.after.map((text, offset) => gutter(match.line + offset + 1, text, false)),
      ];
      return [`${match.file}:${match.line}`, ...rendered].join('\n');
    })
    .join('\n\n');
}

function gutter(lineNumber: number, text: string, isMatch: boolean): string {
  return `${isMatch ? '>' : ' '} ${lineNumber}: ${text.slice(0, MAX_LINE_LENGTH)}`;
}

import fs from 'node:fs';

import { isProbablyBinary, rel, resolveOrThrow, truncate } from './fs-utils.js';
import { objectSchema } from './schema.js';
import { fail, ok, type Tool, type ToolContext, type ToolResult } from './types.js';

const MAX_OUTPUT_CHARS = 120_000;
const DEFAULT_LINE_LIMIT = 2000;

export const readFileTool: Tool = {
  name: 'read_file',
  kind: 'read',
  description: [
    'Read a UTF-8 text file from the workspace. Output is line-numbered so you can',
    'refer to exact lines afterwards. Use `offset` and `limit` for large files;',
    'read the region you need rather than the whole file.',
  ].join(' '),
  schema: objectSchema(
    {
      path: { type: 'string', description: 'File path, relative to the workspace root.' },
      offset: {
        type: 'integer',
        description: '1-based line to start from. Defaults to 1.',
        minimum: 1,
        default: 1,
      },
      limit: {
        type: 'integer',
        description: `Maximum lines to return. Defaults to ${DEFAULT_LINE_LIMIT}.`,
        minimum: 1,
        default: DEFAULT_LINE_LIMIT,
      },
    },
    ['path'],
  ),

  summarize(params) {
    const offset = Number(params['offset'] ?? 1);
    const suffix = offset > 1 ? ` from line ${offset}` : '';
    return `read ${String(params['path'])}${suffix}`;
  },

  async run(params, context: ToolContext): Promise<ToolResult> {
    const file = resolveOrThrow(context.root, String(params['path']), 'read_file');
    const offset = Number(params['offset'] ?? 1);
    const limit = Number(params['limit'] ?? DEFAULT_LINE_LIMIT);

    const stat = statOrNull(file);
    if (!stat) return fail(`read_file: no such file: ${rel(context.root, file)}`);

    if (stat.isDirectory()) {
      return fail(`read_file: ${rel(context.root, file)} is a directory. Use list_dir instead.`);
    }

    context.files.record(file);

    if (stat.size === 0) return ok(`(${rel(context.root, file)} is empty)`);

    const buffer = fs.readFileSync(file);
    if (isProbablyBinary(buffer)) {
      return fail(
        `read_file: ${rel(context.root, file)} looks like a binary file (${stat.size} bytes); ` +
          'refusing to read it as text.',
      );
    }

    const lines = buffer.toString('utf8').split('\n');
    const start = Math.min(offset - 1, lines.length);
    const selected = lines.slice(start, start + limit);
    const body = numberLines(selected, start);
    const remaining = lines.length - (start + selected.length);

    return ok(
      truncate(body, MAX_OUTPUT_CHARS).text + continuationHint(remaining, start + selected.length),
      `read ${rel(context.root, file)} (${selected.length} lines)`,
    );
  },
};

function numberLines(lines: string[], startIndex: number): string {
  const width = String(startIndex + lines.length).length;
  return lines
    .map((line, index) => `${String(startIndex + index + 1).padStart(width, ' ')}  ${line}`)
    .join('\n');
}

function continuationHint(remaining: number, consumed: number): string {
  if (remaining <= 0) return '';
  return `\n\n[${remaining} more lines. Continue with offset=${consumed + 1}.]`;
}

function statOrNull(file: string): fs.Stats | null {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

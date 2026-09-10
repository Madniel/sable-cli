import fs from 'node:fs';

import { objectSchema } from './schema.js';
import { isProbablyBinary, rel, resolveOrThrow, truncate } from './fs-utils.js';
import { fail, ok, type Tool, type ToolContext, type ToolResult } from './types.js';

const MAX_CHARS = 120_000;
const DEFAULT_LIMIT = 2000;

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
        description: `Maximum lines to return. Defaults to ${DEFAULT_LIMIT}.`,
        minimum: 1,
        default: DEFAULT_LIMIT,
      },
    },
    ['path'],
  ),

  summarize(params) {
    const offset = params['offset'] as number;
    const suffix = offset && offset > 1 ? ` from line ${offset}` : '';
    return `read ${String(params['path'])}${suffix}`;
  },

  async run(params, ctx: ToolContext): Promise<ToolResult> {
    const file = resolveOrThrow(ctx.root, String(params['path']), 'read_file');
    const offset = (params['offset'] as number | undefined) ?? 1;
    const limit = (params['limit'] as number | undefined) ?? DEFAULT_LIMIT;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return fail(`read_file: no such file: ${rel(ctx.root, file)}`);
    }

    if (stat.isDirectory()) {
      return fail(`read_file: ${rel(ctx.root, file)} is a directory. Use list_dir instead.`);
    }
    if (stat.size === 0) {
      return ok(`(${rel(ctx.root, file)} is empty)`);
    }

    const buffer = fs.readFileSync(file);
    if (isProbablyBinary(buffer)) {
      return fail(
        `read_file: ${rel(ctx.root, file)} looks like a binary file (${stat.size} bytes); refusing to read it as text.`,
      );
    }

    const lines = buffer.toString('utf8').split('\n');
    const start = Math.min(offset - 1, lines.length);
    const slice = lines.slice(start, start + limit);
    const width = String(start + slice.length).length;

    const body = slice
      .map((line, index) => `${String(start + index + 1).padStart(width, ' ')}  ${line}`)
      .join('\n');

    const { text } = truncate(body, MAX_CHARS);
    const remaining = lines.length - (start + slice.length);
    const footer =
      remaining > 0
        ? `\n\n[${remaining} more lines. Continue with offset=${start + slice.length + 1}.]`
        : '';

    return ok(text + footer, `read ${rel(ctx.root, file)} (${slice.length} lines)`);
  },
};

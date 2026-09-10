import fs from 'node:fs';

import { ToolDeniedError } from '../util/errors.js';
import { objectSchema } from './schema.js';
import { ensureParentDir, previewReplacement, rel, resolveOrThrow } from './fs-utils.js';
import { fail, ok, type Tool, type ToolContext, type ToolResult } from './types.js';

export const writeFileTool: Tool = {
  name: 'write_file',
  kind: 'write',
  description: [
    'Create a file, or replace its entire contents. Parent directories are created',
    'as needed. For a small change to an existing file prefer edit_file — it is',
    'cheaper and far less likely to clobber work you have not read.',
  ].join(' '),
  schema: objectSchema(
    {
      path: { type: 'string', description: 'File path, relative to the workspace root.' },
      content: { type: 'string', description: 'The complete new contents of the file.' },
    },
    ['path', 'content'],
  ),

  summarize(params) {
    const content = String(params['content'] ?? '');
    const lines = content === '' ? 0 : content.split('\n').length;
    return `write ${String(params['path'])} (${lines} lines)`;
  },

  async run(params, ctx: ToolContext): Promise<ToolResult> {
    const file = resolveOrThrow(ctx.root, String(params['path']), 'write_file');
    const content = String(params['content']);
    const exists = fs.existsSync(file);

    if (exists && fs.statSync(file).isDirectory()) {
      return fail(`write_file: ${rel(ctx.root, file)} is a directory.`);
    }

    const previous = exists ? fs.readFileSync(file, 'utf8') : '';
    if (exists && previous === content) {
      return ok(`No change: ${rel(ctx.root, file)} already has these contents.`);
    }

    const outcome = await ctx.confirm({
      toolName: 'write_file',
      kind: 'write',
      summary: `${exists ? 'Overwrite' : 'Create'} ${rel(ctx.root, file)}`,
      detail: exists
        ? previewReplacement(previous, content)
        : content
            .split('\n')
            .slice(0, 20)
            .map((line) => `+ ${line}`)
            .join('\n'),
    });
    if (outcome === 'reject') {
      throw new ToolDeniedError(`The user declined the write to ${rel(ctx.root, file)}.`);
    }

    ensureParentDir(file);
    fs.writeFileSync(file, content, 'utf8');

    const lines = content === '' ? 0 : content.split('\n').length;
    return ok(
      `${exists ? 'Overwrote' : 'Created'} ${rel(ctx.root, file)} (${lines} lines, ${Buffer.byteLength(content)} bytes).`,
      `${exists ? 'wrote' : 'created'} ${rel(ctx.root, file)}`,
    );
  },
};

import fs from 'node:fs';

import { ToolDeniedError } from '../util/errors.js';
import { unifiedDiff } from '../util/diff.js';
import { ensureParentDir, rel, resolveOrThrow, staleFileResult } from './fs-utils.js';
import { objectSchema } from './schema.js';
import { fail, ok, type Tool, type ToolContext, type ToolResult } from './types.js';

const NEW_FILE_PREVIEW_LINES = 24;

export const writeFileTool: Tool = {
  name: 'write_file',
  kind: 'write',
  description: [
    'Create a file, or replace its entire contents. Parent directories are created',
    'as needed. For a change to an existing file prefer edit_file or multi_edit —',
    'they are cheaper and cannot clobber parts of the file you have not read.',
  ].join(' '),
  schema: objectSchema(
    {
      path: { type: 'string', description: 'File path, relative to the workspace root.' },
      content: { type: 'string', description: 'The complete new contents of the file.' },
    },
    ['path', 'content'],
  ),

  summarize(params) {
    return `write ${String(params['path'])} (${countLines(String(params['content'] ?? ''))} lines)`;
  },

  async run(params, context: ToolContext): Promise<ToolResult> {
    const file = resolveOrThrow(context.root, String(params['path']), 'write_file');
    const content = String(params['content']);
    const exists = fs.existsSync(file);

    if (exists && fs.statSync(file).isDirectory()) {
      return fail(`write_file: ${rel(context.root, file)} is a directory.`);
    }

    const stale = staleFileResult(context, file, 'write_file');
    if (stale) return stale;

    const previous = exists ? fs.readFileSync(file, 'utf8') : '';
    if (exists && previous === content) {
      return ok(`No change: ${rel(context.root, file)} already has these contents.`);
    }

    const approved = await context.confirm({
      toolName: 'write_file',
      kind: 'write',
      summary: `${exists ? 'Overwrite' : 'Create'} ${rel(context.root, file)}`,
      detail: exists
        ? unifiedDiff(previous, content)
        : previewNewFile(content, exists, context, file),
    });

    if (approved === 'reject') {
      throw new ToolDeniedError(`The user declined the write to ${rel(context.root, file)}.`);
    }

    ensureParentDir(file);
    fs.writeFileSync(file, content, 'utf8');
    context.files.record(file);

    return ok(
      `${exists ? 'Overwrote' : 'Created'} ${rel(context.root, file)} ` +
        `(${countLines(content)} lines, ${Buffer.byteLength(content)} bytes).`,
      `${exists ? 'wrote' : 'created'} ${rel(context.root, file)}`,
    );
  },
};

function previewNewFile(
  content: string,
  exists: boolean,
  context: ToolContext,
  file: string,
): string {
  const warning =
    exists && !context.files.hasSeen(file)
      ? [`! ${rel(context.root, file)} has not been read in this session`]
      : [];

  const lines = content.split('\n').slice(0, NEW_FILE_PREVIEW_LINES);
  const omitted = countLines(content) - lines.length;
  const body = lines.map((line) => `+${line}`);

  if (omitted > 0) body.push(`... ${omitted} more lines`);
  return [...warning, ...body].join('\n');
}

function countLines(content: string): number {
  return content === '' ? 0 : content.split('\n').length;
}

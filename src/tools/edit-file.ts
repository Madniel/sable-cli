import fs from 'node:fs';

import { ToolDeniedError } from '../util/errors.js';
import { objectSchema } from './schema.js';
import { previewReplacement, rel, resolveOrThrow } from './fs-utils.js';
import { fail, ok, type Tool, type ToolContext, type ToolResult } from './types.js';

export const editFileTool: Tool = {
  name: 'edit_file',
  kind: 'write',
  description: [
    'Replace an exact string in a file. `old_string` must appear exactly once unless',
    'you set `replace_all`. Include enough surrounding context to make the match',
    'unambiguous. Read the file first: an edit against contents you have not seen is',
    'how files get corrupted.',
  ].join(' '),
  schema: objectSchema(
    {
      path: { type: 'string', description: 'File path, relative to the workspace root.' },
      old_string: {
        type: 'string',
        description: 'Exact text to replace, including indentation and line breaks.',
      },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: {
        type: 'boolean',
        description: 'Replace every occurrence instead of requiring a unique match.',
        default: false,
      },
    },
    ['path', 'old_string', 'new_string'],
  ),

  summarize(params) {
    return `edit ${String(params['path'])}`;
  },

  async run(params, ctx: ToolContext): Promise<ToolResult> {
    const file = resolveOrThrow(ctx.root, String(params['path']), 'edit_file');
    const oldString = String(params['old_string']);
    const newString = String(params['new_string']);
    const replaceAll = params['replace_all'] === true;

    if (oldString === newString) {
      return fail('edit_file: old_string and new_string are identical; nothing to do.');
    }
    if (!fs.existsSync(file)) {
      return fail(`edit_file: no such file: ${rel(ctx.root, file)}. Use write_file to create it.`);
    }

    const before = fs.readFileSync(file, 'utf8');
    const occurrences = countOccurrences(before, oldString);

    if (occurrences === 0) {
      return fail(
        `edit_file: old_string was not found in ${rel(ctx.root, file)}. ` +
          'Read the file and match its exact current text, including whitespace.',
      );
    }
    if (occurrences > 1 && !replaceAll) {
      return fail(
        `edit_file: old_string appears ${occurrences} times in ${rel(ctx.root, file)}. ` +
          'Add surrounding context to make it unique, or set replace_all=true.',
      );
    }

    const after = replaceAll
      ? before.split(oldString).join(newString)
      : before.replace(oldString, newString);

    const outcome = await ctx.confirm({
      toolName: 'edit_file',
      kind: 'write',
      summary: `Edit ${rel(ctx.root, file)}${replaceAll ? ` (${occurrences} occurrences)` : ''}`,
      detail: previewReplacement(before, after),
    });
    if (outcome === 'reject') {
      throw new ToolDeniedError(`The user declined the edit to ${rel(ctx.root, file)}.`);
    }

    fs.writeFileSync(file, after, 'utf8');

    return ok(
      `Edited ${rel(ctx.root, file)} (${occurrences} replacement${occurrences === 1 ? '' : 's'}).`,
      `edited ${rel(ctx.root, file)}`,
    );
  },
};

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

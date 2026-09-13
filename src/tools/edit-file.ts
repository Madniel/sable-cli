import fs from 'node:fs';

import { ToolDeniedError } from '../util/errors.js';
import { diffStats, unifiedDiff } from '../util/diff.js';
import { applyEdits, pluralize, type EditSpec } from './edits.js';
import { rel, resolveOrThrow, staleFileResult } from './fs-utils.js';
import { objectSchema } from './schema.js';
import { fail, ok, type Tool, type ToolContext, type ToolResult } from './types.js';

export const editFileTool: Tool = {
  name: 'edit_file',
  kind: 'write',
  description: [
    'Replace an exact string in a file. `old_string` must appear exactly once unless',
    'you set `replace_all`. Include enough surrounding context to make the match',
    'unambiguous. Read the file first: an edit against contents you have not seen is',
    'how files get corrupted. To make several changes to one file, use multi_edit.',
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

  async run(params, context: ToolContext): Promise<ToolResult> {
    const file = resolveOrThrow(context.root, String(params['path']), 'edit_file');

    if (!fs.existsSync(file)) {
      return fail(
        `edit_file: no such file: ${rel(context.root, file)}. Use write_file to create it.`,
      );
    }

    const stale = staleFileResult(context, file, 'edit_file');
    if (stale) return stale;

    const edit: EditSpec = {
      oldString: String(params['old_string']),
      newString: String(params['new_string']),
      replaceAll: params['replace_all'] === true,
    };

    const before = fs.readFileSync(file, 'utf8');
    const outcome = applyEdits(before, [edit], rel(context.root, file));

    if (!outcome.applied) return fail(`edit_file: ${outcome.reason}`);

    const stats = diffStats(before, outcome.content);
    const approved = await context.confirm({
      toolName: 'edit_file',
      kind: 'write',
      summary: `Edit ${rel(context.root, file)} (+${stats.added} -${stats.removed})`,
      detail: unifiedDiff(before, outcome.content),
    });

    if (approved === 'reject') {
      throw new ToolDeniedError(`The user declined the edit to ${rel(context.root, file)}.`);
    }

    fs.writeFileSync(file, outcome.content, 'utf8');
    context.files.record(file);

    return ok(
      `Edited ${rel(context.root, file)} (${pluralize(outcome.replacements, 'replacement')}, ` +
        `+${stats.added} -${stats.removed} lines).`,
      `edited ${rel(context.root, file)} (+${stats.added} -${stats.removed})`,
    );
  },
};

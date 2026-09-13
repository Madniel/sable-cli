import fs from 'node:fs';

import { ToolDeniedError, ToolInputError } from '../util/errors.js';
import { diffStats, unifiedDiff } from '../util/diff.js';
import { applyEdits, pluralize, type EditSpec } from './edits.js';
import { rel, resolveOrThrow, staleFileResult } from './fs-utils.js';
import { objectSchema } from './schema.js';
import { fail, ok, type Tool, type ToolContext, type ToolResult } from './types.js';

const MAX_EDITS = 50;

export const multiEditTool: Tool = {
  name: 'multi_edit',
  kind: 'write',
  description: [
    'Apply several exact-string replacements to one file in a single atomic call.',
    'Edits are applied in order, each against the result of the previous one, and',
    'the file is only written if every edit succeeds — so a typo in the last edit',
    'leaves the file untouched rather than half-changed. Prefer this over several',
    'edit_file calls on the same file.',
  ].join(' '),
  schema: objectSchema(
    {
      path: { type: 'string', description: 'File path, relative to the workspace root.' },
      edits: {
        type: 'array',
        description:
          'Edits to apply in order. Each is an object with "old_string", "new_string" ' +
          'and an optional "replace_all" boolean.',
        items: { type: 'object' },
      },
    },
    ['path', 'edits'],
  ),

  summarize(params) {
    const count = Array.isArray(params['edits']) ? params['edits'].length : 0;
    return `multi_edit ${String(params['path'])} (${pluralize(count, 'edit')})`;
  },

  async run(params, context: ToolContext): Promise<ToolResult> {
    const file = resolveOrThrow(context.root, String(params['path']), 'multi_edit');
    const edits = parseEdits(params['edits']);

    if (!fs.existsSync(file)) {
      return fail(
        `multi_edit: no such file: ${rel(context.root, file)}. Use write_file to create it.`,
      );
    }

    const stale = staleFileResult(context, file, 'multi_edit');
    if (stale) return stale;

    const before = fs.readFileSync(file, 'utf8');
    const outcome = applyEdits(before, edits, rel(context.root, file));

    if (!outcome.applied) {
      return fail(`multi_edit: ${outcome.reason} No changes were written.`);
    }

    const stats = diffStats(before, outcome.content);
    const approved = await context.confirm({
      toolName: 'multi_edit',
      kind: 'write',
      summary:
        `Apply ${pluralize(edits.length, 'edit')} to ${rel(context.root, file)} ` +
        `(+${stats.added} -${stats.removed})`,
      detail: unifiedDiff(before, outcome.content),
    });

    if (approved === 'reject') {
      throw new ToolDeniedError(`The user declined the edits to ${rel(context.root, file)}.`);
    }

    fs.writeFileSync(file, outcome.content, 'utf8');
    context.files.record(file);

    return ok(
      `Applied ${pluralize(edits.length, 'edit')} to ${rel(context.root, file)} ` +
        `(${pluralize(outcome.replacements, 'replacement')}, +${stats.added} -${stats.removed} lines).`,
      `edited ${rel(context.root, file)} (+${stats.added} -${stats.removed})`,
    );
  },
};

function parseEdits(value: unknown): EditSpec[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ToolInputError('multi_edit: "edits" must be a non-empty array.');
  }

  if (value.length > MAX_EDITS) {
    throw new ToolInputError(
      `multi_edit: at most ${MAX_EDITS} edits per call, got ${value.length}.`,
    );
  }

  return value.map((entry, index) => toEditSpec(entry, index));
}

function toEditSpec(entry: unknown, index: number): EditSpec {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new ToolInputError(`multi_edit: edits[${index}] must be an object.`);
  }

  const record = entry as Record<string, unknown>;
  const oldString = record['old_string'];
  const newString = record['new_string'];

  if (typeof oldString !== 'string' || typeof newString !== 'string') {
    throw new ToolInputError(
      `multi_edit: edits[${index}] needs string "old_string" and "new_string" fields.`,
    );
  }

  return { oldString, newString, replaceAll: record['replace_all'] === true };
}

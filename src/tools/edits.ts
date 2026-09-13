export interface EditSpec {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

export interface AppliedEdits {
  applied: true;
  content: string;
  replacements: number;
}

export interface RejectedEdits {
  applied: false;
  reason: string;
}

export type EditOutcome = AppliedEdits | RejectedEdits;

export function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;

  let count = 0;
  let index = haystack.indexOf(needle);

  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }

  return count;
}

export function applyEdits(content: string, edits: EditSpec[], label: string): EditOutcome {
  let current = content;
  let replacements = 0;

  for (const [index, edit] of edits.entries()) {
    const position = edits.length > 1 ? `edit ${index + 1}: ` : '';

    if (edit.oldString === edit.newString) {
      return { applied: false, reason: `${position}old_string and new_string are identical.` };
    }

    const occurrences = countOccurrences(current, edit.oldString);

    if (occurrences === 0) {
      return {
        applied: false,
        reason:
          `${position}old_string was not found in ${label}. ` +
          'Read the file and match its exact current text, including whitespace. ' +
          'Note that earlier edits in this call may already have changed it.',
      };
    }

    if (occurrences > 1 && !edit.replaceAll) {
      return {
        applied: false,
        reason:
          `${position}old_string appears ${occurrences} times in ${label}. ` +
          'Add surrounding context to make it unique, or set replace_all.',
      };
    }

    current = edit.replaceAll
      ? current.split(edit.oldString).join(edit.newString)
      : current.replace(edit.oldString, edit.newString);

    replacements += edit.replaceAll ? occurrences : 1;
  }

  return { applied: true, content: current, replacements };
}

export function pluralize(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

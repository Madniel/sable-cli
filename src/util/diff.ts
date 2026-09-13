export type DiffKind = 'context' | 'add' | 'remove';

export interface DiffLine {
  kind: DiffKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface DiffStats {
  added: number;
  removed: number;
}

export interface UnifiedDiffOptions {
  contextLines?: number;
  maxLines?: number;
}

const LCS_LINE_BUDGET = 3000;

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);

  if (oldLines.length > LCS_LINE_BUDGET || newLines.length > LCS_LINE_BUDGET) {
    return wholesaleReplacement(oldLines, newLines);
  }

  const { prefix, suffix } = findCommonEnds(oldLines, newLines);
  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);

  const result: DiffLine[] = [];
  let oldNumber = 1;
  let newNumber = 1;

  for (let i = 0; i < prefix; i++) {
    result.push(contextLine(oldLines[i] ?? '', oldNumber++, newNumber++));
  }

  for (const line of alignMiddle(oldMiddle, newMiddle)) {
    if (line.kind === 'remove') {
      result.push({ ...line, oldLine: oldNumber++, newLine: null });
    } else if (line.kind === 'add') {
      result.push({ ...line, oldLine: null, newLine: newNumber++ });
    } else {
      result.push({ ...line, oldLine: oldNumber++, newLine: newNumber++ });
    }
  }

  for (let i = oldLines.length - suffix; i < oldLines.length; i++) {
    result.push(contextLine(oldLines[i] ?? '', oldNumber++, newNumber++));
  }

  return result;
}

export function diffStats(before: string, after: string): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of diffLines(before, after)) {
    if (line.kind === 'add') added++;
    else if (line.kind === 'remove') removed++;
  }
  return { added, removed };
}

export function buildHunks(lines: DiffLine[], contextLines: number): DiffHunk[] {
  const changedIndexes = lines
    .map((line, index) => (line.kind === 'context' ? -1 : index))
    .filter((index) => index >= 0);

  if (changedIndexes.length === 0) return [];

  const ranges: { from: number; to: number }[] = [];
  for (const index of changedIndexes) {
    const from = Math.max(0, index - contextLines);
    const to = Math.min(lines.length - 1, index + contextLines);
    const last = ranges.at(-1);
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else ranges.push({ from, to });
  }

  return ranges.map((range) => {
    const slice = lines.slice(range.from, range.to + 1);
    return {
      oldStart: firstNumber(slice, 'oldLine'),
      oldCount: slice.filter((line) => line.kind !== 'add').length,
      newStart: firstNumber(slice, 'newLine'),
      newCount: slice.filter((line) => line.kind !== 'remove').length,
      lines: slice,
    };
  });
}

export function unifiedDiff(
  before: string,
  after: string,
  options: UnifiedDiffOptions = {},
): string {
  const contextLines = options.contextLines ?? 3;
  const maxLines = options.maxLines ?? 60;
  const hunks = buildHunks(diffLines(before, after), contextLines);

  if (hunks.length === 0) return '(no changes)';

  const rendered: string[] = [];
  let budget = maxLines;
  let omitted = 0;

  for (const hunk of hunks) {
    if (budget <= 0) {
      omitted += hunk.lines.length + 1;
      continue;
    }
    rendered.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    budget--;

    for (const line of hunk.lines) {
      if (budget <= 0) {
        omitted++;
        continue;
      }
      rendered.push(`${marker(line.kind)}${line.text}`);
      budget--;
    }
  }

  if (omitted > 0) rendered.push(`... ${omitted} more diff lines`);
  return rendered.join('\n');
}

function marker(kind: DiffKind): string {
  if (kind === 'add') return '+';
  if (kind === 'remove') return '-';
  return ' ';
}

function contextLine(text: string, oldLine: number, newLine: number): DiffLine {
  return { kind: 'context', text, oldLine, newLine };
}

function firstNumber(lines: DiffLine[], field: 'oldLine' | 'newLine'): number {
  for (const line of lines) {
    const value = line[field];
    if (value !== null) return value;
  }
  return 1;
}

function findCommonEnds(
  oldLines: string[],
  newLines: string[],
): { prefix: number; suffix: number } {
  const limit = Math.min(oldLines.length, newLines.length);

  let prefix = 0;
  while (prefix < limit && oldLines[prefix] === newLines[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < limit - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  return { prefix, suffix };
}

function alignMiddle(oldLines: string[], newLines: string[]): DiffLine[] {
  if (oldLines.length === 0 && newLines.length === 0) return [];
  if (oldLines.length === 0) return newLines.map((text) => bare('add', text));
  if (newLines.length === 0) return oldLines.map((text) => bare('remove', text));

  const table = longestCommonSubsequenceTable(oldLines, newLines);
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      result.push(bare('context', oldLines[i] ?? ''));
      i++;
      j++;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      result.push(bare('remove', oldLines[i] ?? ''));
      i++;
    } else {
      result.push(bare('add', newLines[j] ?? ''));
      j++;
    }
  }

  while (i < oldLines.length) result.push(bare('remove', oldLines[i++] ?? ''));
  while (j < newLines.length) result.push(bare('add', newLines[j++] ?? ''));

  return result;
}

function longestCommonSubsequenceTable(oldLines: string[], newLines: string[]): number[][] {
  const rows = oldLines.length + 1;
  const columns = newLines.length + 1;
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(columns).fill(0));

  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      const row = table[i] as number[];
      row[j] =
        oldLines[i] === newLines[j]
          ? (table[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(table[i + 1]?.[j] ?? 0, table[i]?.[j + 1] ?? 0);
    }
  }

  return table;
}

function bare(kind: DiffKind, text: string): DiffLine {
  return { kind, text, oldLine: null, newLine: null };
}

function wholesaleReplacement(oldLines: string[], newLines: string[]): DiffLine[] {
  const result: DiffLine[] = [];
  oldLines.forEach((text, index) =>
    result.push({ kind: 'remove', text, oldLine: index + 1, newLine: null }),
  );
  newLines.forEach((text, index) =>
    result.push({ kind: 'add', text, oldLine: null, newLine: index + 1 }),
  );
  return result;
}

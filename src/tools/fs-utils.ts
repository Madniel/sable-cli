import fs from 'node:fs';
import path from 'node:path';

import { ToolInputError } from '../util/errors.js';
import { displayPath, resolveWithin } from '../util/paths.js';

/** Directories never worth walking into for search or listing. */
export const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.cache',
  'coverage',
  '.turbo',
  '.gradle',
  'vendor',
]);

/** Resolve a tool-supplied path inside the workspace, or explain why we won't. */
export function resolveOrThrow(root: string, target: string, toolName: string): string {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new ToolInputError(`${toolName}: "path" must be a non-empty string.`);
  }
  const resolved = resolveWithin(root, target);
  if (!resolved) {
    throw new ToolInputError(
      `${toolName}: "${target}" resolves outside the workspace root (${root}). ` +
        'Only paths inside the workspace can be accessed.',
    );
  }
  return resolved;
}

export function rel(root: string, target: string): string {
  return displayPath(root, target);
}

export function isProbablyBinary(sample: Buffer): boolean {
  const length = Math.min(sample.length, 8000);
  for (let i = 0; i < length; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}

export interface TruncationResult {
  text: string;
  truncated: boolean;
}

export function truncate(text: string, maxChars: number): TruncationResult {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text:
      text.slice(0, maxChars) +
      `\n\n[... truncated ${text.length - maxChars} characters of ${text.length} ...]`,
    truncated: true,
  };
}

export function ensureParentDir(file: string): void {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** A compact unified-diff-ish preview of a single-hunk replacement, for approval prompts. */
export function previewReplacement(before: string, after: string, contextLines = 2): string {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  let start = 0;
  while (
    start < beforeLines.length &&
    start < afterLines.length &&
    beforeLines[start] === afterLines[start]
  ) {
    start++;
  }

  let endBefore = beforeLines.length - 1;
  let endAfter = afterLines.length - 1;
  while (
    endBefore >= start &&
    endAfter >= start &&
    beforeLines[endBefore] === afterLines[endAfter]
  ) {
    endBefore--;
    endAfter--;
  }

  const from = Math.max(0, start - contextLines);
  const lines: string[] = [];

  for (let i = from; i < start; i++) lines.push(`  ${beforeLines[i] ?? ''}`);
  for (let i = start; i <= endBefore; i++) lines.push(`- ${beforeLines[i] ?? ''}`);
  for (let i = start; i <= endAfter; i++) lines.push(`+ ${afterLines[i] ?? ''}`);
  for (
    let i = endBefore + 1;
    i <= Math.min(endBefore + contextLines, beforeLines.length - 1);
    i++
  ) {
    lines.push(`  ${beforeLines[i] ?? ''}`);
  }

  const capped = lines.slice(0, 40);
  if (lines.length > capped.length) capped.push(`  ... ${lines.length - capped.length} more lines`);
  return capped.join('\n');
}

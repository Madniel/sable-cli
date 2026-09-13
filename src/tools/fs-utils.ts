import fs from 'node:fs';
import path from 'node:path';

import { ToolInputError } from '../util/errors.js';
import { displayPath, resolveWithin } from '../util/paths.js';
import { fail, type ToolContext, type ToolResult } from './types.js';

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

const BINARY_SNIFF_BYTES = 8000;
const MAX_WALK_DEPTH = 12;

export interface TruncationResult {
  text: string;
  truncated: boolean;
}

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
  const limit = Math.min(sample.length, BINARY_SNIFF_BYTES);
  for (let index = 0; index < limit; index++) {
    if (sample[index] === 0) return true;
  }
  return false;
}

export function truncate(text: string, maxChars: number): TruncationResult {
  if (text.length <= maxChars) return { text, truncated: false };

  const omitted = text.length - maxChars;
  return {
    text: `${text.slice(0, maxChars)}\n\n[... truncated ${omitted} characters of ${text.length} ...]`,
    truncated: true,
  };
}

export function ensureParentDir(file: string): void {
  const directory = path.dirname(file);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

export function walkFiles(
  directory: string,
  context: ToolContext,
  visit: (file: string) => void,
  depth = 0,
): void {
  if (depth > MAX_WALK_DEPTH || context.signal.aborted) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const child = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      walkFiles(child, context, visit, depth + 1);
    } else if (entry.isFile()) {
      visit(child);
    }
  }
}

export function staleFileResult(
  context: ToolContext,
  file: string,
  toolName: string,
): ToolResult | null {
  if (!context.files.changedSinceRead(file)) return null;

  return fail(
    `${toolName}: ${rel(context.root, file)} changed on disk after you read it. ` +
      'Read it again and reapply your change against the current contents.',
  );
}

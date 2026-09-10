import { homedir } from 'node:os';
import path from 'node:path';

/** Expand a leading `~` to the user's home directory. */
export function expandHome(target: string): string {
  if (target === '~') return homedir();
  if (target.startsWith('~/') || target.startsWith('~\\')) {
    return path.join(homedir(), target.slice(2));
  }
  return target;
}

/** Absolute path to the user-level config directory (`~/.sable`). */
export function userConfigDir(): string {
  const override = process.env['SABLE_CONFIG_DIR'];
  if (override) return path.resolve(expandHome(override));
  return path.join(homedir(), '.sable');
}

/** Absolute path to the project-level config directory (`<root>/.sable`). */
export function projectConfigDir(root: string): string {
  return path.join(root, '.sable');
}

/**
 * Resolve `target` against `root` and assert the result stays inside `root`.
 * Returns null when the path escapes the workspace.
 */
export function resolveWithin(root: string, target: string): string | null {
  const absoluteRoot = path.resolve(root);
  const resolved = path.resolve(absoluteRoot, expandHome(target));
  if (resolved === absoluteRoot) return resolved;
  const prefix = absoluteRoot.endsWith(path.sep) ? absoluteRoot : absoluteRoot + path.sep;
  return resolved.startsWith(prefix) ? resolved : null;
}

/** Render an absolute path relative to `root` for display (never escapes into `../../..` soup). */
export function displayPath(root: string, target: string): string {
  const relative = path.relative(root, target);
  if (!relative) return '.';
  return relative.startsWith('..') ? target : relative;
}

/** Shorten a path for prompts by collapsing the home directory to `~`. */
export function tildify(target: string): string {
  const home = homedir();
  return target === home || target.startsWith(home + path.sep)
    ? '~' + target.slice(home.length)
    : target;
}

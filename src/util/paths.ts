import { homedir } from 'node:os';
import path from 'node:path';

export function expandHome(target: string): string {
  if (target === '~') return homedir();
  if (target.startsWith('~/') || target.startsWith('~\\')) {
    return path.join(homedir(), target.slice(2));
  }
  return target;
}

export function userConfigDir(): string {
  const override = process.env['SABLE_CONFIG_DIR'];
  return override ? path.resolve(expandHome(override)) : path.join(homedir(), '.sable');
}

export function sessionStoreDir(): string {
  return path.join(userConfigDir(), 'sessions');
}

export function projectConfigDir(root: string): string {
  return path.join(root, '.sable');
}

export function resolveWithin(root: string, target: string): string | null {
  const absoluteRoot = path.resolve(root);
  const resolved = path.resolve(absoluteRoot, expandHome(target));
  if (resolved === absoluteRoot) return resolved;

  const boundary = absoluteRoot.endsWith(path.sep) ? absoluteRoot : absoluteRoot + path.sep;
  return resolved.startsWith(boundary) ? resolved : null;
}

export function displayPath(root: string, target: string): string {
  const relative = path.relative(root, target);
  if (!relative) return '.';
  return relative.startsWith('..') ? target : relative;
}

export function tildify(target: string): string {
  const home = homedir();
  const insideHome = target === home || target.startsWith(home + path.sep);
  return insideHome ? '~' + target.slice(home.length) : target;
}

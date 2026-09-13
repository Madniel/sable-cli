import fs from 'node:fs';

interface FileSnapshot {
  mtimeMs: number;
  size: number;
}

export class FileTracker {
  private readonly snapshots = new Map<string, FileSnapshot>();

  record(file: string): void {
    const snapshot = snapshotOf(file);
    if (snapshot) this.snapshots.set(file, snapshot);
  }

  forget(file: string): void {
    this.snapshots.delete(file);
  }

  hasSeen(file: string): boolean {
    return this.snapshots.has(file);
  }

  changedSinceRead(file: string): boolean {
    const remembered = this.snapshots.get(file);
    if (!remembered) return false;

    const current = snapshotOf(file);
    if (!current) return true;

    return current.mtimeMs !== remembered.mtimeMs || current.size !== remembered.size;
  }

  seenFiles(): string[] {
    return [...this.snapshots.keys()];
  }
}

function snapshotOf(file: string): FileSnapshot | null {
  try {
    const stat = fs.statSync(file);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

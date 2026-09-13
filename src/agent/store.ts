import fs from 'node:fs';
import path from 'node:path';

import { sessionStoreDir } from '../util/paths.js';
import type { SessionSnapshot } from './session.js';

const FILE_EXTENSION = '.json';
const MAX_LISTED = 50;

export interface SessionSummary {
  id: string;
  title: string;
  model: string;
  provider: string;
  workspaceRoot: string;
  turns: number;
  updatedAt: string;
}

export function saveSnapshot(snapshot: SessionSnapshot, directory = sessionStoreDir()): string {
  fs.mkdirSync(directory, { recursive: true });

  const file = path.join(directory, `${snapshot.id}${FILE_EXTENSION}`);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), 'utf8');

  return file;
}

export function loadSnapshot(id: string, directory = sessionStoreDir()): SessionSnapshot | null {
  const file = path.join(directory, `${id}${FILE_EXTENSION}`);
  return readSnapshot(file);
}

export function listSessions(limit = MAX_LISTED, directory = sessionStoreDir()): SessionSummary[] {
  if (!fs.existsSync(directory)) return [];

  const summaries: SessionSummary[] = [];

  for (const entry of fs.readdirSync(directory)) {
    if (!entry.endsWith(FILE_EXTENSION)) continue;

    const snapshot = readSnapshot(path.join(directory, entry));
    if (snapshot) summaries.push(toSummary(snapshot));
  }

  return summaries
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, limit);
}

export function mostRecentSession(
  workspaceRoot: string,
  directory = sessionStoreDir(),
): SessionSnapshot | null {
  const candidates = listSessions(MAX_LISTED, directory).filter(
    (summary) => summary.workspaceRoot === workspaceRoot,
  );

  const latest = candidates[0];
  return latest ? loadSnapshot(latest.id, directory) : null;
}

export function findSession(
  idPrefix: string,
  directory = sessionStoreDir(),
): SessionSnapshot | null {
  const exact = loadSnapshot(idPrefix, directory);
  if (exact) return exact;

  const match = listSessions(MAX_LISTED, directory).find((summary) =>
    summary.id.startsWith(idPrefix),
  );

  return match ? loadSnapshot(match.id, directory) : null;
}

export function deleteSession(id: string, directory = sessionStoreDir()): boolean {
  const file = path.join(directory, `${id}${FILE_EXTENSION}`);
  if (!fs.existsSync(file)) return false;

  fs.rmSync(file);
  return true;
}

function readSnapshot(file: string): SessionSnapshot | null {
  if (!fs.existsSync(file)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionSnapshot;
    return Array.isArray(parsed.messages) && typeof parsed.id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function toSummary(snapshot: SessionSnapshot): SessionSummary {
  return {
    id: snapshot.id,
    title: snapshot.title,
    model: snapshot.model,
    provider: snapshot.provider,
    workspaceRoot: snapshot.workspaceRoot,
    turns: snapshot.turns,
    updatedAt: snapshot.updatedAt,
  };
}

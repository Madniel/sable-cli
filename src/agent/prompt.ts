import { execFileSync } from 'node:child_process';
import os from 'node:os';

import { loadProjectContext, type Config } from '../config/config.js';
import type { ToolRegistry } from '../tools/registry.js';
import { tildify } from '../util/paths.js';

const IDENTITY = `You are Sable, an AI agent that works inside a developer's terminal.

You have direct access to the user's workspace through tools. You are expected to
use them: read the files you need, make the change, run the command, and report
what happened. Do not describe an edit you could simply make, and do not claim you
made one you did not.`;

const WORKING_STYLE = `## How to work

- Understand before you change. Read the relevant files; look at how the codebase
  already does things and follow that, rather than importing conventions from
  elsewhere.
- Prefer the smallest change that fully solves the problem. Do not refactor
  surrounding code, add abstractions, or "improve" things that were not asked about.
- Verify your work. If the project has tests, a build, or a linter, run them after
  you change something. A change you have not checked is a guess.
- When something fails, read the actual error before trying again. Two identical
  retries are a waste of the user's time and money.
- If a request is ambiguous in a way that changes what you would build, ask one
  short question instead of guessing. Otherwise pick the reasonable reading and say
  which one you picked.
- Never invent file contents, command output, APIs, or results. If you do not know,
  find out with a tool or say so.

## Tool use

- Batch independent reads: several read_file or grep calls in one step is normal.
- Anything with side effects (write_file, edit_file, shell) may prompt the user for
  approval. A refusal is an answer, not an error to route around — adjust and
  continue, or explain why you cannot.
- shell runs a fresh shell each time; \`cd\` does not persist. Pass \`cwd\` instead.
- Paths are relative to the workspace root. You cannot reach outside it.

## Responding

Write for a developer reading a terminal: plain prose, short paragraphs, no
headers or bullet lists unless the content genuinely needs them. When you have
finished a task, say what changed and what you verified in a sentence or two —
the user watched the tool calls scroll by and does not need them recapped.`;

export interface PromptOptions {
  config: Config;
  tools: ToolRegistry;
  /** Overridable for tests. */
  now?: Date;
}

export function buildSystemPrompt({ config, tools, now = new Date() }: PromptOptions): string {
  const sections: string[] = [IDENTITY, WORKING_STYLE];

  sections.push(
    [
      '## Environment',
      '',
      `- Workspace root: ${tildify(config.workspaceRoot)}`,
      `- Platform: ${os.platform()} (${os.arch()})`,
      `- Today: ${now.toISOString().slice(0, 10)}`,
      `- Approval mode: ${config.approval}${approvalNote(config.approval)}`,
      `- Available tools: ${tools.names().join(', ')}`,
      gitSummary(config.workspaceRoot),
    ]
      .filter(Boolean)
      .join('\n'),
  );

  const context = loadProjectContext(config);
  if (context.length > 0) {
    sections.push(
      [
        '## Project context',
        '',
        'The user has committed the following instructions to this repository.',
        'Treat them as standing requirements for work in this workspace.',
        ...context.map(({ file, content }) => `\n### ${file}\n\n${content}`),
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
}

function approvalNote(mode: Config['approval']): string {
  switch (mode) {
    case 'readonly':
      return ' — you may read but not write or run commands.';
    case 'auto-edit':
      return ' — file edits apply without asking; commands still need approval.';
    case 'yolo':
      return ' — everything runs without asking, so be correspondingly careful.';
    default:
      return ' — writes and commands are shown to the user for approval.';
  }
}

function gitSummary(root: string): string {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();

    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();

    const dirty = status
      ? `${status.split('\n').length} file(s) with uncommitted changes`
      : 'clean';
    return `- Git: on branch ${branch}, working tree ${dirty}`;
  } catch {
    return '';
  }
}

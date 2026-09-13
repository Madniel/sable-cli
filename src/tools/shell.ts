import { spawn } from 'node:child_process';

import { ToolDeniedError } from '../util/errors.js';
import { rel, resolveOrThrow, truncate } from './fs-utils.js';
import { objectSchema } from './schema.js';
import { fail, ok, type Tool, type ToolContext, type ToolResult } from './types.js';

const MAX_OUTPUT_CHARS = 30_000;
const OUTPUT_HARD_LIMIT = MAX_OUTPUT_CHARS * 4;
const SIGKILL_GRACE_MS = 2000;
const SUMMARY_LENGTH = 90;

interface RiskPattern {
  pattern: RegExp;
  description: string;
}

const RISK_PATTERNS: RiskPattern[] = [
  { pattern: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rf]/, description: 'recursive or forced delete' },
  { pattern: /\bmkfs(\.|\s)/, description: 'formats a filesystem' },
  { pattern: /\bdd\s+if=/, description: 'raw disk write' },
  { pattern: /:\(\)\s*\{.*\}\s*;\s*:/, description: 'fork bomb' },
  {
    pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh/,
    description: 'pipes a download straight into a shell',
  },
  { pattern: /\bgit\s+push\b.*(--force|-f)\b/, description: 'force push' },
  { pattern: /\bsudo\b/, description: 'runs as root' },
  { pattern: />\s*\/dev\/(sd|nvme|disk)/, description: 'writes to a block device' },
];

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
}

export const shellTool: Tool = {
  name: 'shell',
  kind: 'execute',
  description: [
    'Run a shell command inside the workspace and return its output. Use it for',
    'builds, tests, git, and anything the file tools do not cover. Prefer the',
    'dedicated file tools for reading and editing — they are cheaper and safer.',
    'Each call runs in a fresh shell, so `cd` does not persist between calls;',
    'pass `cwd` instead.',
  ].join(' '),
  schema: objectSchema(
    {
      command: { type: 'string', description: 'The command line to execute.' },
      cwd: {
        type: 'string',
        description: 'Working directory, relative to the workspace root. Defaults to the root.',
        default: '.',
      },
      timeout_ms: {
        type: 'integer',
        description: 'Kill the command after this many milliseconds.',
        minimum: 1000,
        maximum: 600_000,
      },
    },
    ['command'],
  ),

  summarize(params) {
    const command = String(params['command']).replace(/\s+/g, ' ').trim();
    return command.length > SUMMARY_LENGTH ? `${command.slice(0, SUMMARY_LENGTH - 3)}...` : command;
  },

  async run(params, context: ToolContext): Promise<ToolResult> {
    const command = String(params['command']).trim();
    if (!command) return fail('shell: command is empty.');

    const cwd = resolveOrThrow(context.root, String(params['cwd'] ?? '.'), 'shell');
    const timeoutMs = Number(params['timeout_ms'] ?? context.config.shellTimeoutMs);

    const approved = await context.confirm({
      toolName: 'shell',
      kind: 'execute',
      summary: `Run: ${this.summarize(params)}`,
      detail: approvalDetail(command, rel(context.root, cwd)),
    });

    if (approved === 'reject') {
      throw new ToolDeniedError(`The user declined to run: ${command}`);
    }

    const result = await execute(command, cwd, timeoutMs, context);
    const output = `${statusLine(result, timeoutMs)}\n\n${combineStreams(result)}`;
    const failed = result.timedOut || result.cancelled || (result.code ?? 1) !== 0;

    return failed ? fail(output) : ok(output, `ran: ${this.summarize(params)}`);
  },
};

function approvalDetail(command: string, workingDirectory: string): string {
  const risks = RISK_PATTERNS.filter(({ pattern }) => pattern.test(command)).map(
    ({ description }) => description,
  );

  return [
    `$ ${command}`,
    `  in ${workingDirectory}`,
    ...(risks.length > 0 ? [`  ! ${risks.join('; ')}`] : []),
  ].join('\n');
}

function statusLine(result: CommandResult, timeoutMs: number): string {
  if (result.cancelled) return 'Command cancelled by the user.';
  if (result.timedOut) return `Command timed out after ${timeoutMs}ms.`;
  return `Exit code: ${result.code ?? 'unknown'}`;
}

function combineStreams(result: CommandResult): string {
  const sections: string[] = [];

  if (result.stdout.trim()) sections.push(result.stdout.trimEnd());
  if (result.stderr.trim()) sections.push(`[stderr]\n${result.stderr.trimEnd()}`);
  if (sections.length === 0) sections.push('(no output)');

  return truncate(sections.join('\n\n'), MAX_OUTPUT_CHARS).text;
}

function execute(
  command: string,
  cwd: string,
  timeoutMs: number,
  context: ToolContext,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/bash';
    const args = isWindows ? ['/c', command] : ['-c', command];

    const child = spawn(shell, args, {
      cwd,
      env: { ...process.env, SABLE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const state: CommandResult = {
      code: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      cancelled: false,
    };

    let settled = false;

    const terminate = () => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, SIGKILL_GRACE_MS).unref?.();
    };

    const timer = setTimeout(() => {
      state.timedOut = true;
      terminate();
    }, timeoutMs);

    const onAbort = () => {
      state.cancelled = true;
      terminate();
    };

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal.removeEventListener('abort', onAbort);
      resolve({ ...state, code });
    };

    context.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      state.stdout = appendCapped(state.stdout, chunk.toString('utf8'));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      state.stderr = appendCapped(state.stderr, chunk.toString('utf8'));
    });

    child.on('error', (error) => {
      state.stderr = appendCapped(state.stderr, `\n${error.message}`);
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

function appendCapped(existing: string, addition: string): string {
  const combined = existing + addition;
  return combined.length > OUTPUT_HARD_LIMIT ? combined.slice(-MAX_OUTPUT_CHARS * 2) : combined;
}

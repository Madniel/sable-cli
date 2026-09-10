import { spawn } from 'node:child_process';

import { ToolDeniedError } from '../util/errors.js';
import { objectSchema } from './schema.js';
import { rel, resolveOrThrow, truncate } from './fs-utils.js';
import { fail, ok, type Tool, type ToolContext, type ToolResult } from './types.js';

const MAX_OUTPUT_CHARS = 30_000;

/** Patterns that deserve a loud warning in the approval prompt. */
const DANGEROUS_PATTERNS: { pattern: RegExp; why: string }[] = [
  { pattern: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rf]/, why: 'recursive or forced delete' },
  { pattern: /\bmkfs(\.|\s)/, why: 'formats a filesystem' },
  { pattern: /\bdd\s+if=/, why: 'raw disk write' },
  { pattern: /:\(\)\s*\{.*\}\s*;\s*:/, why: 'fork bomb' },
  {
    pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh/,
    why: 'pipes a download straight into a shell',
  },
  { pattern: /\bgit\s+push\b.*(--force|-f)\b/, why: 'force push' },
  { pattern: /\bsudo\b/, why: 'runs as root' },
  { pattern: />\s*\/dev\/(sd|nvme|disk)/, why: 'writes to a block device' },
];

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
    return command.length > 90 ? `${command.slice(0, 87)}...` : command;
  },

  async run(params, ctx: ToolContext): Promise<ToolResult> {
    const command = String(params['command']).trim();
    if (!command) return fail('shell: command is empty.');

    const cwd = resolveOrThrow(ctx.root, String(params['cwd'] ?? '.'), 'shell');
    const timeout = (params['timeout_ms'] as number | undefined) ?? ctx.config.shellTimeoutMs;

    const risks = DANGEROUS_PATTERNS.filter(({ pattern }) => pattern.test(command)).map(
      ({ why }) => why,
    );

    const outcome = await ctx.confirm({
      toolName: 'shell',
      kind: 'execute',
      summary: `Run: ${this.summarize(params)}`,
      detail: [
        `$ ${command}`,
        `  in ${rel(ctx.root, cwd)}`,
        ...(risks.length ? [`  ⚠ ${risks.join('; ')}`] : []),
      ].join('\n'),
    });
    if (outcome === 'reject') {
      throw new ToolDeniedError(`The user declined to run: ${command}`);
    }

    const result = await execute(command, cwd, timeout, ctx);

    const parts: string[] = [];
    if (result.stdout.trim()) parts.push(result.stdout.trimEnd());
    if (result.stderr.trim()) parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
    if (parts.length === 0) parts.push('(no output)');

    const body = truncate(parts.join('\n\n'), MAX_OUTPUT_CHARS).text;
    const status = result.timedOut
      ? `Command timed out after ${timeout}ms.`
      : `Exit code: ${result.code ?? 'unknown'}`;

    const output = `${status}\n\n${body}`;
    const failed = result.timedOut || (result.code ?? 1) !== 0;

    return failed ? { output, isError: true } : ok(output, `ran: ${this.summarize(params)}`);
  },
};

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function execute(
  command: string,
  cwd: string,
  timeoutMs: number,
  ctx: ToolContext,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
    const args = process.platform === 'win32' ? ['/c', command] : ['-c', command];

    const child = spawn(shell, args, {
      cwd,
      env: { ...process.env, SABLE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut });
    };

    const kill = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.killed || child.kill('SIGKILL'), 2000).unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);

    const onAbort = () => {
      timedOut = false;
      stderr += '\n[cancelled by user]';
      kill();
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > MAX_OUTPUT_CHARS * 4) stdout = stdout.slice(-MAX_OUTPUT_CHARS * 2);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > MAX_OUTPUT_CHARS * 4) stderr = stderr.slice(-MAX_OUTPUT_CHARS * 2);
    });

    child.on('error', (error) => {
      stderr += `\n${error.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

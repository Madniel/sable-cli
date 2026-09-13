#!/usr/bin/env node
import { Session, type SessionSnapshot } from './agent/session.js';
import { findSession, mostRecentSession } from './agent/store.js';
import { helpText, parseArgs, type ParsedArgs } from './cli/args.js';
import { EXIT_FAILED, readStdin, runOneShot } from './cli/oneshot.js';
import { Repl } from './cli/repl.js';
import { credentialEnvName, loadConfig, type Config } from './config/config.js';
import { createProvider } from './providers/index.js';
import { ToolRegistry } from './tools/registry.js';
import { setColorEnabled, style } from './util/ansi.js';
import { errorMessage } from './util/errors.js';
import { setLogLevel } from './util/logger.js';
import { VERSION } from './version.js';

const EXIT_USAGE = 64;
const EXIT_CONFIG = 78;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: ParsedArgs;

  try {
    args = parseArgs(argv);
  } catch (error) {
    return reportFatal(errorMessage(error), EXIT_USAGE);
  }

  if (args.color !== undefined) setColorEnabled(args.color);
  if (args.debug) setLogLevel('debug');

  if (args.help) {
    process.stdout.write(`${helpText(VERSION)}\n`);
    return 0;
  }

  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  let config: Config;

  try {
    config = loadConfig(overridesFrom(args));
  } catch (error) {
    return reportFatal(errorMessage(error), EXIT_CONFIG);
  }

  if (!config.apiKey) {
    return reportFatal(
      `no ${credentialEnvName(config.provider)} found.\n` +
        `  Set it in your shell:  ${style.cyan(`export ${credentialEnvName(config.provider)}=...`)}`,
      EXIT_CONFIG,
    );
  }

  const restored = restoreRequested(args, config);
  if (restored === 'not-found') {
    return reportFatal(
      `no session found for "${args.resume}". List them with /sessions.`,
      EXIT_USAGE,
    );
  }

  const provider = createProvider(config);
  const tools = config.approval === 'readonly' ? new ToolRegistry().readOnly() : new ToolRegistry();
  const session = buildSession(config, restored);

  const piped = args.prompt ? '' : await readStdin();
  const prompt = args.prompt ?? (piped || undefined);
  const interactive = !args.print && process.stdin.isTTY === true;

  try {
    if (interactive) {
      const repl = new Repl({ config, provider, tools, session, initialPrompt: prompt });
      return await repl.start();
    }

    if (!prompt) {
      return reportFatal(
        'nothing to do. Pass a prompt, pipe one in, or run in a terminal for the interactive session.',
        EXIT_USAGE,
      );
    }

    return await runOneShot({ config, provider, tools, session, prompt, json: args.json });
  } catch (error) {
    if (args.debug && error instanceof Error && error.stack) {
      process.stderr.write(`${style.gray(error.stack)}\n`);
    }
    return reportFatal(errorMessage(error), EXIT_FAILED);
  }
}

function overridesFrom(args: ParsedArgs): Partial<Config> {
  return {
    ...(args.provider !== undefined ? { provider: args.provider } : {}),
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.cwd !== undefined ? { workspaceRoot: args.cwd } : {}),
    ...(args.approval !== undefined ? { approval: args.approval } : {}),
    ...(args.maxSteps !== undefined ? { maxSteps: args.maxSteps } : {}),
    ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
    ...(args.compactAt !== undefined ? { compactAtTokens: args.compactAt } : {}),
    ...(args.persist !== undefined ? { persistSessions: args.persist } : {}),
  };
}

function restoreRequested(args: ParsedArgs, config: Config): SessionSnapshot | null | 'not-found' {
  if (args.resume) return findSession(args.resume) ?? 'not-found';
  if (args.continueLatest) return mostRecentSession(config.workspaceRoot);
  return null;
}

function buildSession(config: Config, restored: SessionSnapshot | null): Session {
  const session = new Session({
    provider: config.provider,
    model: config.model,
    workspaceRoot: config.workspaceRoot,
    ...(restored ? { id: restored.id } : {}),
  });

  if (restored) session.restore(restored);
  return session;
}

function reportFatal(message: string, code: number): number {
  process.stderr.write(`${style.red('error: ')}${message}\n`);
  return code;
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isEntrypoint) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${style.red('fatal: ')}${errorMessage(error)}\n`);
      process.exitCode = EXIT_FAILED;
    });
}

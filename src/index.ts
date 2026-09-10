#!/usr/bin/env node
import { Session } from './agent/session.js';
import { helpText, parseArgs } from './cli/args.js';
import { readStdin, runOneShot } from './cli/oneshot.js';
import { Repl } from './cli/repl.js';
import { loadConfig, type Config } from './config/config.js';
import { createProvider } from './providers/index.js';
import { ToolRegistry } from './tools/registry.js';
import { setColorEnabled, style } from './util/ansi.js';
import { SableError, errorMessage } from './util/errors.js';
import { setLogLevel } from './util/logger.js';
import { VERSION } from './version.js';

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${style.red('error: ')}${errorMessage(error)}\n`);
    return 64;
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
    config = loadConfig({
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.cwd !== undefined ? { workspaceRoot: args.cwd } : {}),
      ...(args.approval !== undefined ? { approval: args.approval } : {}),
      ...(args.maxSteps !== undefined ? { maxSteps: args.maxSteps } : {}),
      ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
    });
  } catch (error) {
    process.stderr.write(`${style.red('error: ')}${errorMessage(error)}\n`);
    return 78;
  }

  if (!config.apiKey) {
    process.stderr.write(
      `${style.red('error: ')}no ANTHROPIC_API_KEY found.\n` +
        `  Set it in your shell:  ${style.cyan('export ANTHROPIC_API_KEY=sk-ant-...')}\n`,
    );
    return 78;
  }

  const provider = createProvider(config);
  const tools = config.approval === 'readonly' ? new ToolRegistry().readOnly() : new ToolRegistry();
  const session = new Session(config.model);

  // A piped prompt wins over a positional one only when there is no positional one.
  const piped = args.prompt ? '' : await readStdin();
  const prompt = args.prompt ?? (piped || undefined);

  const interactive = !args.print && process.stdin.isTTY === true;

  try {
    if (interactive) {
      const repl = new Repl({ config, provider, tools, session, initialPrompt: prompt });
      return await repl.start();
    }

    if (!prompt) {
      process.stderr.write(
        `${style.red('error: ')}nothing to do. Pass a prompt, pipe one in, or run in a terminal for the interactive session.\n`,
      );
      return 64;
    }

    return await runOneShot({ config, provider, tools, session, prompt, json: args.json });
  } catch (error) {
    const message = error instanceof SableError ? error.message : errorMessage(error);
    process.stderr.write(`${style.red('error: ')}${message}\n`);
    if (args.debug && error instanceof Error && error.stack) {
      process.stderr.write(`${style.gray(error.stack)}\n`);
    }
    return 1;
  }
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
      process.exitCode = 1;
    });
}

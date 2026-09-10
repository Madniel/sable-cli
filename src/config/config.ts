import fs from 'node:fs';
import path from 'node:path';

import { ConfigError } from '../util/errors.js';
import { projectConfigDir, userConfigDir } from '../util/paths.js';

export type ApprovalMode = 'readonly' | 'prompt' | 'auto-edit' | 'yolo';

export const APPROVAL_MODES: ApprovalMode[] = ['readonly', 'prompt', 'auto-edit', 'yolo'];

export interface Config {
  /** Provider id, e.g. `anthropic`. */
  provider: string;
  /** Model identifier passed to the provider. */
  model: string;
  /** Maximum tokens the model may produce per turn. */
  maxTokens: number;
  /** Sampling temperature; undefined leaves the provider default in place. */
  temperature: number | undefined;
  /** How much the agent may do without asking. */
  approval: ApprovalMode;
  /** Hard ceiling on model round-trips in a single turn, to stop runaway loops. */
  maxSteps: number;
  /** Workspace root. Tools refuse to touch anything outside it. */
  workspaceRoot: string;
  /** Per-command timeout for the shell tool, in milliseconds. */
  shellTimeoutMs: number;
  /** Extra project context files to load into the system prompt. */
  contextFiles: string[];
  /** Provider API key. Never written to disk by the CLI. */
  apiKey: string | undefined;
  /** Override for the provider base URL (proxies, gateways, local mocks). */
  baseUrl: string | undefined;
}

export const DEFAULT_CONFIG: Omit<Config, 'workspaceRoot' | 'apiKey' | 'baseUrl'> = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  maxTokens: 8192,
  temperature: undefined,
  approval: 'prompt',
  maxSteps: 40,
  shellTimeoutMs: 120_000,
  contextFiles: ['SABLE.md', '.sable/SABLE.md', 'AGENTS.md'],
};

/** The subset of Config that may be set in a config file. */
type FileConfig = Partial<
  Pick<
    Config,
    | 'provider'
    | 'model'
    | 'maxTokens'
    | 'temperature'
    | 'approval'
    | 'maxSteps'
    | 'shellTimeoutMs'
    | 'contextFiles'
    | 'baseUrl'
  >
>;

function readJsonFile(file: string): FileConfig {
  if (!fs.existsSync(file)) return {};
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (cause) {
    throw new ConfigError(`Could not read config file ${file}`, cause);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('config must be a JSON object');
    }
    return parsed as FileConfig;
  } catch (cause) {
    throw new ConfigError(`Invalid JSON in ${file}: ${(cause as Error).message}`, cause);
  }
}

function envConfig(): FileConfig & { apiKey?: string } {
  const out: FileConfig & { apiKey?: string } = {};
  const model = process.env['SABLE_MODEL'];
  if (model) out.model = model;

  const maxTokens = process.env['SABLE_MAX_TOKENS'];
  if (maxTokens) out.maxTokens = Number(maxTokens);

  const maxSteps = process.env['SABLE_MAX_STEPS'];
  if (maxSteps) out.maxSteps = Number(maxSteps);

  const temperature = process.env['SABLE_TEMPERATURE'];
  if (temperature) out.temperature = Number(temperature);

  const approval = process.env['SABLE_APPROVAL'];
  if (approval) out.approval = approval as ApprovalMode;

  const baseUrl = process.env['ANTHROPIC_BASE_URL'];
  if (baseUrl) out.baseUrl = baseUrl;

  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (apiKey) out.apiKey = apiKey;

  return out;
}

function validate(config: Config): Config {
  if (!APPROVAL_MODES.includes(config.approval)) {
    throw new ConfigError(
      `Unknown approval mode "${config.approval}". Expected one of: ${APPROVAL_MODES.join(', ')}.`,
    );
  }
  if (!Number.isFinite(config.maxTokens) || config.maxTokens < 1) {
    throw new ConfigError(`maxTokens must be a positive number, got ${config.maxTokens}.`);
  }
  if (!Number.isFinite(config.maxSteps) || config.maxSteps < 1) {
    throw new ConfigError(`maxSteps must be a positive number, got ${config.maxSteps}.`);
  }
  if (config.temperature !== undefined && !Number.isFinite(config.temperature)) {
    throw new ConfigError(`temperature must be a number, got ${config.temperature}.`);
  }
  return config;
}

/**
 * Resolve configuration from, in increasing order of precedence:
 * built-in defaults, `~/.sable/config.json`, `<workspace>/.sable/config.json`,
 * environment variables, then explicit CLI overrides.
 */
export function loadConfig(overrides: Partial<Config> = {}): Config {
  const workspaceRoot = path.resolve(overrides.workspaceRoot ?? process.cwd());

  const user = readJsonFile(path.join(userConfigDir(), 'config.json'));
  const project = readJsonFile(path.join(projectConfigDir(workspaceRoot), 'config.json'));
  const env = envConfig();

  const merged: Config = {
    ...DEFAULT_CONFIG,
    apiKey: undefined,
    baseUrl: undefined,
    ...stripUndefined(user),
    ...stripUndefined(project),
    ...stripUndefined(env),
    ...stripUndefined(overrides),
    workspaceRoot,
  };

  return validate(merged);
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key as keyof T] = entry as T[keyof T];
  }
  return out;
}

/** Load project context files (SABLE.md and friends) that get injected into the system prompt. */
export function loadProjectContext(config: Config): { file: string; content: string }[] {
  const found: { file: string; content: string }[] = [];
  for (const candidate of config.contextFiles) {
    const file = path.resolve(config.workspaceRoot, candidate);
    if (!file.startsWith(config.workspaceRoot)) continue;
    if (!fs.existsSync(file)) continue;
    try {
      const content = fs.readFileSync(file, 'utf8').trim();
      if (content) found.push({ file: candidate, content });
    } catch {
      // A context file we cannot read is not worth failing the session over.
    }
  }
  return found;
}

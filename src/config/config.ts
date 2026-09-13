import fs from 'node:fs';
import path from 'node:path';

import { ConfigError } from '../util/errors.js';
import { projectConfigDir, userConfigDir } from '../util/paths.js';

export type ApprovalMode = 'readonly' | 'prompt' | 'auto-edit' | 'yolo';

export const APPROVAL_MODES: ApprovalMode[] = ['readonly', 'prompt', 'auto-edit', 'yolo'];

export const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4.1',
};

export interface Credentials {
  apiKey: string | undefined;
  baseUrl: string | undefined;
}

const CREDENTIAL_ENV: Record<string, { key: string; url: string }> = {
  anthropic: { key: 'ANTHROPIC_API_KEY', url: 'ANTHROPIC_BASE_URL' },
  openai: { key: 'OPENAI_API_KEY', url: 'OPENAI_BASE_URL' },
};

export interface Config {
  provider: string;
  model: string;
  maxTokens: number;
  temperature: number | undefined;
  approval: ApprovalMode;
  maxSteps: number;
  workspaceRoot: string;
  shellTimeoutMs: number;
  contextFiles: string[];
  compactAtTokens: number;
  persistSessions: boolean;
  apiKey: string | undefined;
  baseUrl: string | undefined;
}

export type ConfigDefaults = Omit<Config, 'workspaceRoot' | 'apiKey' | 'baseUrl' | 'model'>;

export const DEFAULT_CONFIG: ConfigDefaults = {
  provider: 'anthropic',
  maxTokens: 8192,
  temperature: undefined,
  approval: 'prompt',
  maxSteps: 40,
  shellTimeoutMs: 120_000,
  contextFiles: ['SABLE.md', '.sable/SABLE.md', 'AGENTS.md'],
  compactAtTokens: 120_000,
  persistSessions: true,
};

export type FileConfig = Partial<
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
    | 'compactAtTokens'
    | 'persistSessions'
    | 'baseUrl'
  >
>;

export interface ProjectContextFile {
  file: string;
  content: string;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const workspaceRoot = path.resolve(overrides.workspaceRoot ?? process.cwd());

  const layers: FileConfig[] = [
    readConfigFile(path.join(userConfigDir(), 'config.json')),
    readConfigFile(path.join(projectConfigDir(workspaceRoot), 'config.json')),
    readEnvironment(),
    definedEntriesOf(overrides),
  ];

  const merged = layers.reduce<FileConfig>(
    (accumulated, layer) => ({ ...accumulated, ...definedEntriesOf(layer) }),
    {},
  );

  const provider = merged.provider ?? DEFAULT_CONFIG.provider;
  const model = merged.model ?? DEFAULT_MODELS[provider] ?? DEFAULT_MODELS['anthropic'] ?? '';
  const credentials = resolveCredentials(provider, overrides, merged);

  return validate({
    ...DEFAULT_CONFIG,
    ...merged,
    provider,
    model,
    workspaceRoot,
    apiKey: credentials.apiKey,
    baseUrl: credentials.baseUrl,
  });
}

export function loadProjectContext(config: Config): ProjectContextFile[] {
  const found: ProjectContextFile[] = [];

  for (const candidate of config.contextFiles) {
    const file = path.resolve(config.workspaceRoot, candidate);
    if (!file.startsWith(config.workspaceRoot) || !fs.existsSync(file)) continue;

    try {
      const content = fs.readFileSync(file, 'utf8').trim();
      if (content) found.push({ file: candidate, content });
    } catch {
      continue;
    }
  }

  return found;
}

export function credentialEnvName(provider: string): string {
  return CREDENTIAL_ENV[provider]?.key ?? 'ANTHROPIC_API_KEY';
}

function resolveCredentials(
  provider: string,
  overrides: Partial<Config>,
  merged: FileConfig,
): Credentials {
  const names = CREDENTIAL_ENV[provider];
  return {
    apiKey: overrides.apiKey ?? (names ? process.env[names.key] : undefined),
    baseUrl: overrides.baseUrl ?? (names ? process.env[names.url] : undefined) ?? merged.baseUrl,
  };
}

function readConfigFile(file: string): FileConfig {
  if (!fs.existsSync(file)) return {};

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (cause) {
    throw new ConfigError(`Could not read config file ${file}`, cause);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError(`Invalid JSON in ${file}: ${(cause as Error).message}`, cause);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`Invalid config in ${file}: expected a JSON object.`);
  }

  return parsed as FileConfig;
}

function readEnvironment(): FileConfig {
  const fromEnv: FileConfig = {};
  const env = process.env;

  if (env['SABLE_PROVIDER']) fromEnv.provider = env['SABLE_PROVIDER'];
  if (env['SABLE_MODEL']) fromEnv.model = env['SABLE_MODEL'];
  if (env['SABLE_MAX_TOKENS']) fromEnv.maxTokens = Number(env['SABLE_MAX_TOKENS']);
  if (env['SABLE_MAX_STEPS']) fromEnv.maxSteps = Number(env['SABLE_MAX_STEPS']);
  if (env['SABLE_TEMPERATURE']) fromEnv.temperature = Number(env['SABLE_TEMPERATURE']);
  if (env['SABLE_APPROVAL']) fromEnv.approval = env['SABLE_APPROVAL'] as ApprovalMode;
  if (env['SABLE_COMPACT_AT']) fromEnv.compactAtTokens = Number(env['SABLE_COMPACT_AT']);
  if (env['SABLE_NO_PERSIST']) fromEnv.persistSessions = false;

  return fromEnv;
}

function validate(config: Config): Config {
  if (!APPROVAL_MODES.includes(config.approval)) {
    throw new ConfigError(
      `Unknown approval mode "${config.approval}". Expected one of: ${APPROVAL_MODES.join(', ')}.`,
    );
  }

  requirePositive(config.maxTokens, 'maxTokens');
  requirePositive(config.maxSteps, 'maxSteps');
  requirePositive(config.compactAtTokens, 'compactAtTokens');
  requirePositive(config.shellTimeoutMs, 'shellTimeoutMs');

  if (config.temperature !== undefined && !Number.isFinite(config.temperature)) {
    throw new ConfigError(`temperature must be a number, got ${config.temperature}.`);
  }

  if (!config.model) {
    throw new ConfigError(`No model configured for provider "${config.provider}".`);
  }

  return config;
}

function requirePositive(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 1) {
    throw new ConfigError(`${field} must be a positive number, got ${value}.`);
  }
}

function definedEntriesOf<T extends object>(value: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key as keyof T] = entry as T[keyof T];
  }
  return result;
}

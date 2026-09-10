import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_CONFIG, type Config } from '../src/config/config.js';
import type { ConfirmOutcome } from '../src/tools/types.js';
import type { ToolContext } from '../src/tools/types.js';

export function tempWorkspace(files: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sable-test-'));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }
  return root;
}

export function testConfig(root: string, overrides: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    apiKey: 'test-key',
    baseUrl: undefined,
    workspaceRoot: root,
    ...overrides,
  };
}

export function testContext(
  root: string,
  options: { answer?: ConfirmOutcome; config?: Partial<Config> } = {},
): ToolContext & { confirmations: string[] } {
  const confirmations: string[] = [];
  const context = {
    config: testConfig(root, options.config ?? {}),
    root,
    signal: new AbortController().signal,
    async confirm(request: { summary: string }): Promise<ConfirmOutcome> {
      confirmations.push(request.summary);
      return options.answer ?? 'once';
    },
    progress(): void {},
    confirmations,
  };
  return context;
}

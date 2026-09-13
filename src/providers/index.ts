import type { Config } from '../config/config.js';
import { ConfigError } from '../util/errors.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import type { Provider } from './types.js';

export type ProviderFactory = (config: Config) => Provider;

const registry = new Map<string, ProviderFactory>([
  [
    'anthropic',
    (config) => new AnthropicProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl }),
  ],
  ['openai', (config) => new OpenAIProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl })],
]);

export function registerProvider(id: string, factory: ProviderFactory): void {
  registry.set(id, factory);
}

export function providerIds(): string[] {
  return [...registry.keys()];
}

export function createProvider(config: Config): Provider {
  const factory = registry.get(config.provider);

  if (!factory) {
    throw new ConfigError(
      `Unknown provider "${config.provider}". Available: ${providerIds().join(', ')}.`,
    );
  }

  return factory(config);
}

export { AnthropicProvider } from './anthropic.js';
export { OpenAIProvider } from './openai.js';
export * from './types.js';
export { parseToolInput, isMalformedInput, MALFORMED_JSON_KEY } from './tool-input.js';

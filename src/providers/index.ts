import type { Config } from '../config/config.js';
import { ConfigError } from '../util/errors.js';
import { AnthropicProvider } from './anthropic.js';
import type { Provider } from './types.js';

export type ProviderFactory = (config: Config) => Provider;

/**
 * Provider registry. Adding a backend means implementing `Provider` and
 * registering it here — nothing in the agent loop needs to change.
 */
const registry = new Map<string, ProviderFactory>([
  [
    'anthropic',
    (config) =>
      new AnthropicProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
      }),
  ],
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
export * from './types.js';

import type { Usage } from '../providers/types.js';

/**
 * USD per million tokens, used only for the local cost estimate shown by `/cost`.
 *
 * These are estimates baked into the source; providers change prices, so treat
 * the number as a rough running total, not a bill. Override any entry with
 * `pricing` in your config file if it drifts.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const PRICES: Record<string, ModelPrice> = {
  'claude-opus-4-1': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};

const FALLBACK: ModelPrice = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

export function priceFor(model: string): ModelPrice {
  const exact = PRICES[model];
  if (exact) return exact;
  const prefix = Object.keys(PRICES).find((key) => model.startsWith(key));
  return prefix ? (PRICES[prefix] as ModelPrice) : FALLBACK;
}

export function estimateCost(model: string, usage: Usage): number {
  const price = priceFor(model);
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.cacheWrite) /
    1_000_000
  );
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

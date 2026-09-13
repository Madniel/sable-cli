import type { Usage } from '../providers/types.js';

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const PRICES_PER_MILLION_TOKENS: Record<string, ModelPrice> = {
  'claude-opus-4-1': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  'gpt-4.1': { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0 },
  'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 },
};

const FALLBACK_PRICE: ModelPrice = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

export function priceFor(model: string): ModelPrice {
  const exact = PRICES_PER_MILLION_TOKENS[model];
  if (exact) return exact;

  const prefixMatch = Object.keys(PRICES_PER_MILLION_TOKENS)
    .filter((key) => model.startsWith(key))
    .sort((a, b) => b.length - a.length)[0];

  return prefixMatch ? (PRICES_PER_MILLION_TOKENS[prefixMatch] as ModelPrice) : FALLBACK_PRICE;
}

export function estimateCost(model: string, usage: Usage): number {
  const price = priceFor(model);
  const cost =
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    usage.cacheReadTokens * price.cacheRead +
    usage.cacheWriteTokens * price.cacheWrite;

  return cost / 1_000_000;
}

export function formatCost(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

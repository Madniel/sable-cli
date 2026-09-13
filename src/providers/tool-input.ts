export const MALFORMED_JSON_KEY = '__malformed_json__';

export function parseToolInput(json: string): unknown {
  const trimmed = json.trim();
  if (!trimmed) return {};

  try {
    return JSON.parse(trimmed);
  } catch {
    return { [MALFORMED_JSON_KEY]: trimmed };
  }
}

export function isMalformedInput(input: unknown): boolean {
  return typeof input === 'object' && input !== null && MALFORMED_JSON_KEY in input;
}

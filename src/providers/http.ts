import { ProviderError, isAbort } from '../util/errors.js';

export type Sleep = (ms: number) => Promise<void>;

export const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const MAX_ATTEMPTS = 4;

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
const JITTER_MS = 250;

export function backoffDelay(attempt: number): number {
  const exponential = BASE_BACKOFF_MS * 2 ** (attempt - 1);
  return Math.min(MAX_BACKOFF_MS, exponential) + Math.random() * JITTER_MS;
}

export async function withRetries<T>(
  run: (attempt: number) => Promise<T>,
  sleep: Sleep = defaultSleep,
  maxAttempts = MAX_ATTEMPTS,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await run(attempt);
    } catch (error) {
      lastError = error;
      if (isAbort(error)) throw error;

      const retryable = error instanceof ProviderError && error.retryable;
      if (!retryable || attempt === maxAttempts) throw error;

      const hinted = error instanceof ProviderError ? error.retryAfterMs : undefined;
      await sleep(hinted ?? backoffDelay(attempt));
    }
  }

  throw lastError;
}

export async function describeFailure(response: Response): Promise<ProviderError> {
  const detail = await readErrorDetail(response);
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));

  if (response.status === 401 || response.status === 403) {
    return new ProviderError(`Authentication failed (${response.status}). ${detail}`.trim(), {
      status: response.status,
    });
  }

  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  const prefix = response.status === 429 ? 'Rate limited' : `Request failed (${response.status})`;

  return new ProviderError(`${prefix}. ${detail}`.trim(), {
    status: response.status,
    retryable,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
}

export function requireStreamBody(response: Response): ReadableStream<Uint8Array> {
  if (!response.body) {
    throw new ProviderError('The provider returned an empty response body.', { retryable: true });
  }
  return response.body;
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const body = await response.text();
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      return parsed.error?.message ?? body;
    } catch {
      return body;
    }
  } catch {
    return response.statusText;
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const timestamp = Date.parse(header);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

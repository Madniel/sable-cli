export type SableErrorCode =
  | 'CONFIG'
  | 'AUTH'
  | 'PROVIDER'
  | 'TOOL_INPUT'
  | 'TOOL_DENIED'
  | 'TOOL_FAILED'
  | 'ABORTED'
  | 'USAGE';

export interface SableErrorOptions {
  retryable?: boolean;
  cause?: unknown;
}

export class SableError extends Error {
  readonly code: SableErrorCode;
  readonly retryable: boolean;

  constructor(code: SableErrorCode, message: string, options: SableErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'SableError';
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export class ConfigError extends SableError {
  constructor(message: string, cause?: unknown) {
    super('CONFIG', message, { cause });
    this.name = 'ConfigError';
  }
}

export class AuthError extends SableError {
  constructor(message: string) {
    super('AUTH', message);
    this.name = 'AuthError';
  }
}

export interface ProviderErrorOptions extends SableErrorOptions {
  status?: number;
  retryAfterMs?: number;
}

export class ProviderError extends SableError {
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options: ProviderErrorOptions = {}) {
    super('PROVIDER', message, {
      retryable: options.retryable ?? false,
      cause: options.cause,
    });
    this.name = 'ProviderError';
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class ToolInputError extends SableError {
  constructor(message: string) {
    super('TOOL_INPUT', message);
    this.name = 'ToolInputError';
  }
}

export class ToolDeniedError extends SableError {
  constructor(message: string) {
    super('TOOL_DENIED', message);
    this.name = 'ToolDeniedError';
  }
}

export class AbortError extends SableError {
  constructor(message = 'Operation cancelled.') {
    super('ABORTED', message);
    this.name = 'AbortError';
  }
}

export function isAbort(error: unknown): boolean {
  if (error instanceof AbortError) return true;
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

export function isDenial(error: unknown): boolean {
  return error instanceof SableError && error.code === 'TOOL_DENIED';
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

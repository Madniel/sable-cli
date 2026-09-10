import { style } from './ansi.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

let current: LogLevel = (process.env['SABLE_LOG_LEVEL'] as LogLevel | undefined) ?? 'info';

export function setLogLevel(level: LogLevel): void {
  current = level;
}

export function getLogLevel(): LogLevel {
  return current;
}

function shouldLog(level: LogLevel): boolean {
  return ORDER[level] >= ORDER[current];
}

/** Diagnostics go to stderr so stdout stays a clean, pipeable channel. */
export const log = {
  debug(...args: unknown[]): void {
    if (shouldLog('debug')) console.error(style.gray('debug'), ...args);
  },
  info(...args: unknown[]): void {
    if (shouldLog('info')) console.error(...args);
  },
  warn(...args: unknown[]): void {
    if (shouldLog('warn')) console.error(style.yellow('warn'), ...args);
  },
  error(...args: unknown[]): void {
    if (shouldLog('error')) console.error(style.red('error'), ...args);
  },
};

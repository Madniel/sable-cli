import { style } from './ansi.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function initialLevel(): LogLevel {
  const fromEnv = process.env['SABLE_LOG_LEVEL'] as LogLevel | undefined;
  return fromEnv && fromEnv in SEVERITY ? fromEnv : 'info';
}

let currentLevel: LogLevel = initialLevel();

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function enabled(level: LogLevel): boolean {
  return SEVERITY[level] >= SEVERITY[currentLevel];
}

export const log = {
  debug(...args: unknown[]): void {
    if (enabled('debug')) console.error(style.gray('debug'), ...args);
  },
  info(...args: unknown[]): void {
    if (enabled('info')) console.error(...args);
  },
  warn(...args: unknown[]): void {
    if (enabled('warn')) console.error(style.yellow('warn'), ...args);
  },
  error(...args: unknown[]): void {
    if (enabled('error')) console.error(style.red('error'), ...args);
  },
};

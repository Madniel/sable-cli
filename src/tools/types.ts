import type { Config } from '../config/config.js';
import type { FileTracker } from './file-tracker.js';
import type { ObjectSchema } from './schema.js';

export type ToolKind = 'read' | 'write' | 'execute';

export interface ConfirmRequest {
  toolName: string;
  kind: ToolKind;
  summary: string;
  detail?: string;
}

export type ConfirmOutcome = 'once' | 'always' | 'reject';

export interface ToolContext {
  config: Config;
  root: string;
  signal: AbortSignal;
  files: FileTracker;
  confirm(request: ConfirmRequest): Promise<ConfirmOutcome>;
  progress(line: string): void;
}

export interface ToolResult {
  output: string;
  isError?: boolean;
  display?: string;
}

export interface Tool {
  readonly name: string;
  readonly kind: ToolKind;
  readonly description: string;
  readonly schema: ObjectSchema;
  summarize(params: Record<string, unknown>): string;
  run(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export function ok(output: string, display?: string): ToolResult {
  return display === undefined ? { output } : { output, display };
}

export function fail(output: string): ToolResult {
  return { output, isError: true };
}

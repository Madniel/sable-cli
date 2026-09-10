import type { Config } from '../config/config.js';
import type { ObjectSchema } from './schema.js';

/** What a tool call would do to the world. Drives the approval policy. */
export type ToolKind = 'read' | 'write' | 'execute';

export interface ConfirmRequest {
  toolName: string;
  kind: ToolKind;
  /** One-line description shown in the approval prompt. */
  summary: string;
  /** Optional detail body — a diff, the command about to run, etc. */
  detail?: string;
}

export type ConfirmOutcome = 'once' | 'always' | 'reject';

export interface ToolContext {
  config: Config;
  /** Workspace root; tools must not touch anything outside it. */
  root: string;
  signal: AbortSignal;
  /** Ask the approval layer whether this call may proceed. */
  confirm(request: ConfirmRequest): Promise<ConfirmOutcome>;
  /** Emit a line of progress to the UI (stderr), not to the model. */
  progress(line: string): void;
}

export interface ToolResult {
  /** Text handed back to the model. */
  output: string;
  /** Marks the result as an error so the model can correct course. */
  isError?: boolean;
  /** Optional short line for the terminal, when the model-facing output is noisy. */
  display?: string;
}

export interface Tool {
  readonly name: string;
  readonly kind: ToolKind;
  /** Sent to the model; this is the tool's real user interface. */
  readonly description: string;
  readonly schema: ObjectSchema;
  /** One-line human summary of a validated call, for logs and approval prompts. */
  summarize(params: Record<string, unknown>): string;
  run(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export function ok(output: string, display?: string): ToolResult {
  return display === undefined ? { output } : { output, display };
}

export function fail(output: string): ToolResult {
  return { output, isError: true };
}

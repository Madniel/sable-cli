import type { ApprovalMode } from '../config/config.js';
import type { ConfirmOutcome, ConfirmRequest } from '../tools/types.js';

/** The interactive half of approvals. Absent in non-interactive runs. */
export interface ApprovalPrompt {
  ask(request: ConfirmRequest): Promise<ConfirmOutcome>;
}

/**
 * Decides whether a tool call may proceed.
 *
 * Modes:
 *  - `readonly`  nothing may write or execute
 *  - `prompt`    ask before every write and command (default)
 *  - `auto-edit` file writes go through, commands still ask
 *  - `yolo`      everything goes through
 *
 * "Always allow" answers are remembered for the rest of the session, per tool.
 */
export class ApprovalPolicy {
  private mode: ApprovalMode;
  private readonly prompt: ApprovalPrompt | null;
  private readonly alwaysAllowed = new Set<string>();

  constructor(mode: ApprovalMode, prompt: ApprovalPrompt | null = null) {
    this.mode = mode;
    this.prompt = prompt;
  }

  getMode(): ApprovalMode {
    return this.mode;
  }

  setMode(mode: ApprovalMode): void {
    this.mode = mode;
  }

  /** Tools the user has waved through for the rest of the session. */
  allowlist(): string[] {
    return [...this.alwaysAllowed];
  }

  async confirm(request: ConfirmRequest): Promise<ConfirmOutcome> {
    if (request.kind === 'read') return 'once';

    if (this.mode === 'readonly') return 'reject';
    if (this.mode === 'yolo') return 'once';
    if (this.alwaysAllowed.has(request.toolName)) return 'once';
    if (this.mode === 'auto-edit' && request.kind === 'write') return 'once';

    if (!this.prompt) {
      // Non-interactive run with nobody to ask: refuse rather than act unilaterally.
      return 'reject';
    }

    const outcome = await this.prompt.ask(request);
    if (outcome === 'always') {
      this.alwaysAllowed.add(request.toolName);
      return 'once';
    }
    return outcome;
  }

  /** Explanation shown to the model when a call is refused without a prompt. */
  denialReason(request: ConfirmRequest): string {
    if (this.mode === 'readonly') {
      return `Refused: the session is in read-only mode, so ${request.toolName} cannot run. Report what you would have done instead.`;
    }
    if (!this.prompt) {
      return `Refused: this is a non-interactive run and ${request.toolName} needs approval. Re-run with --approval auto-edit or --approval yolo to allow it.`;
    }
    return 'Refused by the user.';
  }
}

import type { ApprovalMode } from '../config/config.js';
import type { ConfirmOutcome, ConfirmRequest } from '../tools/types.js';

export interface ApprovalPrompt {
  ask(request: ConfirmRequest): Promise<ConfirmOutcome>;
}

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

  isInteractive(): boolean {
    return this.prompt !== null;
  }

  allowlist(): string[] {
    return [...this.alwaysAllowed];
  }

  allowAlways(toolName: string): void {
    this.alwaysAllowed.add(toolName);
  }

  async confirm(request: ConfirmRequest): Promise<ConfirmOutcome> {
    const automatic = this.autoDecision(request);
    if (automatic !== null) return automatic;
    if (!this.prompt) return 'reject';

    const answer = await this.prompt.ask(request);

    if (answer === 'always') {
      this.allowAlways(request.toolName);
      return 'once';
    }

    return answer;
  }

  denialReason(request: ConfirmRequest): string {
    if (this.mode === 'readonly') {
      return (
        `Refused: the session is in read-only mode, so ${request.toolName} cannot run. ` +
        'Report what you would have done instead.'
      );
    }

    if (!this.prompt) {
      return (
        `Refused: this is a non-interactive run and ${request.toolName} needs approval. ` +
        'Re-run with --approval auto-edit or --approval yolo to allow it.'
      );
    }

    return 'Refused by the user.';
  }

  private autoDecision(request: ConfirmRequest): ConfirmOutcome | null {
    if (request.kind === 'read') return 'once';
    if (this.mode === 'readonly') return 'reject';
    if (this.mode === 'yolo') return 'once';
    if (this.alwaysAllowed.has(request.toolName)) return 'once';
    if (this.mode === 'auto-edit' && request.kind === 'write') return 'once';
    return null;
  }
}

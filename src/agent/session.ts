import { EMPTY_USAGE, addUsage, type Message, type Usage } from '../providers/types.js';
import { estimateCost } from './pricing.js';

/**
 * Conversation state for one CLI session: the message history plus running
 * usage totals. Kept deliberately separate from the agent loop so it can be
 * snapshotted, trimmed, or persisted without touching control flow.
 */
export class Session {
  readonly startedAt = new Date();
  private messages: Message[] = [];
  private usage: Usage = { ...EMPTY_USAGE };
  private turns = 0;

  constructor(private model: string) {}

  getModel(): string {
    return this.model;
  }

  setModel(model: string): void {
    this.model = model;
  }

  history(): Message[] {
    return this.messages;
  }

  append(message: Message): void {
    this.messages.push(message);
  }

  recordUsage(usage: Usage): void {
    this.usage = addUsage(this.usage, usage);
  }

  countTurn(): void {
    this.turns += 1;
  }

  totals(): { usage: Usage; turns: number; messages: number; costUsd: number } {
    return {
      usage: this.usage,
      turns: this.turns,
      messages: this.messages.length,
      costUsd: estimateCost(this.model, this.usage),
    };
  }

  clear(): void {
    this.messages = [];
    this.usage = { ...EMPTY_USAGE };
    this.turns = 0;
  }

  /**
   * Drop the oldest exchanges while keeping the history valid.
   *
   * A `tool_result` must always follow its `tool_use`, so we only ever cut at a
   * user message that starts a fresh exchange.
   */
  trimTo(maxMessages: number): number {
    if (this.messages.length <= maxMessages) return 0;

    let cut = this.messages.length - maxMessages;
    while (cut < this.messages.length) {
      const candidate = this.messages[cut];
      const startsExchange =
        candidate?.role === 'user' && !candidate.content.some((b) => b.type === 'tool_result');
      if (startsExchange) break;
      cut++;
    }

    if (cut >= this.messages.length) return 0;
    const removed = this.messages.splice(0, cut).length;
    return removed;
  }

  /** A serialisable snapshot, for `/save` or crash reports. */
  toJSON(): object {
    return {
      startedAt: this.startedAt.toISOString(),
      model: this.model,
      turns: this.turns,
      usage: this.usage,
      messages: this.messages,
    };
  }
}

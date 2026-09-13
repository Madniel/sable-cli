import { randomUUID } from 'node:crypto';

import {
  EMPTY_USAGE,
  addUsage,
  startsExchange,
  textOf,
  type Message,
  type Usage,
} from '../providers/types.js';
import { estimateConversationTokens } from './tokens.js';
import { estimateCost } from './pricing.js';

export interface SessionTotals {
  usage: Usage;
  turns: number;
  messages: number;
  costUsd: number;
  estimatedTokens: number;
}

export interface SessionSnapshot {
  id: string;
  startedAt: string;
  updatedAt: string;
  provider: string;
  model: string;
  workspaceRoot: string;
  title: string;
  turns: number;
  usage: Usage;
  messages: Message[];
}

export interface SessionOptions {
  provider: string;
  model: string;
  workspaceRoot: string;
  id?: string;
}

export class Session {
  readonly id: string;
  readonly startedAt: Date;
  readonly provider: string;
  readonly workspaceRoot: string;

  private model: string;
  private messages: Message[] = [];
  private usage: Usage = { ...EMPTY_USAGE };
  private turns = 0;

  constructor(options: SessionOptions) {
    this.id = options.id ?? randomUUID();
    this.startedAt = new Date();
    this.provider = options.provider;
    this.model = options.model;
    this.workspaceRoot = options.workspaceRoot;
  }

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

  replaceHistory(messages: Message[]): void {
    this.messages = messages;
  }

  recordUsage(usage: Usage): void {
    this.usage = addUsage(this.usage, usage);
  }

  countTurn(): void {
    this.turns += 1;
  }

  totals(): SessionTotals {
    return {
      usage: this.usage,
      turns: this.turns,
      messages: this.messages.length,
      costUsd: estimateCost(this.model, this.usage),
      estimatedTokens: estimateConversationTokens(this.messages),
    };
  }

  title(): string {
    const firstUserMessage = this.messages.find(startsExchange);
    const text = firstUserMessage ? textOf(firstUserMessage).trim() : '';
    const firstLine = text.split('\n', 1)[0] ?? '';
    return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine || '(empty session)';
  }

  clear(): void {
    this.messages = [];
    this.usage = { ...EMPTY_USAGE };
    this.turns = 0;
  }

  trimTo(maxMessages: number): number {
    if (this.messages.length <= maxMessages) return 0;

    const cut = nextExchangeBoundary(this.messages, this.messages.length - maxMessages);
    if (cut >= this.messages.length) return 0;

    return this.messages.splice(0, cut).length;
  }

  snapshot(): SessionSnapshot {
    return {
      id: this.id,
      startedAt: this.startedAt.toISOString(),
      updatedAt: new Date().toISOString(),
      provider: this.provider,
      model: this.model,
      workspaceRoot: this.workspaceRoot,
      title: this.title(),
      turns: this.turns,
      usage: this.usage,
      messages: this.messages,
    };
  }

  restore(snapshot: SessionSnapshot): void {
    this.model = snapshot.model;
    this.messages = snapshot.messages;
    this.usage = snapshot.usage;
    this.turns = snapshot.turns;
  }

  toJSON(): SessionSnapshot {
    return this.snapshot();
  }
}

export function nextExchangeBoundary(messages: Message[], from: number): number {
  let index = Math.max(0, from);

  while (index < messages.length) {
    const candidate = messages[index];
    if (candidate && startsExchange(candidate)) return index;
    index++;
  }

  return index;
}

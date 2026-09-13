import type { Config } from '../config/config.js';
import {
  assistantText,
  userText,
  type Message,
  type Provider,
  type Usage,
} from '../providers/types.js';
import { textOf } from '../providers/types.js';
import { nextExchangeBoundary, type Session } from './session.js';
import { estimateConversationTokens } from './tokens.js';

const KEEP_RECENT_MESSAGES = 8;
const SUMMARY_MAX_TOKENS = 1500;
const MIN_MESSAGES_TO_COMPACT = 4;

const SUMMARY_INSTRUCTIONS = `You are compacting the earlier part of a coding session so it can be
dropped from context without losing what matters.

Write a dense summary covering:
- what the user asked for, in their own terms
- what was investigated and what was learned about the codebase
- every file created, edited or deleted, and what changed in each
- commands that were run and what they reported
- decisions made, and anything explicitly ruled out
- what is still outstanding

Be specific: name files, functions and commands. Do not add commentary, do not
speculate, and do not describe this summary. Plain prose, no preamble.`;

export interface CompactionResult {
  compacted: boolean;
  removedMessages: number;
  tokensBefore: number;
  tokensAfter: number;
  usage: Usage | null;
  reason?: string;
}

export interface CompactionOptions {
  session: Session;
  provider: Provider;
  config: Config;
  keepRecent?: number;
  signal?: AbortSignal;
}

export function shouldCompact(session: Session, config: Config): boolean {
  return session.totals().estimatedTokens >= config.compactAtTokens;
}

export async function compactSession(options: CompactionOptions): Promise<CompactionResult> {
  const { session, provider, config, signal } = options;
  const keepRecent = options.keepRecent ?? KEEP_RECENT_MESSAGES;

  const history = session.history();
  const tokensBefore = estimateConversationTokens(history);

  const boundary = nextExchangeBoundary(history, Math.max(0, history.length - keepRecent));
  const older = history.slice(0, boundary);
  const recent = history.slice(boundary);

  if (older.length < MIN_MESSAGES_TO_COMPACT) {
    return {
      compacted: false,
      removedMessages: 0,
      tokensBefore,
      tokensAfter: tokensBefore,
      usage: null,
      reason: 'Not enough history to compact yet.',
    };
  }

  const result = await provider.complete(
    {
      system: SUMMARY_INSTRUCTIONS,
      messages: [...older, userText('Summarise the session so far, following your instructions.')],
      tools: [],
      model: session.getModel(),
      maxTokens: SUMMARY_MAX_TOKENS,
      temperature: 0,
    },
    () => {},
    signal,
  );

  const summary = textOf(result.message).trim();

  if (!summary) {
    return {
      compacted: false,
      removedMessages: 0,
      tokensBefore,
      tokensAfter: tokensBefore,
      usage: result.usage,
      reason: 'The model returned an empty summary.',
    };
  }

  session.replaceHistory([...summaryMessages(summary), ...recent]);
  session.recordUsage(result.usage);

  return {
    compacted: true,
    removedMessages: older.length,
    tokensBefore,
    tokensAfter: estimateConversationTokens(session.history()),
    usage: result.usage,
  };
}

function summaryMessages(summary: string): Message[] {
  return [
    userText(
      `[Earlier conversation compacted to save context. Summary of what happened so far:]\n\n${summary}`,
    ),
    assistantText('Understood. Continuing from that summary.'),
  ];
}

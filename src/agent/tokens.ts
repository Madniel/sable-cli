import type { Message } from '../providers/types.js';

const CHARS_PER_TOKEN = 4;
const PER_MESSAGE_OVERHEAD = 4;

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(message: Message): number {
  let characters = 0;

  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        characters += block.text.length;
        break;
      case 'thinking':
        characters += block.thinking.length;
        break;
      case 'tool_use':
        characters += block.name.length + JSON.stringify(block.input ?? {}).length;
        break;
      case 'tool_result':
        characters += block.content.length;
        break;
    }
  }

  return Math.ceil(characters / CHARS_PER_TOKEN) + PER_MESSAGE_OVERHEAD;
}

export function estimateConversationTokens(messages: Message[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

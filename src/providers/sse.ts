/**
 * A tiny server-sent-events reader over a `fetch` response body.
 *
 * Handles the two things that actually bite in practice: chunk boundaries that
 * split a frame in half, and multi-line `data:` payloads.
 */

export interface SSEFrame {
  event: string | undefined;
  data: string;
}

export async function* readSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line; tolerate \r\n as well as \n.
      let separator = findSeparator(buffer);
      while (separator) {
        const raw = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator.length);
        const frame = parseFrame(raw);
        if (frame) yield frame;
        separator = findSeparator(buffer);
      }
    }

    const tail = parseFrame(buffer);
    if (tail) yield tail;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

function findSeparator(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function parseFrame(raw: string): SSEFrame | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let event: string | undefined;
  const dataLines: string[] = [];

  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith(':')) continue; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }

  if (!event && dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

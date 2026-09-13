export interface SSEFrame {
  event: string | undefined;
  data: string;
}

interface FrameBoundary {
  index: number;
  length: number;
}

export async function* readSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const cancelReader = () => void reader.cancel().catch(() => undefined);

  signal?.addEventListener('abort', cancelReader, { once: true });

  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      for (
        let boundary = findFrameBoundary(buffer);
        boundary !== null;
        boundary = findFrameBoundary(buffer)
      ) {
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);

        const frame = parseFrame(raw);
        if (frame) yield frame;
      }
    }

    const trailing = parseFrame(buffer);
    if (trailing) yield trailing;
  } finally {
    signal?.removeEventListener('abort', cancelReader);
    reader.releaseLock();
  }
}

function findFrameBoundary(buffer: string): FrameBoundary | null {
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
    if (line.startsWith(':')) continue;

    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');

    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }

  if (!event && dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

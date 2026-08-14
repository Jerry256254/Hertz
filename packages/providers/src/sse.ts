export interface SSEFrame {
  event?: string;
  data: string;
}

/** Minimal Server-Sent-Events framer, good enough for both Anthropic's (event+data) and OpenAI-shaped (data only, "[DONE]" sentinel) streams. */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (raw.trim()) yield parseFrame(raw);
      }
    }
    if (buffer.trim()) yield parseFrame(buffer);
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(raw: string): SSEFrame {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  return { event, data: dataLines.join("\n") };
}

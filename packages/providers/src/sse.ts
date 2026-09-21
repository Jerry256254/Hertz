export interface SSEFrame {
  event?: string;
  data: string;
}

/** Thrown when no bytes arrive within the configured inactivity window. */
export class StreamStallError extends Error {
  constructor(ms: number) {
    super(`SSE stream stalled: no data for ${ms} ms`);
    this.name = "StreamStallError";
  }
}

/** Minimal Server-Sent-Events framer, good enough for both Anthropic's (event+data) and OpenAI-shaped (data only, "[DONE]" sentinel) streams. */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  opts?: { inactivityMs?: number },
): AsyncGenerator<SSEFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // A stream that goes silent mid-response (dropped connection, wedged
  // gateway) must fail loudly instead of hanging the run forever.
  const readNext = async () => {
    const inactivityMs = opts?.inactivityMs;
    if (!inactivityMs) return reader.read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new StreamStallError(inactivityMs)), inactivityMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  try {
    for (;;) {
      const { value, done } = await readNext();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Handle both \n\n and \r\n\r\n (some gateways use CRLF)
      buffer = buffer.replace(/\r\n/g, "\n");
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
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  return { event, data: dataLines.join("\n") };
}

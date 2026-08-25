export function subscribeToSession(sessionId: string, onEvent: (event: any) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    if (closed) return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${window.location.host}/ws/sessions/${sessionId}`);
    ws.onmessage = (e) => {
      try { onEvent(JSON.parse(e.data)); } catch { /* ignore malformed */ }
      retries = 0;
    };
    ws.onclose = () => {
      if (closed) return;
      const delay = Math.min(1000 * 2 ** retries, 15000);
      retries++;
      timer = setTimeout(connect, delay);
    };
    ws.onerror = () => {
      try { ws?.close(); } catch {}
    };
  };
  connect();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    try { ws?.close(); } catch {}
  };
}

export function subscribeToMeeting(meetingId: string, onEvent: (event: any) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    if (closed) return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${window.location.host}/ws/meetings/${meetingId}`);
    ws.onmessage = (e) => {
      try { onEvent(JSON.parse(e.data)); } catch {}
      retries = 0;
    };
    ws.onclose = () => {
      if (closed) return;
      const delay = Math.min(1000 * 2 ** retries, 15000);
      retries++;
      timer = setTimeout(connect, delay);
    };
    ws.onerror = () => { try { ws?.close(); } catch {} };
  };
  connect();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    try { ws?.close(); } catch {}
  };
}

/** WebSocket close codes that mean "don't bother retrying". */
const PERMANENT_CLOSE_CODES = new Set([4400, 4401, 4403, 4404]);

export function subscribeToSession(
  sessionId: string,
  onEvent: (event: any) => void,
  onPermanentClose?: (code: number) => void,
): () => void {
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
    ws.onclose = (e) => {
      if (closed) return;
      // Permanent rejection (bad/expired session, forbidden, gone) — give up
      // and tell the UI instead of reconnecting forever.
      if (PERMANENT_CLOSE_CODES.has(e.code)) {
        try { onPermanentClose?.(e.code); } catch { /* ignore */ }
        return;
      }
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

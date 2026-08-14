import type { AgentLoopEvent } from "./types";

export function subscribeToSession(sessionId: string, onEvent: (event: AgentLoopEvent) => void): () => void {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws/sessions/${sessionId}`);

  socket.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as AgentLoopEvent);
    } catch {
      // ignore malformed frames
    }
  };

  return () => socket.close();
}

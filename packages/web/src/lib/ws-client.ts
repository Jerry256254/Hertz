import type { AgentLoopEvent, MeetingEvent } from "./types";

function subscribeTo<T>(path: string, onEvent: (event: T) => void): () => void {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${window.location.host}${path}`);

  socket.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as T);
    } catch {
      // ignore malformed frames
    }
  };

  return () => socket.close();
}

export function subscribeToSession(sessionId: string, onEvent: (event: AgentLoopEvent) => void): () => void {
  return subscribeTo(`/ws/sessions/${sessionId}`, onEvent);
}

export function subscribeToMeeting(meetingId: string, onEvent: (event: MeetingEvent) => void): () => void {
  return subscribeTo(`/ws/meetings/${meetingId}`, onEvent);
}

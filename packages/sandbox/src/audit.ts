export type AuditActorType = "user" | "agent";
export type AuditResult = "allowed" | "denied" | "error";

export interface AuditEvent {
  actorId: string;
  actorType: AuditActorType;
  sessionId?: string;
  projectId?: string;
  action: string;
  target?: string;
  targetType?: string;
  result: AuditResult;
  detail?: Record<string, unknown>;
}

export interface AuditSink {
  record(event: AuditEvent): void | Promise<void>;
}

/** Default sink used when no persistence-backed sink is wired up yet (e.g. in tests). */
export class NullAuditSink implements AuditSink {
  record(): void {
    // intentionally a no-op
  }
}

export interface ActorContext {
  actorId: string;
  actorType: AuditActorType;
  sessionId?: string;
  projectId?: string;
  /** The human user whose request chain this action traces back to, even when actorType is 'agent' (e.g. a manager delegating to an employee). */
  userId?: string;
}

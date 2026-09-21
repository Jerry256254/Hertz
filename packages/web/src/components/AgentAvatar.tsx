import { useState } from "react";

/**
 * URL of the agent's generative avatar, served by the backend
 * (`GET /api/agents/:id/avatar.svg`). Same-origin relative URL so the
 * session cookie travels with the request.
 */
export function agentAvatarUrl(agentId: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}/avatar.svg`;
}

/**
 * Kept for API compatibility — the backend SVG is static and has no moods.
 */
export type AvatarMood =
  | "idle"
  | "thinking"
  | "speaking"
  | "working"
  | "waiting" // legacy alias of "thinking"
  | "error";

interface AgentAvatarProps {
  /** Agent id — resolves to the backend generative avatar endpoint. */
  seed: string;
  /** @deprecated kept for API compatibility; the backend SVG has no moods. */
  mood?: AvatarMood;
  size?: number;
  /** @deprecated kept for API compatibility; the backend SVG is static. */
  animate?: boolean;
  className?: string;
}

/**
 * Agent avatar — renders the backend's generative SVG per agent id.
 * While the image loads (or when it fails), a calm neutral tile shows:
 * no emoji, no initials, no drawn face.
 */
export function AgentAvatar({ seed, size = 40, className = "" }: AgentAvatarProps) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const src = agentAvatarUrl(seed);

  return (
    <span
      className={`inline-block shrink-0 overflow-hidden rounded-[26%] bg-bg-sunken ${className}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label="Avatar agenta"
    >
      {!failed && (
        <img
          key={src}
          src={src}
          alt=""
          width={size}
          height={size}
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          style={{
            display: "block",
            width: size,
            height: size,
            opacity: loaded ? 1 : 0,
            transition: "opacity 200ms ease-out",
          }}
        />
      )}
    </span>
  );
}

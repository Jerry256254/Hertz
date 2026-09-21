import { useEffect, useState } from "react";

/**
 * URL of the agent's generative avatar, served by the backend
 * (`GET /api/agents/:id/avatar.svg`). Same-origin relative URL so the
 * session cookie travels with the request.
 *
 * The optional version is appended as `?v=` — the URL is otherwise constant
 * per agent, so without it the browser would keep showing a stale cached
 * copy after the avatar was regenerated (see avatarVersionOf).
 */
export function agentAvatarUrl(agentId: string, version?: string): string {
  const base = `/api/agents/${encodeURIComponent(agentId)}/avatar.svg`;
  return version ? `${base}?v=${encodeURIComponent(version)}` : base;
}

/**
 * Cache-busting version for an agent row: the seed of its stored generative
 * avatar spec. Changes exactly when the avatar changes, so every
 * `<img src>` built with it always resolves to the current artwork.
 */
export function avatarVersionOf(agent: { avatar?: string | null } | null | undefined): string | undefined {
  if (!agent?.avatar) return undefined;
  try {
    const o = JSON.parse(agent.avatar) as { seed?: unknown };
    return typeof o.seed === "string" && o.seed.length > 0 ? o.seed : undefined;
  } catch {
    return undefined;
  }
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
  /**
   * Cache-busting version, e.g. from `avatarVersionOf(agent)`. When the
   * avatar is regenerated the version changes, the URL changes, and the
   * browser fetches the new artwork instead of serving a stale copy.
   */
  version?: string;
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
export function AgentAvatar({ seed, version, size = 40, className = "" }: AgentAvatarProps) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const src = agentAvatarUrl(seed, version);

  // A new version is a new image — don't keep a stale loaded/failed state.
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [src]);

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

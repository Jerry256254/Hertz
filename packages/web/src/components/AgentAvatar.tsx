import { useId, useMemo } from "react";

/** Deterministic FNV-1a hash of the seed string. */
function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Flat matte duos — solid fills only, zero gradients. Warm/earthy range on
 * purpose: no purple/blue/violet/indigo (AI-slop tell), calm Apple-like feel.
 */
export interface AvatarPalette {
  bg: string;
  ink: string;
  paper: string;
}

const PALETTES: AvatarPalette[] = [
  { bg: "#d96c4f", ink: "#401d12", paper: "#fff6ef" }, // terracotta
  { bg: "#7fa07a", ink: "#1e331f", paper: "#f2f7f0" }, // sage
  { bg: "#d9a441", ink: "#46300a", paper: "#fff7e3" }, // ochre
  { bg: "#3aa99e", ink: "#0c3230", paper: "#ecfaf7" }, // teal
  { bg: "#c96f6b", ink: "#3a1512", paper: "#fff0ee" }, // clay rose
  { bg: "#6e8b5e", ink: "#223018", paper: "#f1f6ea" }, // moss
  { bg: "#c4a87e", ink: "#3a2e18", paper: "#fffbf1" }, // sand
  { bg: "#6e7b85", ink: "#1b2329", paper: "#f1f4f6" }, // warm slate
];

export type AvatarMood =
  | "idle"
  | "thinking"
  | "speaking"
  | "working"
  | "waiting" // legacy alias of "thinking"
  | "error";

export interface AvatarArt {
  palette: AvatarPalette;
  paletteIndex: number;
  eyeDX: number;
  eyeY: number;
  eyeRX: number;
  eyeRY: number;
  pupilR: number;
  mouthVariant: 0 | 1 | 2;
  ringVariant: 0 | 1 | 2 | 3;
  ringTilt: number;
  satAngles: number[];
  satR: number;
  freckles: Array<{ x: number; y: number; r: number }>;
  sheenLeft: boolean;
  phase: number;
}

/** Pure deterministic art derivation — exported for testing. */
export function artForSeed(seed: string): AvatarArt {
  const key = seed || "agent";
  const h = hashSeed(key);
  const rand = mulberry32(h);
  const paletteIndex = Math.floor(rand() * PALETTES.length);
  const ringVariant = Math.floor(rand() * 4) as 0 | 1 | 2 | 3;
  const satCount = ringVariant === 0 ? 0 : 1 + Math.floor(rand() * 2);
  const freckleCount = Math.floor(rand() * 4);
  const freckles = Array.from({ length: freckleCount }, (_, i) => {
    const left = i % 2 === 0;
    return {
      x: left ? 12.5 + rand() * 5 : 30.5 + rand() * 5,
      y: 28 + rand() * 5,
      r: 0.9 + rand() * 0.5,
    };
  });
  return {
    palette: PALETTES[paletteIndex] ?? PALETTES[0]!,
    paletteIndex,
    eyeDX: 6.2 + rand() * 2.2,
    eyeY: 20 + rand() * 2,
    eyeRX: 4.4 + rand() * 1.2,
    eyeRY: 5 + rand() * 1.6,
    pupilR: 1.9 + rand() * 0.9,
    mouthVariant: Math.floor(rand() * 3) as 0 | 1 | 2,
    ringVariant,
    ringTilt: rand() * 44 - 22,
    satAngles: Array.from({ length: satCount }, () => rand() * 360),
    satR: 1.7 + rand() * 1,
    freckles,
    sheenLeft: rand() < 0.5,
    phase: (h % 40) / 10,
  };
}

interface MoodStyle {
  breathe: string;
  blink: string;
  orbit: string;
  glance: boolean;
  talk: boolean;
  bob: boolean;
  pulseRing: boolean;
}

function moodStyle(mood: AvatarMood): MoodStyle {
  switch (mood) {
    case "thinking":
    case "waiting":
      return { breathe: "3.6s", blink: "6s", orbit: "7s", glance: true, talk: false, bob: false, pulseRing: false };
    case "speaking":
      return { breathe: "3s", blink: "4.6s", orbit: "10s", glance: false, talk: true, bob: true, pulseRing: false };
    case "working":
      return { breathe: "1.8s", blink: "3s", orbit: "4.5s", glance: false, talk: false, bob: false, pulseRing: true };
    case "error":
      return { breathe: "6s", blink: "7s", orbit: "20s", glance: false, talk: false, bob: false, pulseRing: false };
    case "idle":
    default:
      return { breathe: "5s", blink: "5.2s", orbit: "14s", glance: false, talk: false, bob: false, pulseRing: false };
  }
}

/**
 * Generative animated SVG avatar — deterministic per agent seed id.
 * Flat matte squircle + minimal face + seeded decorations. CSS-only motion,
 * no SMIL (so `prefers-reduced-motion` fully freezes it), no binary assets.
 */
export function AgentAvatar({
  seed,
  mood = "idle",
  size = 40,
  animate = true,
}: {
  seed: string;
  mood?: AvatarMood;
  size?: number;
  animate?: boolean;
}) {
  const art = useMemo(() => artForSeed(seed), [seed]);
  const rawId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const clipId = `avc${rawId}`;
  const ms = moodStyle(mood);
  const { palette } = art;
  const detailed = size >= 28;

  const eyes: Array<"l" | "r"> = ["l", "r"];
  const mouthY = 32.5;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role="img"
      aria-label="Avatar agenta"
      style={{ display: "block", flexShrink: 0 }}
      shapeRendering="geometricPrecision"
    >
      <defs>
        <clipPath id={clipId}>
          <rect x="3" y="3" width="42" height="42" rx="13" />
        </clipPath>
      </defs>

      {/* matte squircle base */}
      <rect x="3" y="3" width="42" height="42" rx="13" fill={palette.bg} />

      <g clipPath={`url(#${clipId})`}>
        {/* soft top sheen — flat white at low opacity, not a gradient */}
        <ellipse cx={art.sheenLeft ? 17 : 31} cy="8" rx="13" ry="6.5" fill="#ffffff" opacity="0.1" />

        {/* seeded backdrop decoration */}
        {art.ringVariant === 0 && (
          <rect x="11" y="17" width="26" height="14" rx="7" fill={palette.ink} opacity="0.1" />
        )}
        {art.ringVariant === 1 && (
          <path
            d="M 11 20 A 15 15 0 0 1 37 20"
            fill="none"
            stroke={palette.paper}
            strokeWidth="2.4"
            strokeLinecap="round"
            opacity="0.55"
            transform={`rotate(${art.ringTilt} 24 24)`}
            className={animate && ms.pulseRing ? "av-pulse-ring" : undefined}
          />
        )}
        {art.ringVariant === 2 && (
          <ellipse
            cx="24"
            cy="23"
            rx="14.5"
            ry="12.5"
            fill="none"
            stroke={palette.paper}
            strokeWidth="1.6"
            opacity="0.5"
            transform={`rotate(${art.ringTilt} 24 23)`}
            className={animate && ms.pulseRing ? "av-pulse-ring" : undefined}
          />
        )}
        {art.ringVariant === 3 && detailed && (
          <circle
            cx="24"
            cy="24"
            r="16"
            fill="none"
            stroke={palette.paper}
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeDasharray="0.5 5.2"
            opacity="0.6"
            className={animate && ms.pulseRing ? "av-pulse-ring" : undefined}
          />
        )}

        {/* seeded freckles (hidden at tiny sizes for crispness) */}
        {detailed &&
          art.freckles.map((f, i) => (
            <circle key={i} cx={f.x} cy={f.y} r={f.r} fill={palette.paper} opacity="0.65" />
          ))}
      </g>

      {/* orbiting satellites */}
      {detailed && art.satAngles.length > 0 && (
        <g
          className={animate ? "av-orbit" : undefined}
          style={animate ? { animationDuration: ms.orbit, animationDelay: `-${art.phase}s` } : undefined}
        >
          {art.satAngles.map((a, i) => {
            const rad = (a * Math.PI) / 180;
            return (
              <circle
                key={i}
                cx={24 + 16 * Math.cos(rad)}
                cy={24 + 16 * Math.sin(rad)}
                r={i === 0 ? art.satR : art.satR * 0.62}
                fill={palette.paper}
                opacity={i === 0 ? 0.95 : 0.7}
              />
            );
          })}
        </g>
      )}

      {/* face — breathes as one group */}
      <g
        className={animate ? "av-breathe" : undefined}
        style={animate ? { animationDuration: ms.breathe, animationDelay: `-${art.phase}s` } : undefined}
      >
      <g className={animate && ms.bob ? "av-bob" : undefined}>
        {eyes.map((side) => {
          const cx = side === "l" ? 24 - art.eyeDX : 24 + art.eyeDX;
          return (
            <g
              key={side}
              className={animate ? "av-blink" : undefined}
              style={animate ? { animationDuration: ms.blink, animationDelay: `-${art.phase}s` } : undefined}
            >
              <ellipse cx={cx} cy={art.eyeY} rx={art.eyeRX} ry={art.eyeRY} fill="#ffffff" opacity="0.96" />
              <circle
                cx={cx}
                cy={art.eyeY + 0.6}
                r={art.pupilR}
                fill={palette.ink}
                className={animate && ms.glance ? "av-glance" : undefined}
              />
            </g>
          );
        })}

        {/* mouth — mood overrides the seeded variant */}
        {mood === "speaking" || (mood !== "thinking" && mood !== "waiting" && mood !== "working" && mood !== "error" && art.mouthVariant === 2) ? (
          <ellipse
            cx="24"
            cy={mouthY}
            rx="3.4"
            ry="2.6"
            fill={palette.ink}
            opacity="0.85"
            className={animate && mood === "speaking" ? "av-talk" : undefined}
          />
        ) : mood === "thinking" || mood === "waiting" || mood === "working" ? (
          <line
            x1={mood === "thinking" || mood === "waiting" ? 19 : 20}
            y1={mouthY}
            x2={mood === "thinking" || mood === "waiting" ? 27 : 28}
            y2={mouthY}
            stroke={palette.ink}
            strokeWidth="2.2"
            strokeLinecap="round"
            opacity="0.8"
          />
        ) : mood === "error" ? (
          <line x1="20" y1={mouthY} x2="28" y2={mouthY} stroke={palette.ink} strokeWidth="2.2" strokeLinecap="round" opacity="0.8" />
        ) : art.mouthVariant === 0 ? (
          <path
            d={`M 19.5 ${mouthY - 0.5} Q 24 ${mouthY + 3.5} 28.5 ${mouthY - 0.5}`}
            fill="none"
            stroke={palette.ink}
            strokeWidth="2.2"
            strokeLinecap="round"
            opacity="0.8"
          />
        ) : (
          <line x1="20" y1={mouthY} x2="28" y2={mouthY} stroke={palette.ink} strokeWidth="2.2" strokeLinecap="round" opacity="0.8" />
        )}
      </g>
      </g>

      {/* crisp edge + error ring */}
      <rect x="3.5" y="3.5" width="41" height="41" rx="12.5" fill="none" stroke="#000000" strokeOpacity="0.14" strokeWidth="1" />
      {mood === "error" && (
        <rect x="4.5" y="4.5" width="39" height="39" rx="11.5" fill="none" stroke="#ff6961" strokeWidth="2" />
      )}
    </svg>
  );
}

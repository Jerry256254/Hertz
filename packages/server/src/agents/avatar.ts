import crypto from "node:crypto";

/**
 * Procedural generative avatars — effectively infinite and regenerable.
 *
 * An avatar is a small JSON spec whose seed is the whole artwork: rendering is
 * a pure deterministic function of the seed (FNV-1a + mulberry32 PRNG), so the
 * same spec always renders the same abstract artwork and a fresh random seed
 * always yields a unique one. No bitmaps are stored — only the spec — and the
 * artwork renders as standalone SVG (or a data URL) anywhere.
 *
 * Deliberately abstract (flow fields, topographic rings, orbits, blobs,
 * constellations, facets). No letters in circles, no robot icons, no emoji.
 */

export interface AvatarSpec {
  version: 1;
  kind: "generative";
  /** Opaque unique seed (agent name + randomness). Same seed = same artwork. */
  seed: string;
}

export const AVATAR_SIZE = 512;

/* ------------------------------------------------------------------ */
/* Seeded PRNG                                                         */
/* ------------------------------------------------------------------ */

function fnv1a(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
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

interface Rng {
  (): number;
  range(min: number, max: number): number;
  int(min: number, max: number): number;
  pick<T>(arr: readonly T[]): T;
}

function makeRng(seed: string): Rng {
  const next = mulberry32(fnv1a(seed));
  const r = (() => next()) as Rng;
  r.range = (min: number, max: number) => min + next() * (max - min);
  r.int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  r.pick = <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)] as T;
  return r;
}

/* ------------------------------------------------------------------ */
/* Palettes                                                            */
/* ------------------------------------------------------------------ */

interface AvatarPalette {
  bg0: string;
  bg1: string;
  line: string;
  line2: string;
  accent: string;
  dot: string;
}

const PALETTES: AvatarPalette[] = [
  { bg0: "#0d1417", bg1: "#1d2e33", line: "#e9e2d0", line2: "#7fb5a8", accent: "#e8a33d", dot: "#f4efe2" },
  { bg0: "#171310", bg1: "#31241a", line: "#f2e4c9", line2: "#c98d5e", accent: "#e05e2b", dot: "#f7ecd8" },
  { bg0: "#101510", bg1: "#22361f", line: "#e3ecd9", line2: "#8fae7e", accent: "#d8b93c", dot: "#eef3e4" },
  { bg0: "#f4ede1", bg1: "#ddcda9", line: "#3a2c1c", line2: "#a9764f", accent: "#b3401e", dot: "#2e2318" },
  { bg0: "#14100e", bg1: "#38261d", line: "#efe0cd", line2: "#b98a68", accent: "#d94f30", dot: "#f6e8d6" },
  { bg0: "#0e1210", bg1: "#20302a", line: "#dfe8dd", line2: "#6fa08e", accent: "#e2c14e", dot: "#eef2ea" },
  { bg0: "#efe9dc", bg1: "#d3c5a6", line: "#26302b", line2: "#5f7a6a", accent: "#c25e2e", dot: "#1e2622" },
  { bg0: "#120f0d", bg1: "#2f241a", line: "#eadfc8", line2: "#9c8465", accent: "#c9a13b", dot: "#f2e8d2" },
  { bg0: "#0f1a1c", bg1: "#264144", line: "#e6ece5", line2: "#7fa8a0", accent: "#dd7a3c", dot: "#eef0e8" },
  { bg0: "#1a1410", bg1: "#41301c", line: "#f0e6d2", line2: "#c08d4f", accent: "#a83c22", dot: "#f5ecd8" },
];

/* ------------------------------------------------------------------ */
/* Motifs                                                              */
/* ------------------------------------------------------------------ */

/** Compact number formatting to keep the SVG lean. */
const f = (n: number): string => {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};

interface MotifArt {
  defs: string;
  body: string;
}

/** Streamlines following a sinusoidal angle field. */
function motifFlow(r: Rng, p: AvatarPalette): MotifArt {
  const S = AVATAR_SIZE;
  const a = r.range(0.004, 0.009);
  const b = r.range(1.5, 3.2);
  const c = r.range(0.004, 0.009);
  const d = r.range(1.5, 3.2);
  const p1 = r.range(0, Math.PI * 2);
  const p2 = r.range(0, Math.PI * 2);
  const colors = [p.line, p.line, p.line2, p.line2, p.accent] as const;
  const out: string[] = [];
  for (let i = 0, n = r.int(22, 30); i < n; i++) {
    let x = r.range(-40, S + 40);
    let y = r.range(-40, S + 40);
    const pts = [`M${f(x)},${f(y)}`];
    const steps = r.int(12, 18);
    const stepLen = r.range(14, 22);
    for (let s = 0; s < steps; s++) {
      const ang = Math.sin(x * a + p1) * b + Math.cos(y * c + p2) * d;
      x += Math.cos(ang) * stepLen;
      y += Math.sin(ang) * stepLen;
      pts.push(`L${f(x)},${f(y)}`);
    }
    out.push(
      `<path d="${pts.join("")}" fill="none" stroke="${r.pick(colors)}" stroke-width="${r.range(2, 7).toFixed(1)}" stroke-linecap="round" opacity="${r.range(0.25, 0.7).toFixed(2)}"/>`,
    );
  }
  return { defs: "", body: out.join("") };
}

/** Concentric wobbly rings — topographic feel. */
function motifRings(r: Rng, p: AvatarPalette): MotifArt {
  const S = AVATAR_SIZE;
  const cx = S / 2 + r.range(-40, 40);
  const cy = S / 2 + r.range(-40, 40);
  const count = r.int(10, 14);
  const gap = (S * 0.46) / count;
  const k1 = r.int(2, 5);
  const k2 = r.int(3, 7);
  const ph1 = r.range(0, Math.PI * 2);
  const ph2 = r.range(0, Math.PI * 2);
  const amp = r.range(6, 18);
  const amp2 = r.range(3, 9);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const base = 24 + i * gap;
    const pts: string[] = [];
    const n = 72;
    for (let j = 0; j <= n; j++) {
      const t = (j / n) * Math.PI * 2;
      const rr = base + amp * Math.sin(k1 * t + ph1) + amp2 * Math.sin(k2 * t + ph2);
      pts.push(`${j === 0 ? "M" : "L"}${f(cx + Math.cos(t) * rr)},${f(cy + Math.sin(t) * rr)}`);
    }
    const col = i % 4 === 3 ? p.accent : i % 2 === 0 ? p.line : p.line2;
    out.push(
      `<path d="${pts.join("")}Z" fill="none" stroke="${col}" stroke-width="${r.range(1.5, 4).toFixed(1)}" opacity="${r.range(0.45, 0.85).toFixed(2)}"/>`,
    );
  }
  return { defs: "", body: out.join("") };
}

/** Tilted orbital ellipses with satellites and a starfield. */
function motifOrbit(r: Rng, p: AvatarPalette): MotifArt {
  const S = AVATAR_SIZE;
  const cx = S / 2;
  const cy = S / 2;
  const out: string[] = [];
  const sats: string[] = [];
  // Starfield backdrop so the artwork is always rich, whatever the orbits do.
  for (let i = 0, n = r.int(48, 64); i < n; i++) {
    out.push(
      `<circle cx="${f(r.range(20, S - 20))}" cy="${f(r.range(20, S - 20))}" r="${f(r.range(1, 3.4))}" fill="${r.pick([p.dot, p.dot, p.line2])}" opacity="${r.range(0.25, 0.85).toFixed(2)}"/>`,
    );
  }
  // Thin dashed guide rings for depth.
  const guideR = r.range(150, 210);
  out.push(
    `<circle cx="${cx}" cy="${cy}" r="${f(guideR)}" fill="none" stroke="${p.line2}" stroke-width="1.4" stroke-dasharray="2 9" opacity="0.5"/>`,
  );
  out.push(
    `<circle cx="${cx}" cy="${cy}" r="${f(guideR * r.range(0.55, 0.7))}" fill="none" stroke="${p.line}" stroke-width="1.2" stroke-dasharray="1 7" opacity="0.35"/>`,
  );
  for (let i = 0, n = r.int(5, 8); i < n; i++) {
    const rx = r.range(70, 225);
    const ry = rx * r.range(0.28, 0.62);
    const rot = r.range(0, 180);
    out.push(
      `<ellipse cx="${cx}" cy="${cy}" rx="${f(rx)}" ry="${f(ry)}" transform="rotate(${f(rot)} ${cx} ${cy})" fill="none" stroke="${i % 3 === 2 ? p.accent : p.line}" stroke-width="${r.range(1.5, 3.5).toFixed(1)}" opacity="${r.range(0.4, 0.75).toFixed(2)}"/>`,
    );
    const satCount = r.int(1, 3);
    for (let k = 0; k < satCount; k++) {
      const t = r.range(0, Math.PI * 2);
      const ex = rx * Math.cos(t);
      const ey = ry * Math.sin(t);
      const rad = (rot * Math.PI) / 180;
      const x = cx + ex * Math.cos(rad) - ey * Math.sin(rad);
      const y = cy + ex * Math.sin(rad) + ey * Math.cos(rad);
      const sr = r.range(4, 12);
      sats.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(sr)}" fill="${r.pick([p.accent, p.dot, p.line2])}"/>`);
      sats.push(
        `<circle cx="${f(x)}" cy="${f(y)}" r="${f(sr * 2.1)}" fill="none" stroke="${p.line2}" stroke-width="1" opacity="0.45"/>`,
      );
    }
  }
  out.push(`<circle cx="${cx}" cy="${cy}" r="${f(r.range(10, 20))}" fill="${p.accent}"/>`);
  out.push(
    `<circle cx="${cx}" cy="${cy}" r="${f(r.range(26, 34))}" fill="none" stroke="${p.accent}" stroke-width="1.6" opacity="0.6"/>`,
  );
  return { defs: "", body: out.join("") + sats.join("") };
}

/** Overlapping translucent organic blobs. */
function motifBlobs(r: Rng, p: AvatarPalette): MotifArt {
  const S = AVATAR_SIZE;
  const cx = S / 2;
  const cy = S / 2;
  const defs: string[] = [];
  const out: string[] = [];
  const cols = [p.accent, p.line2, p.line] as const;
  for (let i = 0, n = r.int(6, 9); i < n; i++) {
    const bx = cx + r.range(-130, 130);
    const by = cy + r.range(-130, 130);
    const br = r.range(55, 150);
    const col = r.pick(cols);
    const gid = `bl${i}`;
    defs.push(
      `<radialGradient id="${gid}" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="${col}" stop-opacity="${r.range(0.5, 0.8).toFixed(2)}"/><stop offset="100%" stop-color="${col}" stop-opacity="0"/></radialGradient>`,
    );
    out.push(`<circle cx="${f(bx)}" cy="${f(by)}" r="${f(br)}" fill="url(#${gid})"/>`);
  }
  for (let i = 0; i < 14; i++) {
    out.push(
      `<circle cx="${f(r.range(40, S - 40))}" cy="${f(r.range(40, S - 40))}" r="${f(r.range(2, 6))}" fill="${p.dot}" opacity="${r.range(0.4, 0.9).toFixed(2)}"/>`,
    );
  }
  return { defs: defs.join(""), body: out.join("") };
}

/** Scattered points with near-neighbour connections. */
function motifConstellation(r: Rng, p: AvatarPalette): MotifArt {
  const S = AVATAR_SIZE;
  const pts: Array<{ x: number; y: number; rad: number; c: string }> = [];
  for (let i = 0, n = r.int(26, 38); i < n; i++) {
    pts.push({
      x: r.range(50, S - 50),
      y: r.range(50, S - 50),
      rad: r.range(2.5, 5.5),
      c: r.pick([p.dot, p.dot, p.line, p.accent]),
    });
  }
  const lines: string[] = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i] as { x: number; y: number };
      const b = pts[j] as { x: number; y: number };
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < 115) {
        lines.push(
          `<line x1="${f(a.x)}" y1="${f(a.y)}" x2="${f(b.x)}" y2="${f(b.y)}" stroke="${p.line2}" stroke-width="1.4" opacity="${(0.55 * (1 - d / 115)).toFixed(2)}"/>`,
        );
      }
    }
  }
  const dots = pts.map(
    (pt) => `<circle cx="${f(pt.x)}" cy="${f(pt.y)}" r="${f(pt.rad)}" fill="${pt.c}"/>`,
  );
  return { defs: "", body: lines.join("") + dots.join("") };
}

/** Low-poly triangular facets on a jittered grid. */
function motifFacets(r: Rng, p: AvatarPalette): MotifArt {
  const S = AVATAR_SIZE;
  const N = 7;
  const grid: Array<Array<[number, number]>> = [];
  for (let i = 0; i <= N; i++) {
    grid[i] = [];
    for (let j = 0; j <= N; j++) {
      (grid[i] as Array<[number, number]>)[j] = [(i / N) * S + r.range(-28, 28), (j / N) * S + r.range(-28, 28)];
    }
  }
  const pt = (q: [number, number]): string => `${f(q[0])},${f(q[1])}`;
  const out: string[] = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const a = (grid[i] as Array<[number, number]>)[j] as [number, number];
      const b = (grid[i + 1] as Array<[number, number]>)[j] as [number, number];
      const c = (grid[i] as Array<[number, number]>)[j + 1] as [number, number];
      const d = (grid[i + 1] as Array<[number, number]>)[j + 1] as [number, number];
      const roll = r();
      const col = roll < 0.12 ? p.accent : roll < 0.5 ? p.line : p.line2;
      const o = (roll < 0.12 ? r.range(0.25, 0.5) : r.range(0.05, 0.16)).toFixed(2);
      out.push(`<polygon points="${pt(a)} ${pt(b)} ${pt(d)}" fill="${col}" opacity="${o}"/>`);
      out.push(`<polygon points="${pt(a)} ${pt(d)} ${pt(c)}" fill="${col}" opacity="${o}"/>`);
    }
  }
  return { defs: "", body: out.join("") };
}

const MOTIFS: ReadonlyArray<{ name: string; render: (r: Rng, p: AvatarPalette) => MotifArt }> = [
  { name: "flow", render: motifFlow },
  { name: "rings", render: motifRings },
  { name: "orbit", render: motifOrbit },
  { name: "blobs", render: motifBlobs },
  { name: "constellation", render: motifConstellation },
  { name: "facets", render: motifFacets },
];

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** Mint a fresh unique avatar spec (e.g. at onboarding). */
export function generateAvatarSpec(name: string): AvatarSpec {
  const base = (name || "agent").trim().toLowerCase().slice(0, 40) || "agent";
  return { version: 1, kind: "generative", seed: `${base}:${crypto.randomBytes(6).toString("hex")}` };
}

/** Safely parse a stored avatar spec; null when missing or invalid. */
export function parseAvatarSpec(raw: string | null | undefined): AvatarSpec | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<AvatarSpec>;
    if (o && o.version === 1 && o.kind === "generative" && typeof o.seed === "string" && o.seed.length > 0 && o.seed.length <= 200) {
      return { version: 1, kind: "generative", seed: o.seed };
    }
    return null;
  } catch {
    return null;
  }
}

/** Render the spec as a standalone SVG string — pure function of the seed. */
export function renderAvatarSvg(spec: AvatarSpec | string, size: number = AVATAR_SIZE): string {
  const seed = typeof spec === "string" ? spec : spec.seed;
  const r = makeRng(`hertz-avatar:${seed}`);
  const palette = r.pick(PALETTES);
  const motif = r.pick(MOTIFS);
  const art = motif.render(r, palette);
  const gid = `g${(fnv1a(seed) % 100000).toString(36)}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Avatar agenta">` +
    `<defs>` +
    `<linearGradient id="${gid}bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${palette.bg0}"/><stop offset="100%" stop-color="${palette.bg1}"/></linearGradient>` +
    `<radialGradient id="${gid}v" cx="50%" cy="50%" r="72%"><stop offset="60%" stop-color="#000000" stop-opacity="0"/><stop offset="100%" stop-color="#000000" stop-opacity="0.22"/></radialGradient>` +
    art.defs +
    `</defs>` +
    `<rect width="${size}" height="${size}" fill="url(#${gid}bg)"/>` +
    art.body +
    `<rect width="${size}" height="${size}" fill="url(#${gid}v)"/>` +
    `</svg>`
  );
}

/** Data URL ready for <img src> or CSS — no extra requests needed. */
export function avatarDataUrl(spec: AvatarSpec | string): string {
  return `data:image/svg+xml;base64,${Buffer.from(renderAvatarSvg(spec)).toString("base64")}`;
}

/**
 * Resolve the SVG for an agent row: stored spec wins, otherwise a deterministic
 * fallback derived from the fallback seed (stable, never blank).
 */
export function avatarSvgForAgent(stored: string | null | undefined, fallbackSeed: string): string {
  return renderAvatarSvg(parseAvatarSpec(stored) ?? { version: 1, kind: "generative", seed: `agent:${fallbackSeed}` });
}

/**
 * Circle-safe avatar geometry tests.
 *
 * The generative avatars are shown in circular/squircle containers in the UI
 * (sidebar, chat header, profile panel, onboarding). Every motif must therefore
 * keep its important elements inside a centred safe zone — roughly a 15 %
 * margin from the square edges — so a circular crop never cuts a key element.
 * Deliberately decorative full-bleed textures (flow fields, facet grids,
 * starfields) are exempt: cropping them mid-stroke looks natural.
 *
 * Each motif is rendered standalone via renderMotifSvg() across many seeds and
 * its SVG geometry is measured directly — no trust in the generator's
 * internal arithmetic, only in what it actually emits.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AVATAR_MOTIF_NAMES,
  AVATAR_SAFE_RADIUS,
  AVATAR_SIZE,
  renderAvatarSvg,
  renderMotifSvg,
} from "../dist/agents/avatar.js";

const C = AVATAR_SIZE / 2; // 256
const dist = (x, y) => Math.hypot(x - C, y - C);

/** All `<tag …>` occurrences as attribute maps. */
function elements(svg, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b([^>]*?)/?>`, "g");
  for (const m of svg.matchAll(re)) {
    const attrs = {};
    for (const am of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[am[1]] = am[2];
    out.push(attrs);
  }
  return out;
}

/** Every M/L coordinate pair of every <path d="…">. */
function pathPoints(svg) {
  const pts = [];
  for (const p of elements(svg, "path")) {
    for (const m of (p.d ?? "").matchAll(/[ML](-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)) {
      pts.push([parseFloat(m[1]), parseFloat(m[2])]);
    }
  }
  return pts;
}

const circle = (el) => ({ cx: parseFloat(el.cx), cy: parseFloat(el.cy), r: parseFloat(el.r) });

const seeds = (n) => Array.from({ length: n }, (_, i) => `circle-safe:${i}`);

describe("avatar motifs are circle-safe", () => {
  it("exposes exactly the six known motifs", () => {
    assert.deepEqual([...AVATAR_MOTIF_NAMES].sort(), [
      "blobs",
      "constellation",
      "facets",
      "flow",
      "orbit",
      "rings",
    ]);
  });

  it("rings: every ring point sits inside the safe zone around the centre", () => {
    for (const s of seeds(12)) {
      const pts = pathPoints(renderMotifSvg("rings", s));
      assert.ok(pts.length > 500, `rings must draw many points (seed ${s})`);
      let maxD = 0;
      let minD = Infinity;
      for (const [x, y] of pts) {
        const d = dist(x, y);
        maxD = Math.max(maxD, d);
        minD = Math.min(minD, d);
        assert.ok(d <= AVATAR_SAFE_RADIUS + 6, `ring point ${d.toFixed(1)}px from centre exceeds safe zone (seed ${s})`);
      }
      assert.ok(maxD > 120, `rings must actually span the artwork, got max ${maxD.toFixed(1)} (seed ${s})`);
      assert.ok(minD < 60, `rings must reach near the centre, got min ${minD.toFixed(1)} (seed ${s})`);
    }
  });

  it("orbit: ellipses, guide rings and satellites stay inside the safe zone", () => {
    for (const s of seeds(12)) {
      const svg = renderMotifSvg("orbit", s);
      for (const el of elements(svg, "ellipse")) {
        const rx = parseFloat(el.rx);
        assert.ok(rx <= AVATAR_SAFE_RADIUS - 21.5, `orbit ellipse rx=${rx} too wide (seed ${s})`);
        assert.ok(parseFloat(el.ry) <= rx, `ry must not exceed rx (seed ${s})`);
      }
      for (const el of elements(svg, "circle")) {
        const { cx, cy, r } = circle(el);
        assert.ok([cx, cy, r].every(Number.isFinite), `circle has non-finite geometry (seed ${s})`);
        const d = dist(cx, cy);
        if (el["stroke-dasharray"]) {
          // Thin dashed guide ring.
          assert.ok(r <= AVATAR_SAFE_RADIUS - 21.5, `guide ring r=${r} too wide (seed ${s})`);
        } else if (d < 2) {
          // Central core + its halo ring.
          assert.ok(r <= 36, `central element r=${r} too big (seed ${s})`);
        } else if (r <= 3.5) {
          // Starfield speck — decorative texture, must only stay in the viewBox.
          assert.ok(cx >= 0 && cx <= AVATAR_SIZE && cy >= 0 && cy <= AVATAR_SIZE, `star outside viewBox (seed ${s})`);
        } else {
          // Satellite + its halo: no part may leave the safe zone.
          assert.ok(
            d + r <= AVATAR_SAFE_RADIUS + 0.5,
            `satellite extends to ${(d + r).toFixed(1)}px from centre (seed ${s})`,
          );
        }
      }
    }
  });

  it("blobs: soft washes and specks stay inside the safe zone", () => {
    for (const s of seeds(12)) {
      const svg = renderMotifSvg("blobs", s);
      for (const el of elements(svg, "circle")) {
        const { cx, cy, r } = circle(el);
        const d = dist(cx, cy);
        if (r >= 20) {
          // Blob wash: core placement bounded, visible extent inside the zone.
          assert.ok(Math.abs(cx - C) <= 65 && Math.abs(cy - C) <= 65, `blob core off-centre (seed ${s})`);
          assert.ok(r <= 107, `blob r=${r} too big (seed ${s})`);
          assert.ok(d + r <= 192, `blob extends to ${(d + r).toFixed(1)}px from centre (seed ${s})`);
        } else {
          assert.ok(d <= 186, `speck ${d.toFixed(1)}px from centre outside safe zone (seed ${s})`);
        }
      }
    }
  });

  it("constellation: every star sits on a centred disc, nothing near the edges", () => {
    for (const s of seeds(12)) {
      const svg = renderMotifSvg("constellation", s);
      const dots = elements(svg, "circle");
      assert.ok(dots.length >= 26, `constellation must draw enough stars (seed ${s})`);
      assert.ok(elements(svg, "line").length > 10, `constellation must connect stars (seed ${s})`);
      for (const el of dots) {
        const { cx, cy, r } = circle(el);
        const d = dist(cx, cy);
        assert.ok(
          d + r <= AVATAR_SAFE_RADIUS - 4,
          `star extends to ${(d + r).toFixed(1)}px from centre (seed ${s})`,
        );
      }
    }
  });

  it("flow and facets render as valid full-bleed decorative textures", () => {
    for (const s of seeds(6)) {
      const flow = renderMotifSvg("flow", s);
      assert.ok(elements(flow, "path").length >= 20, `flow must draw streamlines (seed ${s})`);
      const facets = renderMotifSvg("facets", s);
      assert.ok(elements(facets, "polygon").length >= 90, `facets must draw triangles (seed ${s})`);
    }
  });

  it("rejects an unknown motif name", () => {
    assert.throws(() => renderMotifSvg("neexistuje", "x"), /unknown avatar motif/);
  });
});

describe("renderAvatarSvg smoke test", () => {
  it("every rendered avatar is valid SVG with finite geometry", () => {
    for (const s of seeds(40)) {
      const svg = renderAvatarSvg({ version: 1, kind: "generative", seed: s });
      assert.ok(svg.startsWith("<svg"), `must start with <svg (seed ${s})`);
      assert.ok(svg.includes(`viewBox="0 0 ${AVATAR_SIZE} ${AVATAR_SIZE}"`), `must use the ${AVATAR_SIZE} viewBox (seed ${s})`);
      assert.ok(!/NaN|Infinity|undefined/.test(svg), `no broken numbers allowed (seed ${s})`);
      for (const el of elements(svg, "circle")) {
        const { cx, cy, r } = circle(el);
        assert.ok([cx, cy, r].every(Number.isFinite) && r > 0, `circle geometry must be finite (seed ${s})`);
      }
    }
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(tsx?|css)$/.test(name)) out.push(p);
  }
  return out;
}

// Pictographs, dingbats, misc symbols, emoji presentation selectors.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{2C00}-\u{2FEF}\u{FE0F}\u{200D}\u{3030}\u{303D}\u{3297}\u{3299}\u{00A9}\u{00AE}\u{203C}\u{2049}]/u;
// Decorative glyphs replaced by SVG icons / plain text.
const DECORATIVE_GLYPHS = /[↵▸]/;

describe("no emoji in web UI", () => {
  const files = walk(SRC);
  assert.ok(files.length > 10, "expected to scan web src files");

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    it(`${file} has no emoji pictographs`, () => {
      const m = text.match(EMOJI);
      assert.equal(m, null, `found emoji character ${JSON.stringify(m?.[0])} in ${file}`);
    });
    it(`${file} has no decorative glyphs (↵ ▸)`, () => {
      const m = text.match(DECORATIVE_GLYPHS);
      assert.equal(m, null, `found decorative glyph ${JSON.stringify(m?.[0])} in ${file} — use an SVG icon or plain text instead`);
    });
  }
});

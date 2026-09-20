import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { findUpdateScript } from "../dist/bin.js";

describe("hzcli update script resolution", () => {
  it("finds scripts/update.sh from the checkout (no ReferenceError in ESM)", () => {
    // Regression: bin.js used bare __dirname, which does not exist in ESM —
    // `hzcli update` crashed with ReferenceError before doing anything.
    const script = findUpdateScript();
    assert.ok(script, "expected to resolve scripts/update.sh");
    assert.ok(script.endsWith(path.join("scripts", "update.sh")));
    assert.ok(fs.existsSync(script));
  });
});

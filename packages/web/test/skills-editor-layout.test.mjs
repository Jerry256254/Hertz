import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const editor = readFileSync(join(SRC, "views", "SkillsEditor.tsx"), "utf8");
const shell = readFileSync(join(SRC, "shell", "HertzShell.tsx"), "utf8");

describe("skills panel responsive layout", () => {
  it("measures the real container width instead of trusting viewport breakpoints", () => {
    assert.ok(editor.includes("ResizeObserver"), "expected a ResizeObserver-based width measurement");
    assert.ok(!editor.includes("md:grid-cols-"), "two-column must not depend on the md: viewport breakpoint (the panel is narrower than the viewport)");
  });

  it("renders a two-column layout only when the container is wide enough", () => {
    assert.ok(editor.includes("TWO_COLUMN_MIN_WIDTH"), "expected a named two-column threshold");
    assert.ok(/wide\s*\?\s*\(/.test(editor), "expected the layout to branch on the measured width");
    assert.ok(editor.includes("grid-cols-[248px_minmax(0,1fr)]"), "expected list-left / detail-right columns with sane widths");
  });

  it("shows the skill detail as a fullscreen overlay with a back button on narrow widths", () => {
    assert.ok(editor.includes("showOverlay"), "expected an overlay branch for the selected skill");
    assert.ok(editor.includes("fixed inset-0 z-50"), "expected the detail to cover the whole viewport");
    assert.ok(editor.includes('role="dialog"'), "expected the overlay to be exposed as a dialog");
    assert.ok(editor.includes("Zpět na seznam"), "expected a Czech back-to-list button");
    assert.ok(editor.includes("ArrowLeft"), "expected an arrow icon for the back button (no emoji)");
  });

  it("never renders list and detail side by side on narrow widths", () => {
    // In the narrow branch only SkillList renders inline; the detail lives in the overlay.
    const m = editor.match(/\)\s*:\s*\(\s*<SkillList[\s\S]*?\/>\s*\)}/);
    assert.ok(m, "expected a narrow branch rendering only the skill list");
    assert.ok(!m[0].includes("SkillDetail"), "SkillDetail must not render inline in the narrow branch");
  });

  it("widens the desktop right panel for the skills tab so the two columns fit", () => {
    assert.ok(shell.includes('agentTab === "skills"'), "expected the panel width to react to the skills tab");
    assert.ok(shell.includes("lg:w-[640px]"), "expected a wider desktop panel for the skills tab");
  });
});

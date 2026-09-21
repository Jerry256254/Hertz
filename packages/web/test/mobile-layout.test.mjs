import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const read = (p) => readFileSync(join(SRC, p), "utf8");

function* tsxFiles(dir = SRC) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* tsxFiles(p);
    else if (e.endsWith(".tsx")) yield p;
  }
}

describe("mobile layout foundations", () => {
  const tokens = read("design/tokens.css");
  const html = readFileSync(join(ROOT, "index.html"), "utf8");

  it("viewport locks zoom behavior for the keyboard", () => {
    assert.ok(html.includes("viewport-fit=cover"), "expected viewport-fit=cover");
    assert.ok(html.includes("interactive-widget=resizes-content"), "expected the keyboard to resize the layout, not overlay it");
  });

  it("defines safe-area helpers", () => {
    assert.ok(tokens.includes("--sat: env(safe-area-inset-top"), "expected --sat");
    assert.ok(tokens.includes("--sab: env(safe-area-inset-bottom"), "expected --sab");
    assert.ok(tokens.includes(".safe-top"), "expected .safe-top");
    assert.ok(tokens.includes(".safe-bottom"), "expected .safe-bottom");
  });

  it("forbids page-level horizontal scrolling", () => {
    assert.ok(/html,\s*body\s*{\s*overflow-x:\s*clip/.test(tokens), "expected overflow-x: clip on html, body");
  });

  it("keeps every details/summary row thumb-reachable", () => {
    assert.ok(/details\s*>\s*summary\s*{[^}]*min-height:\s*var\(--tap-min\)/.test(tokens), "expected a 44px minimum on details > summary");
  });

  it("prevents iOS auto-zoom on form fields", () => {
    assert.ok(tokens.includes("@media (max-width: 639px)"), "expected a phone media query");
    assert.ok(/input,\s*select,\s*textarea\s*{\s*font-size:\s*16px/.test(tokens), "expected 16px form text on phones");
  });

  it("chat composer respects the keyboard and home indicator", () => {
    const chat = read("chat/ChatView.tsx");
    assert.ok(chat.includes("env(safe-area-inset-bottom)"), "expected safe-area padding under the composer");
    assert.ok(chat.includes("h-dvh") || read("shell/HertzShell.tsx").includes("h-dvh"), "expected a dynamic-viewport root so the keyboard shrinks the layout");
  });
});

describe("44px touch targets", () => {
  const ui = read("components/ui.tsx");

  it("shared Button sizes all meet the 44px minimum", () => {
    for (const size of ["sm", "md", "lg"]) {
      const m = ui.match(new RegExp(`${size}:\\s*"([^"]+)"`));
      assert.ok(m, `expected a ${size} size class`);
      const h = m[1].match(/min-h-\[(\d+)px\]/);
      assert.ok(h && Number(h[1]) >= 44, `Button ${size} must be at least 44px tall`);
    }
  });

  it("IconButton and Input meet the 44px minimum", () => {
    assert.ok(ui.includes("h-11 w-11"), "expected a 44x44 IconButton");
    assert.ok(/export const Input[\s\S]*?h-11/.test(ui), "expected a 44px Input");
  });

  it("no button or link in src renders below 44px", () => {
    const small = /\b(h-[1-9](?![0-9])\s|h-10(?!\d)|p-2(?!\d)|p-1(?!\d)|py-1\.5|py-2(?!\.5)|h-8(?!\d)|h-7(?!\d)|h-6(?!\d))\b/;
    const big = ["min-h-[44px]", "h-11", "h-12", "h-14", "min-h-[52px]", "min-h-[48px]", "min-h-[56px]", "min-h-[60px]"];
    // Tag scanner aware of JSX: a ">" inside {} (e.g. () =>) does not end the tag.
    function tagEnd(src, from) {
      let depth = 0;
      for (let i = from; i < src.length; i++) {
        const c = src[i];
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === ">" && depth === 0) return i;
      }
      return -1;
    }
    const offenders = [];
    for (const f of tsxFiles()) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/<(button|a)\b/g)) {
        const end = tagEnd(src, m.index + m[0].length);
        if (end < 0) continue;
        const cls = (src.slice(m.index, end).match(/className="([^"]*)"/s) || [])[1] || "";
        if (big.some((k) => cls.includes(k))) continue;
        const hit = cls.match(small);
        if (hit) offenders.push(`${f.split("src/")[1]}: ${cls.slice(0, 80)}…`);
      }
    }
    assert.deepEqual(offenders, [], `interactive elements below 44px:\n${offenders.join("\n")}`);
  });
});

describe("mobile navigation", () => {
  it("desktop icon rail is hidden on phones", () => {
    const rail = read("shell/IconRail.tsx");
    assert.ok(rail.includes('className'), "expected IconRail to accept a className");
    const shell = read("shell/HertzShell.tsx");
    assert.ok(shell.includes('className="hidden md:flex"'), "expected the rail hidden below md");
  });

  it("a bottom tab bar replaces the rail on phones", () => {
    const bar = read("shell/MobileTabBar.tsx");
    assert.ok(bar.includes("md:hidden"), "expected the tab bar to show only on phones");
    assert.ok(bar.includes("safe-bottom"), "expected safe-area padding under the tab bar");
    for (const label of ["Chat", "Hledat", "Schválení", "Nastavení"]) {
      assert.ok(bar.includes(`label="${label}"`), `expected a "${label}" tab`);
    }
    assert.ok(bar.includes("min-h-[60px]"), "expected tall tab targets");
    assert.ok(read("shell/HertzShell.tsx").includes("<MobileTabBar"), "expected the shell to render the tab bar");
  });

  it("the conversations drawer closes itself after a selection on phones", () => {
    const shell = read("shell/HertzShell.tsx");
    assert.ok(shell.includes("window.innerWidth < 768) setSidebarOpen(false)"), "expected auto-close on select");
    assert.ok(shell.includes("max-w-[86vw]"), "expected the drawer to never cover the full width");
    assert.ok(shell.includes("onClose={() => setSidebarOpen(false)}"), "expected a close affordance on the sidebar");
  });

  it("the right panel stays within the viewport", () => {
    assert.ok(read("shell/HertzShell.tsx").includes("max-w-[92vw]"), "expected the right panel capped at 92vw");
  });
});

describe("chat on narrow screens", () => {
  const chat = read("chat/ChatView.tsx");
  const msg = read("components/MessageView.tsx");

  it("bubbles use more of a 360px screen", () => {
    assert.ok(msg.includes("max-w-[85%]"), "expected wider user bubbles on phones");
    assert.ok(msg.includes("max-w-[92%]"), "expected wider assistant bubbles on phones");
  });

  it("message rows have tighter side padding on phones", () => {
    assert.ok(msg.includes("px-3 sm:px-4"), "expected 12px side padding below sm");
  });

  it("the chat header is compact and safe-area aware", () => {
    assert.ok(chat.includes("safe-top"), "expected safe-area padding on the chat header");
    assert.ok(chat.includes("h-14"), "expected a shorter header on phones");
    assert.ok(chat.includes("sm:h-[60px]"), "expected the full header on desktop");
  });

  it("composer controls are 44px", () => {
    assert.ok(chat.includes("min-h-[44px] w-full min-w-0 flex-1"), "expected a 44px text field");
    assert.ok(chat.includes("h-11 w-11 shrink-0") && chat.includes("Odeslat zprávu"), "expected a 44px send button");
  });
});

describe("settings as a mobile bottom sheet", () => {
  const modal = read("settings/SettingsModal.tsx");

  it("docks to the bottom on phones", () => {
    assert.ok(modal.includes("items-end"), "expected bottom docking below sm");
    assert.ok(modal.includes("sm:items-center"), "expected vertical centering on desktop");
    assert.ok(modal.includes("rounded-t-[24px]"), "expected sheet-style top corners on phones");
    assert.ok(modal.includes("sm:rounded-[24px]"), "expected a centered dialog on desktop");
    assert.ok(modal.includes("safe-bottom"), "expected safe-area padding in the sheet");
  });

  it("offers thumb-sized section tabs on phones", () => {
    assert.ok(modal.includes('role="tablist"'), "expected a mobile tablist");
    assert.ok(modal.includes("min-h-[44px] shrink-0"), "expected 44px section tabs");
  });
});

describe("agent panel tabs on narrow screens", () => {
  const panel = read("panels/AgentPanel.tsx");

  it("tabs are labeled and scroll horizontally instead of squeezing", () => {
    assert.ok(panel.includes("overflow-x-auto"), "expected a scrollable tab row");
    assert.ok(panel.includes("label="), "expected labeled tabs, not icon-only");
    assert.ok(panel.includes("min-h-[44px]"), "expected 44px tab targets");
  });
});

describe("editor save bars", () => {
  for (const f of ["views/SoulEditor.tsx", "views/UserProfileEditor.tsx"]) {
    it(`${f} keeps Uložit reachable on phones`, () => {
      const src = read(f);
      assert.ok(src.includes("sm:hidden"), "expected a mobile-only save bar");
      assert.ok(src.includes("min-h-[52px]"), "expected a tall thumb-friendly save button");
      assert.ok(src.includes("env(safe-area-inset-bottom)"), "expected safe-area padding under the save bar");
      assert.ok(src.includes("hidden") && src.includes("sm:inline-flex"), "expected the header save button hidden on phones");
    });
  }
});

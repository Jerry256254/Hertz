import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (p) => readFileSync(join(SRC, p), "utf8");

/**
 * Každý vertikální scroll kontejner potřebuje omezenou výšku od rodiče:
 * ve flex sloupci to znamená min-h-0 + flex-1 v celém řetězci. Chybějící
 * článek řetězce = seznam roste s obsahem a overflow-y-auto se nikdy
 * neaktivuje (uživatel nemůže sjet dolů).
 *
 * Tyto testy hlídají strukturu staticky nad className řetězci.
 */
describe("scroll containers: chat + channel views", () => {
  const chat = read("chat/ChatView.tsx");
  const channel = read("views/ChannelView.tsx");

  it("chat message list is a bounded vertical scroller", () => {
    assert.ok(
      /ref=\{scrollRef\}[\s\S]*?className="[^"]*min-h-0[^"]*flex-1[^"]*overflow-y-auto/.test(chat),
      "expected the messages div to be min-h-0 flex-1 overflow-y-auto",
    );
  });

  it("ChatView root stretches in a flex column (flex-1 + min-h-0)", () => {
    assert.ok(
      /return \(\s*<div className="flex min-h-0 min-w-0 flex-1 flex-col">/.test(chat),
      "expected the ChatView root to be a flex column with min-h-0 flex-1",
    );
  });

  it("channel view embeds ChatView inside a flex column, not a plain block", () => {
    // Regrese: obálka byla <div className="min-h-0 flex-1"> (block) — flex-1
    // na kořenu ChatView se pak neaplikovalo, seznam zpráv neměl omezenou
    // výšku a v kanálovém pohledu nešlo scrollovat dolů.
    assert.ok(
      /<div className="[^"]*\bflex\b[^"]*\bmin-h-0\b[^"]*\bflex-1\b[^"]*\bflex-col\b[^"]*">\s*<ChatView/.test(channel),
      "expected the ChatView wrapper in ChannelView to be a flex column with min-h-0 flex-1",
    );
    assert.ok(
      !/<div className="min-h-0 flex-1">\s*<ChatView/.test(channel),
      "the ChatView wrapper must not be a plain block div",
    );
  });
});

describe("scroll containers: sidebar chat list", () => {
  const sidebar = read("shell/SideBar.tsx");
  const shell = read("shell/HertzShell.tsx");

  it("sidebar list is a bounded vertical scroller", () => {
    assert.ok(
      /className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 pt-1"/.test(sidebar),
      "expected the chat list div to be min-h-0 flex-1 overflow-y-auto",
    );
  });

  it("SideBar root is a flex-1 column so the list gets a bounded height", () => {
    assert.ok(
      /return \(\s*<div className="flex min-h-0 min-w-0 flex-1 flex-col">/.test(sidebar),
      "expected the SideBar root to be a flex column with min-h-0 flex-1",
    );
  });

  it("mobile drawer and desktop sidebar both constrain height", () => {
    // Drawer: fixed inset-y-0 na mobilu, static v desktopovém flex řádku.
    assert.ok(shell.includes("fixed inset-y-0 left-0"), "expected the mobile drawer to span the viewport height");
    assert.ok(/aside className="[^"]*flex[^"]*flex-col[^"]*md:static/.test(shell), "expected the sidebar aside to be a flex column");
  });
});

describe("scroll containers: right panel", () => {
  const agentPanel = read("panels/AgentPanel.tsx");
  const browserPanel = read("panels/BrowserPanel.tsx");
  const shell = read("shell/HertzShell.tsx");

  it("agent panel content scrolls inside a bounded flex column", () => {
    assert.ok(
      /return \(\s*<div className="flex min-h-0 min-w-0 flex-1 flex-col">/.test(agentPanel),
      "expected the AgentPanel root to be a flex column with min-h-0 flex-1",
    );
    assert.ok(
      agentPanel.includes('className="min-h-0 flex-1 overflow-y-auto px-3 pb-4"'),
      "expected the agent panel tab content to be min-h-0 flex-1 overflow-y-auto",
    );
  });

  it("browser panel content scrolls inside a bounded flex column", () => {
    assert.ok(
      browserPanel.includes('className="min-h-0 flex-1 overflow-y-auto bg-bg px-4 pb-4"'),
      "expected the browser panel body to be min-h-0 flex-1 overflow-y-auto",
    );
  });

  it("right drawer constrains height on mobile and desktop", () => {
    assert.ok(shell.includes("fixed inset-y-0 right-0"), "expected the right drawer to span the viewport height");
    assert.ok(/aside className=\{`[^`]*flex[^`]*flex-col[^`]*lg:static/.test(shell), "expected the right aside to be a flex column");
  });
});

describe("scroll containers: settings modal / bottom sheet", () => {
  const settings = read("settings/SettingsModal.tsx");

  it("modal card caps height and clips (bottom sheet on mobile)", () => {
    assert.ok(settings.includes("max-h-[94dvh]"), "expected the settings card to cap at 94dvh");
    assert.ok(/animate-fade-in overflow-hidden/.test(settings), "expected the settings card to clip overflowing content");
  });

  it("settings body is a bounded vertical scroller", () => {
    assert.ok(
      settings.includes('className="min-h-0 flex-1 overflow-y-auto border-t border-border px-4 pb-6 pt-4 sm:px-5"'),
      "expected the settings section body to be min-h-0 flex-1 overflow-y-auto",
    );
  });

  it("settings content column is a flex column with min-h-0", () => {
    assert.ok(
      settings.includes('className="flex min-h-0 min-w-0 flex-1 flex-col"'),
      "expected the settings content column to be flex min-h-0 min-w-0 flex-1 flex-col",
    );
  });

  it("mobile section tabs scroll horizontally without chaining", () => {
    assert.ok(/overflow-x-auto px-4 pb-3 sm:hidden/.test(settings), "expected horizontally scrollable section tabs on mobile");
  });
});

describe("scroll containers: editors, inbox and overlays", () => {
  it("SoulEditor body scrolls", () => {
    const soul = read("views/SoulEditor.tsx");
    assert.ok(soul.includes('className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 md:px-5"'), "expected SoulEditor to have a bounded scroll body");
  });

  it("UserProfileEditor body scrolls", () => {
    const user = read("views/UserProfileEditor.tsx");
    assert.ok(user.includes('className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 md:px-5"'), "expected UserProfileEditor to have a bounded scroll body");
  });

  it("ApprovalsView body scrolls", () => {
    const approvals = read("views/ApprovalsView.tsx");
    assert.ok(approvals.includes('className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 md:px-5"'), "expected ApprovalsView to have a bounded scroll body");
  });

  it("MemoryView (full page) body scrolls", () => {
    const memory = read("views/MemoryView.tsx");
    assert.ok(memory.includes("min-h-0 flex-1") && memory.includes("overflow-y-auto px-3 py-4 md:px-5"), "expected MemoryView to have a bounded scroll body");
  });

  it("search overlay results are capped and scrollable", () => {
    const search = read("overlays/SearchOverlay.tsx");
    assert.ok(search.includes("max-h-[50vh] overflow-y-auto"), "expected search results capped at 50vh with overflow-y-auto");
  });

  it("mobile skill detail overlay has a bounded scroll body", () => {
    const skills = read("views/SkillsEditor.tsx");
    assert.ok(skills.includes('className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-4"'), "expected the skill detail overlay to have a bounded scroll body");
  });
});

describe("scroll hygiene (no chaining, no stuck scroll)", () => {
  const tokens = read("design/tokens.css");

  it("inner vertical scrollers contain overscroll (no scroll chaining to the page)", () => {
    assert.ok(tokens.includes("overscroll-behavior-y: contain"), "expected overscroll-behavior-y: contain for inner scrollers");
  });

  it("keeps iOS momentum scrolling on inner scrollers", () => {
    assert.ok(tokens.includes("-webkit-overflow-scrolling: touch"), "expected -webkit-overflow-scrolling: touch");
  });

  it("still forbids page-level horizontal scrolling", () => {
    assert.ok(/html,\s*body\s*{\s*overflow-x:\s*clip/.test(tokens), "expected overflow-x: clip on html, body");
  });

  it("chat auto-scroll respects the user's manual position", () => {
    const chat = read("chat/ChatView.tsx");
    assert.ok(chat.includes("stickToBottomRef"), "expected a stick-to-bottom guard");
    assert.ok(/function onScroll\(\)[\s\S]*?stickToBottomRef\.current = nearBottom/.test(chat), "expected onScroll to release the stick when the user scrolls up");
  });
});

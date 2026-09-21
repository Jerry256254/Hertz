#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// pptxgenjs dodává .d.ts, jejichž defaultní import není podle tsc
// konstruovatelný (namespace místo třídy) — proto runtime import přes
// createRequire a lokální strukturální typy jen pro používané API.
const require = createRequire(import.meta.url);
interface PptxSlide {
  background: unknown;
  addText(text: unknown, opts?: Record<string, unknown>): void;
  addImage(opts: Record<string, unknown>): void;
  addShape(shape: string, opts: Record<string, unknown>): void;
  addNotes(notes: string): void;
}
interface PptxGen {
  author: string;
  title: string;
  layout: string;
  defineLayout(opts: { name: string; width: number; height: number }): void;
  addSlide(): PptxSlide;
  writeFile(opts: { fileName: string }): Promise<unknown>;
}
const PptxGenJS = require("pptxgenjs") as new () => PptxGen;

// ---------------------------------------------------------------------------
// Vlastní prezentační konektor (lokální, bez externího účtu)
//
// Proč vlastní místo Canva/Gamma: Canva nabízí pouze hostovaný MCP server
// (mcp.canva.com) s OAuth přihlášením ke Canva účtu a placenými funkcemi —
// pro self-hosted nasazení bez Canva účtu nepoužitelné. Gamma nemá oficiální
// veřejné MCP a komunitní servery vyžadují placený Gamma API klíč. Lokální
// generátor PPTX (pptxgenjs) + samostatného HTML je offline, zdarma a plně
// v režii Hertze.
// ---------------------------------------------------------------------------

const OUTPUT_DIR = process.env.PRESENTATION_OUTPUT_DIR ?? path.join(os.tmpdir(), "hertz-presentations");

const slideSchema = z.object({
  heading: z.string().min(1).max(200).describe("Nadpis slidu"),
  body: z.string().max(2000).optional().describe("Odstavec textu pod nadpisem"),
  bullets: z.array(z.string().max(300)).max(12).optional().describe("Odrážky (max 12)"),
  imageUrl: z.string().url().optional().describe("Volitelný obrázek (URL) vpravo od textu"),
  notes: z.string().max(2000).optional().describe("Poznámky řečníka (jen do PPTX)"),
});

type Slide = z.infer<typeof slideSchema>;

interface Deck {
  id: string;
  title: string;
  subtitle?: string;
  author?: string;
  theme: string;
  slides: Slide[];
  createdAt: string;
  updatedAt: string;
}

const THEMES: Record<string, { bg: string; fg: string; accent: string; muted: string; card: string }> = {
  light: { bg: "FFFFFF", fg: "1F2937", accent: "2563EB", muted: "6B7280", card: "F3F4F6" },
  dark: { bg: "111827", fg: "F9FAFB", accent: "60A5FA", muted: "9CA3AF", card: "1F2937" },
  blue: { bg: "EFF6FF", fg: "1E3A8A", accent: "1D4ED8", muted: "475569", card: "FFFFFF" },
};

function themeOf(name: string | undefined) {
  return THEMES[name ?? "light"] ?? THEMES.light!;
}

function deckDir(id: string): string {
  return path.join(OUTPUT_DIR, id);
}

function assertInside(dir: string, p: string): string {
  const resolved = path.resolve(dir, p);
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) throw new Error("Neplatná cesta k prezentaci.");
  return resolved;
}

async function readDeck(id: string): Promise<Deck> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new Error(`Neznámé ID prezentace: ${id}`);
  const file = assertInside(OUTPUT_DIR, path.join(id, "deck.json"));
  const raw = await fs.readFile(file, "utf8").catch(() => {
    throw new Error(`Prezentace s ID ${id} neexistuje.`);
  });
  return JSON.parse(raw) as Deck;
}

async function writeDeck(deck: Deck): Promise<void> {
  const dir = deckDir(deck.id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "deck.json"), JSON.stringify(deck, null, 2), "utf8");
}

function pptxPath(id: string): string {
  return path.join(deckDir(id), "prezentace.pptx");
}
function htmlPath(id: string): string {
  return path.join(deckDir(id), "prezentace.html");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// --- PPTX ------------------------------------------------------------------

async function renderPptx(deck: Deck): Promise<{ path: string; imageWarnings: string[] }> {
  const theme = themeOf(deck.theme);
  const imageWarnings: string[] = [];
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "WIDE16x9", width: 13.33, height: 7.5 });
  pptx.layout = "WIDE16x9";
  pptx.author = deck.author ?? "Hertz";
  pptx.title = deck.title;

  // Titulní slid
  const cover = pptx.addSlide();
  cover.background = { color: theme.bg };
  cover.addText(deck.title, {
    x: 0.8, y: 2.0, w: 11.7, h: 2.2, fontSize: 44, bold: true, color: theme.fg, align: "center", valign: "middle",
  });
  if (deck.subtitle) {
    cover.addText(deck.subtitle, {
      x: 1.5, y: 4.2, w: 10.3, h: 1.2, fontSize: 24, color: theme.muted, align: "center", valign: "middle",
    });
  }
  cover.addShape("rect", { x: 5.9, y: 5.8, w: 1.5, h: 0.08, fill: { color: theme.accent } });

  // Obsahové slidy
  for (const slide of deck.slides) {
    const s = pptx.addSlide();
    s.background = { color: theme.bg };
    s.addText(slide.heading, {
      x: 0.7, y: 0.4, w: 11.9, h: 1.0, fontSize: 32, bold: true, color: theme.accent, valign: "middle",
    });
    s.addShape("rect", { x: 0.7, y: 1.45, w: 1.2, h: 0.06, fill: { color: theme.accent } });

    const hasImage = !!slide.imageUrl;
    const textW = hasImage ? 7.2 : 11.9;
    const blocks: Array<{ text: string; options?: Record<string, unknown> }> = [];
    if (slide.body) blocks.push({ text: slide.body, options: { fontSize: 20, color: theme.fg, paraSpaceAfter: 18 } });
    for (const b of slide.bullets ?? []) {
      blocks.push({ text: b, options: { fontSize: 20, color: theme.fg, bullet: { code: "2022" }, indent: 18, paraSpaceAfter: 10, breakLine: true } });
    }
    if (blocks.length === 0) blocks.push({ text: "", options: {} });
    s.addText(blocks, { x: 0.7, y: 1.9, w: textW, h: 4.8, valign: "top" });

    if (hasImage) {
      try {
        s.addImage({ path: slide.imageUrl!, x: 8.3, y: 1.9, w: 4.3, h: 4.8, sizing: { type: "contain", w: 4.3, h: 4.8 } });
      } catch {
        imageWarnings.push(`Obrázek u slidu „${slide.heading}“ se nepodařilo vložit (neplatná URL nebo nedostupný soubor).`);
      }
    }
    if (slide.notes) s.addNotes(slide.notes);
  }

  const out = pptxPath(deck.id);
  await pptx.writeFile({ fileName: out });
  return { path: out, imageWarnings };
}

// --- HTML ------------------------------------------------------------------

function renderHtml(deck: Deck): string {
  const theme = themeOf(deck.theme);
  const css = (c: string) => `#${c}`;
  const slidesHtml = deck.slides
    .map((slide, i) => {
      const bullets = (slide.bullets ?? []).map((b) => `<li>${escapeHtml(b)}</li>`).join("");
      const img = slide.imageUrl ? `<img class="slide-img" src="${escapeHtml(slide.imageUrl)}" alt="">` : "";
      return `<section class="slide" data-index="${i + 1}">
  <h2>${escapeHtml(slide.heading)}</h2>
  <div class="slide-body">
    <div class="slide-text">
      ${slide.body ? `<p>${escapeHtml(slide.body)}</p>` : ""}
      ${bullets ? `<ul>${bullets}</ul>` : ""}
    </div>
    ${img}
  </div>
</section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(deck.title)}</title>
<style>
  :root { --bg: ${css(theme.bg)}; --fg: ${css(theme.fg)}; --accent: ${css(theme.accent)}; --muted: ${css(theme.muted)}; --card: ${css(theme.card)}; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .slide { display: none; min-height: 100vh; padding: 8vh 8vw; }
  .slide.active { display: flex; flex-direction: column; justify-content: center; }
  .slide.cover { text-align: center; align-items: center; }
  .slide.cover h1 { font-size: clamp(2rem, 6vw, 4rem); margin: 0 0 1rem; }
  .slide.cover .rule { width: 96px; height: 6px; background: var(--accent); border-radius: 3px; margin: 1.5rem auto; }
  .slide.cover p.sub { color: var(--muted); font-size: 1.4rem; }
  h2 { font-size: clamp(1.6rem, 4vw, 2.6rem); color: var(--accent); margin: 0 0 0.4rem; }
  .slide-body { display: flex; gap: 3rem; align-items: flex-start; }
  .slide-text { flex: 1; font-size: 1.25rem; line-height: 1.6; }
  ul { padding-left: 1.4rem; } li { margin: 0.5rem 0; }
  .slide-img { max-width: 34%; border-radius: 12px; }
  .nav { position: fixed; bottom: 1.2rem; right: 1.6rem; color: var(--muted); font-size: 0.95rem; user-select: none; }
  .hint { position: fixed; bottom: 1.2rem; left: 1.6rem; color: var(--muted); font-size: 0.9rem; user-select: none; }
  @media print { .slide { display: flex; page-break-after: always; min-height: 90vh; } .nav, .hint { display: none; } }
</style>
</head>
<body>
<section class="slide cover active" data-index="0">
  <h1>${escapeHtml(deck.title)}</h1>
  <div class="rule"></div>
  ${deck.subtitle ? `<p class="sub">${escapeHtml(deck.subtitle)}</p>` : ""}
  ${deck.author ? `<p class="sub">${escapeHtml(deck.author)}</p>` : ""}
</section>
${slidesHtml}
<div class="hint">Šipky / kliknutí = další slid</div>
<div class="nav"><span id="cur">1</span> / ${deck.slides.length + 1}</div>
<script>
  const slides = Array.from(document.querySelectorAll(".slide"));
  let idx = 0;
  const cur = document.getElementById("cur");
  function show(i) {
    idx = (i + slides.length) % slides.length;
    slides.forEach((s, k) => s.classList.toggle("active", k === idx));
    cur.textContent = String(idx + 1);
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") show(idx + 1);
    if (e.key === "ArrowLeft" || e.key === "PageUp") show(idx - 1);
  });
  document.addEventListener("click", () => show(idx + 1));
</script>
</body>
</html>`;
}

async function regenerate(deck: Deck): Promise<{ pptx: string; html: string; warnings: string[] }> {
  const { path: pptxFile, imageWarnings } = await renderPptx(deck);
  const htmlFile = htmlPath(deck.id);
  await fs.writeFile(htmlFile, renderHtml(deck), "utf8");
  return { pptx: pptxFile, html: htmlFile, warnings: imageWarnings };
}

function resultText(deck: Deck, files: { pptx: string; html: string }, warnings: string[]): string {
  const lines = [
    `Prezentace „${deck.title}“ je hotová (${deck.slides.length} slidů + titulní).`,
    `ID: ${deck.id}`,
    `PPTX: ${files.pptx}`,
    `HTML: ${files.html}`,
    `Soubory předej uživateli — HTML otevře v prohlížeči (prezentace šipkami/klikáním), PPTX jde dál upravovat.`,
  ];
  for (const w of warnings) lines.push(`Upozornění: ${w}`);
  return lines.join("\n");
}

// --- MCP server -------------------------------------------------------------

const server = new McpServer({ name: "kuclab-hertz-presentation", version: "0.1.0" });

const themeSchema = z.enum(["light", "dark", "blue"]).optional().default("light").describe("Vzhled: light (světlý), dark (tmavý), blue (modrý)");

server.registerTool(
  "presentation_create",
  {
    description:
      "Vytvoří prezentaci o zadaném tématu: titulní slid + obsahové slidy (nadpis, odstavec, odrážky, volitelný obrázek). " +
      "Vygeneruje PPTX i samostatné HTML (prohlížečová prezentace). Vrátí ID a cesty k souborům — ty předej uživateli.",
    inputSchema: {
      title: z.string().min(1).max(200).describe("Název prezentace"),
      subtitle: z.string().max(300).optional().describe("Podtitul na titulní slid"),
      author: z.string().max(120).optional().describe("Autor na titulním slidu"),
      theme: themeSchema,
      slides: z.array(slideSchema).min(1).max(40).describe("Slidy prezentace (1–40)"),
    },
  },
  async ({ title, subtitle, author, theme, slides }) => {
    const deck: Deck = {
      id: crypto.randomUUID(),
      title,
      subtitle,
      author,
      theme,
      slides: slides as Slide[],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeDeck(deck);
    const files = await regenerate(deck);
    return { content: [{ type: "text", text: resultText(deck, files, files.warnings) }] };
  },
);

server.registerTool(
  "presentation_add_slide",
  {
    description:
      "Přidá slid do existující prezentace (na konec, nebo na danou pozici od 1) a znovu vygeneruje PPTX i HTML. ID prezentace získáš z presentation_create / presentation_list.",
    inputSchema: {
      presentationId: z.string().describe("ID prezentace"),
      slide: slideSchema.describe("Nový slid"),
      position: z.number().int().positive().optional().describe("Pozice od 1; bez ní se přidá na konec"),
    },
  },
  async ({ presentationId, slide, position }) => {
    const deck = await readDeck(presentationId);
    const at = position === undefined ? deck.slides.length : Math.min(Math.max(position - 1, 0), deck.slides.length);
    deck.slides.splice(at, 0, slide as Slide);
    deck.updatedAt = new Date().toISOString();
    await writeDeck(deck);
    const files = await regenerate(deck);
    return { content: [{ type: "text", text: `Slid „${(slide as Slide).heading}“ přidán na pozici ${at + 1}.\n${resultText(deck, files, files.warnings)}` }] };
  },
);

server.registerTool(
  "presentation_list",
  {
    description: "Vypíše existující prezentace (ID, název, počet slidů, datum vytvoření).",
    inputSchema: {},
  },
  async () => {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const entries = await fs.readdir(OUTPUT_DIR, { withFileTypes: true });
    const decks: Deck[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        decks.push(await readDeck(e.name));
      } catch {
        /* přeskoč neúplné adresáře */
      }
    }
    if (decks.length === 0) return { content: [{ type: "text", text: "Zatím žádná prezentace." }] };
    const text = decks
      .map((d) => `[${d.id}] „${d.title}“ — ${d.slides.length} slidů, vytvořeno ${d.createdAt.slice(0, 10)}`)
      .join("\n");
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "presentation_get",
  {
    description: "Vrátí osnovu prezentace: název a nadpisy všech slidů.",
    inputSchema: { presentationId: z.string().describe("ID prezentace") },
  },
  async ({ presentationId }) => {
    const deck = await readDeck(presentationId);
    const lines = [`„${deck.title}“ (${deck.slides.length} slidů):`];
    deck.slides.forEach((s, i) => lines.push(`${i + 1}. ${s.heading}`));
    lines.push(`\nPPTX: ${pptxPath(deck.id)}\nHTML: ${htmlPath(deck.id)}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.registerTool(
  "presentation_export",
  {
    description: "Vrátí cestu k souboru prezentace ve zvoleném formátu (pptx pro úpravy, html pro prohlížeč). Soubory se generují automaticky při vytvoření/úpravě.",
    inputSchema: {
      presentationId: z.string().describe("ID prezentace"),
      format: z.enum(["pptx", "html"]).describe("Formát exportu"),
    },
  },
  async ({ presentationId, format }) => {
    const deck = await readDeck(presentationId);
    const file = format === "pptx" ? pptxPath(deck.id) : htmlPath(deck.id);
    await fs.access(file).catch(() => {
      throw new Error(`Soubor ${file} neexistuje — prezentace je asi neúplná.`);
    });
    return { content: [{ type: "text", text: `Prezentace „${deck.title}“ (${format.toUpperCase()}):\n${file}\nSoubor předej uživateli.` }] };
  },
);

await fs.mkdir(OUTPUT_DIR, { recursive: true });
const transport = new StdioServerTransport();
await server.connect(transport);

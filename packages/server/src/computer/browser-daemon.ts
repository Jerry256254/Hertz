/**
 * Source of /opt/hertz/browser.mjs — the Playwright daemon copied into every
 * agent container at creation time. Runs INSIDE the container; reads one JSON
 * command per line on stdin ({id, action, params}), writes one JSON result per
 * line to stdout. One long-lived Chromium instance is shared across commands
 * so logins survive between tool calls.
 *
 * Kept as a string so the server ships it without extra build steps; written
 * out and `docker cp`'d by ComputerManager.ensureContainer.
 */
export const BROWSER_DAEMON_SOURCE = String.raw`
import { createRequire } from "node:module";
import readline from "node:readline";
import fs from "node:fs";

const require = createRequire(import.meta.url);
let pw;
for (const candidate of ["playwright", "/usr/lib/node_modules/playwright", "/ms-playwright-agent/node_modules/playwright"]) {
  try { pw = require(candidate); break; } catch {}
}
if (!pw) {
  process.stdout.write(JSON.stringify({ id: 0, ok: false, error: "playwright module not found in image" }) + "\n");
  process.exit(1);
}

const { chromium } = pw;
const headless = !process.env.DISPLAY; // with DISPLAY set, run headed on the visible desktop
const browser = await chromium.launch({ headless, args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "cs-CZ" });
const page = await context.newPage();

function selectorText(sel) {
  if (!sel || typeof sel !== "string") return sel ?? null;
  // "text=..." passthrough, otherwise treat as CSS unless it starts with xpath=
  return sel.startsWith("xpath=") ? sel.replace(/^xpath=/, "xpath=") : sel;
}

const actions = {
  async goto(p) {
    await page.goto(p.url, { waitUntil: p.waitUntil ?? "domcontentloaded", timeout: p.timeoutMs ?? 45000 });
    return { url: page.url(), title: await page.title() };
  },
  async click(p) {
    if (p.text) await page.getByText(p.text, { exact: p.exact ?? false }).first().click({ timeout: p.timeoutMs ?? 15000 });
    else await page.locator(selectorText(p.selector)).first().click({ timeout: p.timeoutMs ?? 15000 });
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    return { url: page.url() };
  },
  async type(p) {
    const loc = page.locator(selectorText(p.selector)).first();
    await loc.fill("", { timeout: p.timeoutMs ?? 15000 }).catch(async () => { await loc.click(); });
    await loc.type(String(p.text ?? ""), { delay: p.delayMs ?? 20 });
    return { ok: true };
  },
  async press(p) {
    await page.keyboard.press(String(p.key ?? "Enter"));
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    return { url: page.url() };
  },
  async snapshot() {
    const title = await page.title();
    const text = await page.evaluate(() => document.body?.innerText.slice(0, 12000) ?? "");
    return { url: page.url(), title, text };
  },
  async screenshot(p) {
    if (!p.path) throw new Error("screenshot requires params.path");
    await page.screenshot({ path: p.path, fullPage: !!p.fullPage });
    return { path: p.path, url: page.url() };
  },
  async eval(p) {
    return { value: await page.evaluate(p.expression) };
  },
  async close() {
    await browser.close();
    process.exit(0);
  },
};

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const run = actions[msg.action];
  if (!run) {
    process.stdout.write(JSON.stringify({ id: msg.id, ok: false, error: 'unknown action "' + msg.action + '"' }) + "\n");
    return;
  }
  Promise.resolve()
    .then(() => run(msg.params ?? {}))
    .then((data) => process.stdout.write(JSON.stringify({ id: msg.id, ok: true, data }) + "\n"))
    .catch((err) => process.stdout.write(JSON.stringify({ id: msg.id, ok: false, error: String(err && err.message || err).slice(0, 500) }) + "\n"));
});
`;

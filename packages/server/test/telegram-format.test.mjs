import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chunkTelegramHtml,
  markdownToTelegramHtml,
  stripTelegramHtml,
} from "../dist/channels/telegram-format.js";

describe("markdownToTelegramHtml", () => {
  it("converts bold, italic, strike and inline code", () => {
    const html = markdownToTelegramHtml("**bold** *italic* ~~gone~~ `code`");
    assert.equal(html, "<b>bold</b> <i>italic</i> <s>gone</s> <code>code</code>");
  });

  it("keeps snake_case words intact", () => {
    const html = markdownToTelegramHtml("use my_variable_name here");
    assert.equal(html, "use my_variable_name here");
  });

  it("converts headings, bullets, ordered lists and quotes", () => {
    const html = markdownToTelegramHtml("## Title\n\n- one\n- two\n\n1. first\n\n> quoted");
    assert.ok(html.includes("<b>Title</b>"), html);
    assert.ok(html.includes("• one"), html);
    assert.ok(html.includes("1. first"), html);
    assert.ok(html.includes("<blockquote>quoted</blockquote>"), html);
  });

  it("converts fenced code to pre blocks and drops the language hint", () => {
    const html = markdownToTelegramHtml("```ts\nconst a = 1 < 2;\n```");
    assert.equal(html, "<pre><code>const a = 1 &lt; 2;</code></pre>");
  });

  it("escapes raw HTML so Telegram never chokes on it", () => {
    const html = markdownToTelegramHtml("a <b> b & c > d");
    assert.equal(html, "a &lt;b&gt; b &amp; c &gt; d");
  });

  it("does not format markdown inside code spans", () => {
    const html = markdownToTelegramHtml("run `**not-bold**` now");
    assert.ok(html.includes("<code>**not-bold**</code>"), html);
    assert.ok(!html.includes("<b>"), html);
  });

  it("converts safe links and drops dangerous ones to text", () => {
    const html = markdownToTelegramHtml("[docs](https://example.com/a?b=1&c=2) [x](javascript:alert(1))");
    assert.ok(html.includes('<a href="https://example.com/a?b=1&amp;c=2">docs</a>'), html);
    assert.ok(!html.includes("javascript:"), html);
  });

  it("emits only tags Telegram HTML mode supports", () => {
    const md = "# H\n\nText **b** *i* ~~s~~ `c` [l](https://x.y)\n\n- a\n1. b\n> q\n\n```\ncode\n```\n\n---\n\n![alt](https://x.y/i.png)";
    const html = markdownToTelegramHtml(md);
    const tags = [...html.matchAll(/<\/?([a-z]+)[\s>]/g)].map((m) => m[1]);
    const allowed = new Set(["b", "i", "s", "code", "pre", "blockquote", "a"]);
    for (const tag of tags) assert.ok(allowed.has(tag), `forbidden tag <${tag}> in: ${html}`);
    assert.ok(!html.includes("---"), html);
  });
});

describe("stripTelegramHtml", () => {
  it("falls back to readable plain text", () => {
    assert.equal(stripTelegramHtml("<b>Hi</b> <code>a&lt;b</code>"), "Hi a<b");
    assert.ok(stripTelegramHtml('<a href="https://x.y">docs</a>').includes("https://x.y"));
  });
});

describe("chunkTelegramHtml", () => {
  it("keeps short messages whole", () => {
    assert.deepEqual(chunkTelegramHtml("<b>hi</b>", 4096), ["<b>hi</b>"]);
  });

  it("splits long messages under the limit without losing text", () => {
    const paras = Array.from({ length: 40 }, (_, i) => `paragraph **${i}** with <angle> & entity`);
    const html = markdownToTelegramHtml(paras.join("\n\n"));
    const chunks = chunkTelegramHtml(html, 200);
    assert.ok(chunks.length > 1);
    for (const c of chunks) assert.ok(c.length <= 200, `chunk too long: ${c.length}`);
    const joined = chunks.join("\n\n").replace(/\s+/g, " ");
    assert.equal(joined, html.replace(/\s+/g, " "));
  });

  it("never tears an HTML entity across chunks", () => {
    const html = "<b>" + "x".repeat(90) + "&amp;" + "y".repeat(90) + "</b>";
    for (const chunk of chunkTelegramHtml(html, 100)) {
      const dangling = /&[^;\s]*$/.test(chunk.replace(/&(?:amp|lt|gt|quot);/g, ""));
      assert.ok(!dangling, `torn entity in: ${chunk}`);
    }
  });
});

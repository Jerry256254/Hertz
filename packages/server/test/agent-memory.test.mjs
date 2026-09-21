import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  tokenize,
  keywordsFor,
  keywordOverlap,
  rankByRelevance,
  scoreByRelevance,
  fuseRankings,
  isNearDuplicate,
} from "../dist/memory/tokenize.js";
import {
  buildCanvasMermaid,
  escapeMermaidLabel,
  newNodeId,
  stepLabelFor,
} from "../dist/memory/canvas.js";
import {
  buildAtomExtractionPrompt,
  buildPersonaPrompt,
  buildScenarioClusteringPrompt,
  extractJsonObject,
  parseAtomsResponse,
  parsePersonaResponse,
  parseScenariosResponse,
  slugify,
} from "../dist/memory/extraction.js";
import { recordToolStep, readRef, loadCanvas, readSteps } from "../dist/memory/short-term.js";
import { renderMemoryBlock } from "../dist/memory/recall.js";
import { VectorMemoryStore, getVectorStore } from "../dist/memory/vector-store.js";
import { agentMemoryDir, agentSkillsDir, migrateAgentHome } from "../dist/paths.js";

describe("memory tokenization", () => {
  it("tokenizes Czech + English words, lowercased, min length", () => {
    assert.deepEqual(tokenize("Deploy skript žije v /scripts/nasazení!"), [
      "deploy",
      "skript",
      "žije",
      "scripts",
      "nasazení",
    ]);
    assert.deepEqual(tokenize("a an the hi ok"), ["the"]);
  });

  it("builds deduplicated keyword strings", () => {
    assert.equal(keywordsFor("Deploy script deploy SCRIPT lives here"), "deploy,script,lives,here");
  });

  it("measures keyword overlap as Jaccard similarity", () => {
    assert.equal(keywordOverlap(null, "anything"), 0);
    assert.equal(keywordOverlap("", "anything"), 0);
    const overlap = keywordOverlap("deploy,script,server", "the deploy script failed");
    assert.ok(overlap > 0 && overlap <= 1);
    assert.equal(keywordOverlap("deploy,script", "nothing matches here"), 0);
  });

  it("detects near-duplicate atoms", () => {
    assert.ok(isNearDuplicate("the deploy script lives at scripts/deploy.sh", "deploy,script,lives,scripts"));
    assert.ok(!isNearDuplicate("the user likes friday reports", "deploy,script,lives,scripts"));
  });
});

describe("memory ranking", () => {
  const day = 86_400_000;
  const now = Date.now();
  const items = [
    { id: "old-important", importance: 5, keywords: "unrelated,keywords,here", createdAt: new Date(now - 60 * day) },
    { id: "fresh-relevant", importance: 2, keywords: "deploy,script,server", createdAt: new Date(now - 1 * day) },
    { id: "fresh-noise", importance: 1, keywords: "weather,sunny,today", createdAt: new Date(now - 1 * day) },
  ];

  it("prefers keyword-relevant items over merely important ones", () => {
    // Top-1 by score must be the relevant item even though another is more important.
    const top1 = rankByRelevance(items, "the deploy script on the server broke", 1, now);
    assert.deepEqual(top1.map((i) => i.id), ["fresh-relevant"]);
    // Top-2 keeps both valuable items and drops the noise (output is oldest-first).
    const top2 = rankByRelevance(items, "the deploy script on the server broke", 2, now);
    assert.deepEqual(top2.map((i) => i.id).sort(), ["fresh-relevant", "old-important"]);
  });

  it("respects the limit and returns oldest-first for stable narratives", () => {
    const ranked = rankByRelevance(items, "", 2, now);
    assert.equal(ranked.length, 2);
    assert.ok(ranked[0].createdAt.getTime() <= ranked[1].createdAt.getTime());
  });

  it("handles empty input", () => {
    assert.deepEqual(rankByRelevance([], "query", 5), []);
    assert.deepEqual(rankByRelevance(items, "query", 0), []);
  });

  it("scoreByRelevance best-first matches rankByRelevance selection", () => {
    const scored = scoreByRelevance(items, "the deploy script on the server broke", now);
    assert.equal(scored[0].item.id, "fresh-relevant");
    assert.ok(scored[0].score >= scored[1].score && scored[1].score >= scored[2].score);
  });
});

describe("rank fusion (RRF)", () => {
  it("ranks an item first in both rankings at the top", () => {
    assert.deepEqual(
      fuseRankings(["a", "b", "c"], [["a", "b", "c"], ["a", "c", "b"]], 3),
      ["a", "b", "c"],
    );
  });

  it("preserves a single ranking order", () => {
    assert.deepEqual(fuseRankings(["a", "b"], [["b", "a"]], 2), ["b", "a"]);
  });

  it("keeps ids missing from every ranking at score zero, input order", () => {
    assert.deepEqual(fuseRankings(["a", "x"], [["a"]], 2), ["a", "x"]);
  });

  it("respects the limit", () => {
    assert.deepEqual(fuseRankings(["a", "b", "c"], [["a", "b", "c"]], 2), ["a", "b"]);
    assert.deepEqual(fuseRankings(["a", "b"], [["a", "b"]], 0), []);
  });
});

describe("memory canvas", () => {
  it("generates unique node ids", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newNodeId()));
    assert.equal(ids.size, 100);
    for (const id of ids) assert.match(id, /^n[0-9a-f]{6}$/);
  });

  it("escapes mermaid-breaking characters", () => {
    assert.equal(escapeMermaidLabel('a"b#c<d>e`f{g}h(i)j[k]l'), "abcdefghijkl");
    assert.ok(escapeMermaidLabel("x".repeat(200)).length <= 80);
  });

  it("builds a linked mermaid graph with ref annotations", () => {
    const mmd = buildCanvasMermaid("deploy session", [
      { nodeId: "n111111", seq: 1, tool: "shell_exec", label: "ls → ok", at: new Date().toISOString() },
      { nodeId: "n222222", seq: 2, tool: "web_fetch", label: "docs → big page", resultRef: "n222222", at: new Date().toISOString() },
      { nodeId: "n333333", seq: 3, tool: "shell_exec", label: "boom", isError: true, at: new Date().toISOString() },
    ]);
    assert.match(mmd, /^graph LR/m);
    assert.match(mmd, /n111111 --> n222222/);
    assert.match(mmd, /n222222 --> n333333/);
    assert.match(mmd, /ref: n222222/);
    assert.match(mmd, /\(chyba\)/);
  });

  it("renders an empty canvas without crashing", () => {
    assert.match(buildCanvasMermaid("empty", []), /Session started/);
  });

  it("derives step labels from tool input", () => {
    assert.match(stepLabelFor("read_file", { path: "a/b/c.ts" }, "file contents here"), /a\/b\/c\.ts/);
    assert.match(stepLabelFor("shell_exec", { command: "ls" }, "ok"), /ls/);
    assert.equal(typeof stepLabelFor("weird", null, ""), "string");
  });
});

describe("memory extraction prompts + parsers", () => {
  it("atom prompt carries transcript, known atoms, and the atom budget", () => {
    const prompt = buildAtomExtractionPrompt("User: deploy on fridays", 7, ["already known"]);
    assert.match(prompt, /deploy on fridays/);
    assert.match(prompt, /already known/);
    assert.match(prompt, /at most 7 atoms/);
    assert.match(prompt, /STRICT JSON/);
  });

  it("clustering prompt carries atoms and existing scenarios", () => {
    const prompt = buildScenarioClusteringPrompt(
      [{ index: 1, text: "deploy fridays" }],
      [{ slug: "deploys", title: "Deploys" }],
    );
    assert.match(prompt, /deploy fridays/);
    assert.match(prompt, /deploys/);
  });

  it("persona prompt carries scenarios, facts, and the previous persona", () => {
    const prompt = buildPersonaPrompt([{ title: "T", summary: "S" }], ["fact one"], "old persona");
    assert.match(prompt, /old persona/);
    assert.match(prompt, /fact one/);
  });

  it("extracts JSON from chatty model output", () => {
    assert.deepEqual(extractJsonObject('Sure! {"atoms":[]} done'), { atoms: [] });
    assert.equal(extractJsonObject("no json here"), undefined);
    assert.equal(extractJsonObject("{broken"), undefined);
  });

  it("parses atoms defensively", () => {
    const atoms = parseAtomsResponse('{"atoms":[{"text":"  Deploy fridays  ","importance":9},{"text":"","importance":2},{"nope":1}]}', 10);
    assert.deepEqual(atoms, [{ text: "Deploy fridays", importance: 5 }]);
    assert.deepEqual(parseAtomsResponse("garbage", 10), []);
    assert.deepEqual(parseAtomsResponse('{"atoms":"nope"}', 10), []);
  });

  it("parses scenarios with slug validation and index filtering", () => {
    const out = parseScenariosResponse(
      '{"scenarios":[{"slug":"Friday Reports!","title":"T","summary":"S","atomIndexes":[1,2,99,"x"]}]}',
      2,
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].slug, "friday-reports");
    assert.deepEqual(out[0].atomIndexes, [1, 2]);
    assert.deepEqual(parseScenariosResponse('{"scenarios":[{"slug":"!!!","title":"T","summary":"S","atomIndexes":[1]}]}', 5), []);
  });

  it("slugifies diacritics and rejects garbage", () => {
    assert.equal(slugify("Páteční Reporty 2024"), "patecni-reporty-2024");
    assert.equal(slugify("!!!"), "");
  });

  it("parses persona defensively", () => {
    assert.equal(parsePersonaResponse('{"persona":"  I serve Ana.  "}'), "I serve Ana.");
    assert.equal(parsePersonaResponse("nope"), "");
    assert.equal(parsePersonaResponse('{"persona":""}'), "");
  });
});

describe("memory block rendering", () => {
  it("renders progressive-disclosure layers and skips empty ones", () => {
    const block = renderMemoryBlock({
      persona: "I serve Ana.",
      scenarios: [{ id: "s1", slug: "deploys", title: "Deploys", summary: "Ship on fridays." }],
      atoms: [{ id: "a1", text: "Deploy script at scripts/deploy.sh" }],
      canvas: "graph LR\n    start --> n1",
    });
    assert.match(block, /L3 persona/);
    assert.match(block, /L2 scenarios/);
    assert.match(block, /L1 facts/);
    assert.match(block, /task canvas/);
    assert.match(block, /read_memory_ref/);
    assert.equal(renderMemoryBlock({ persona: "", scenarios: [], atoms: [], canvas: "" }), "");
  });
});

describe("short-term offload + canvas", () => {
  async function makePaths() {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-memory-"));
    return { dataDir, paths: { dataDir, projectsDir: path.join(dataDir, "projects") } };
  }

  it("keeps small tool results inline but still records the step", async () => {
    const { dataDir, paths } = await makePaths();
    const res = await recordToolStep({
      paths: paths,
      projectId: "proj-1",
      agentId: "agent-1",
      sessionId: "sess-1",
      tool: "read_file",
      input: { path: "x" },
      summary: "small output",
    });
    assert.equal(res.offloaded, false);
    assert.equal(res.summary, "small output");
    const steps = await readSteps(paths, "proj-1", "agent-1", "sess-1");
    assert.equal(steps.length, 1);
    assert.equal(steps[0].tool, "read_file");
    assert.match(await loadCanvas(paths, "proj-1", "agent-1", "sess-1"), /read_file/);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("offloads heavy tool results and recovers them via node id", async () => {
    const { dataDir, paths } = await makePaths();
    const big = `line\n`.repeat(5000);
    const res = await recordToolStep({
      paths: paths,
      projectId: "proj-1",
      agentId: "agent-1",
      sessionId: "sess-1",
      tool: "shell_exec",
      input: { command: "cat huge.log" },
      summary: big,
    });
    assert.equal(res.offloaded, true);
    assert.match(res.summary, /Offloaded/);
    assert.match(res.summary, /read_memory_ref/);
    assert.match(res.summary, new RegExp(res.nodeId));
    assert.ok(res.summary.length < big.length);
    const recovered = await readRef(paths, "proj-1", "agent-1", res.nodeId, "sess-1");
    assert.ok(recovered && recovered.includes("line\nline"));
    assert.match(recovered, /shell_exec/);
    // Cross-session recovery: node id resolves without the session too.
    const recoveredAny = await readRef(paths, "proj-1", "agent-1", res.nodeId);
    assert.equal(recoveredAny, recovered);
    assert.equal(await readRef(paths, "proj-1", "agent-1", "n000000"), undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("never offloads errors or drill-down tools", async () => {
    const { dataDir, paths } = await makePaths();
    const big = "x".repeat(20000);
    const err = await recordToolStep({ paths, projectId: "p", agentId: "a", sessionId: "s", tool: "shell_exec", input: {}, summary: big, isError: true });
    assert.equal(err.offloaded, false);
    const drill = await recordToolStep({ paths, projectId: "p", agentId: "a", sessionId: "s", tool: "read_memory_ref", input: {}, summary: big });
    assert.equal(drill.offloaded, false);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
});

describe("agent home migration", () => {
  it("adopts a pre-pivot mind (agents/<id>/) into the employee home", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-home-"));
    const paths = { dataDir, projectsDir: path.join(dataDir, "projects") };
    await fs.mkdir(path.join(dataDir, "agents", "a1", "memory", "scenarios"), { recursive: true });
    await fs.mkdir(path.join(dataDir, "agents", "a1", "skills", "s1"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "agents", "a1", "memory", "persona.md"), "I am A1.", "utf8");
    await fs.writeFile(path.join(dataDir, "agents", "a1", "soul.md"), "# Soul\nlegacy words", "utf8");
    await fs.writeFile(path.join(dataDir, "agents", "a1", "skills", "s1", "SKILL.md"), "steps", "utf8");

    await migrateAgentHome(paths, "proj-1", "a1");

    assert.equal(await fs.readFile(path.join(agentMemoryDir(paths, "proj-1", "a1"), "persona.md"), "utf8"), "I am A1.");
    assert.equal(await fs.readFile(path.join(agentMemoryDir(paths, "proj-1", "a1"), "soul.md"), "utf8"), "# Soul\nlegacy words");
    assert.equal(await fs.readFile(path.join(agentSkillsDir(paths, "proj-1", "a1"), "s1", "SKILL.md"), "utf8"), "steps");
    // Old shell is gone; second run is a no-op that never overwrites.
    await fs.writeFile(path.join(agentMemoryDir(paths, "proj-1", "a1"), "persona.md"), "edited", "utf8");
    await migrateAgentHome(paths, "proj-1", "a1");
    assert.equal(await fs.readFile(path.join(agentMemoryDir(paths, "proj-1", "a1"), "persona.md"), "utf8"), "edited");
    await fs.rm(dataDir, { recursive: true, force: true });
  });
});

describe("vector memory store", () => {
  it("round-trips when sqlite-vec loads, degrades silently when it does not", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-vec-"));
    const store = new VectorMemoryStore(path.join(dataDir, "v.db"));
    const init = store.init(4);
    if (!init.ok) {
      // Degraded contract: every operation is a silent no-op.
      assert.equal(store.degraded, true);
      assert.equal(store.upsertAtom("a", "agent", 2, [1, 2, 3, 4]), false);
      assert.deepEqual(store.search([1, 2, 3, 4], 5), []);
      assert.deepEqual([...store.knownAtomIds("agent")], []);
      store.removeAtom("a");
      store.removeAgent("agent");
    } else {
      assert.equal(store.upsertAtom("a1", "agent", 2, [1, 0, 0, 0]), true);
      assert.equal(store.upsertAtom("a2", "agent", 2, [0, 1, 0, 0]), true);
      const hits = store.search([1, 0, 0, 0], 5);
      assert.equal(hits[0].atomId, "a1");
      assert.ok(hits[0].score >= (hits[1]?.score ?? 0));
      assert.deepEqual([...store.knownAtomIds("agent")].sort(), ["a1", "a2"]);
      store.removeAtom("a1");
      assert.deepEqual([...store.knownAtomIds("agent")], ["a2"]);
      store.removeAgent("agent");
      assert.deepEqual([...store.knownAtomIds("agent")], []);
      const re = store.init(8);
      assert.equal(re.ok, true);
      assert.equal(re.needsReindex, true);
    }
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("shares one store per file", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-vec-"));
    const paths = { dataDir };
    assert.equal(getVectorStore(paths, "v.db"), getVectorStore(paths, "v.db"));
    getVectorStore(paths, "v.db").close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
});

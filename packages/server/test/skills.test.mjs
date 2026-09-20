import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SKILLS, ensureDefaultSkills } from "../dist/skills/default-skills.js";
import {
  checkedSkillName,
  deleteSkillFile,
  readSkillFile,
  skillsIndexFor,
  writeSkillFile,
} from "../dist/tools/skill-tools.js";

const PROJECT = "proj-1";
const AGENT = "agent-1";

let tmp;
let paths;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-skills-"));
  paths = { dataDir: tmp, projectsDir: path.join(tmp, "projects") };
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("default skills", () => {
  it("ships the core procedures (debugging, verification, research, skills-vs-memory)", () => {
    const names = DEFAULT_SKILLS.map((s) => s.name).sort();
    assert.deepEqual(names, ["debugging", "skills-over-memory", "verify-before-done", "web-research"]);
    for (const s of DEFAULT_SKILLS) {
      assert.ok(s.description.length > 10, s.name);
      assert.ok(s.instructions.includes("##"), s.name);
      assert.match(s.name, /^[a-z0-9][a-z0-9-_]{1,47}$/);
    }
  });

  it("seeds missing defaults and reports what was created", async () => {
    const created = await ensureDefaultSkills(paths, PROJECT, AGENT);
    assert.deepEqual(created.sort(), ["debugging", "skills-over-memory", "verify-before-done", "web-research"]);
    const index = await skillsIndexFor(paths, PROJECT, AGENT);
    assert.equal(index.length, 4);
  });

  it("never overwrites agent/user edits on reseed", async () => {
    await ensureDefaultSkills(paths, PROJECT, AGENT);
    await writeSkillFile(paths, PROJECT, AGENT, "debugging", {
      description: "mine now",
      instructions: "my steps",
    });
    const created = await ensureDefaultSkills(paths, PROJECT, AGENT);
    assert.deepEqual(created, []);
    const file = await readSkillFile(paths, PROJECT, AGENT, "debugging");
    assert.equal(file.body, "my steps");
    assert.equal(file.isDefault, false);
  });

  it("marks freshly seeded skills as defaults", async () => {
    await ensureDefaultSkills(paths, PROJECT, AGENT);
    const file = await readSkillFile(paths, PROJECT, AGENT, "debugging");
    assert.equal(file.isDefault, true);
    assert.ok(file.body.length > 100);
  });
});

describe("skill file access", () => {
  it("round-trips write → read → index → delete", async () => {
    await writeSkillFile(paths, PROJECT, AGENT, "deploy-hertz", {
      description: "How to deploy",
      instructions: "1. Run it\n2. Check it",
      script: "#!/bin/bash\necho hi\n",
    });
    const file = await readSkillFile(paths, PROJECT, AGENT, "deploy-hertz");
    assert.equal(file.description, "How to deploy");
    assert.equal(file.body, "1. Run it\n2. Check it");
    assert.equal(file.script, "#!/bin/bash\necho hi\n");
    const index = await skillsIndexFor(paths, PROJECT, AGENT);
    assert.deepEqual(index, [{ name: "deploy-hertz", description: "How to deploy" }]);
    await deleteSkillFile(paths, PROJECT, AGENT, "deploy-hertz");
    assert.equal(await readSkillFile(paths, PROJECT, AGENT, "deploy-hertz"), null);
    assert.deepEqual(await skillsIndexFor(paths, PROJECT, AGENT), []);
  });

  it("returns null for missing skills and empty index for missing dirs", async () => {
    assert.equal(await readSkillFile(paths, PROJECT, AGENT, "nope"), null);
    assert.deepEqual(await skillsIndexFor(paths, PROJECT, "ghost"), []);
  });

  it("sanitizes traversal to a safe slug and rejects invalid names", () => {
    assert.equal(checkedSkillName("../evil"), "evil");
    assert.equal(checkedSkillName("a/../../ok"), "ok");
    assert.throws(() => checkedSkillName("UPPER"), /Skill name/);
    assert.throws(() => checkedSkillName("a"), /Skill name/);
    assert.equal(checkedSkillName("ok-name_2"), "ok-name_2");
  });

  it("keeps traversal writes inside the skills root", async () => {
    await writeSkillFile(paths, PROJECT, AGENT, "../../evil", { description: "x", instructions: "y" });
    const index = await skillsIndexFor(paths, PROJECT, AGENT);
    assert.deepEqual(index, [{ name: "evil", description: "x" }]);
    await assert.rejects(fs.stat(path.join(paths.projectsDir, "evil")));
  });
});

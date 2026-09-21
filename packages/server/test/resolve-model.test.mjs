import test from "node:test";
import assert from "node:assert/strict";
import { clearModelListCache, resolveEffectiveModel } from "../dist/runtime/resolve-model.js";

let n = 0;

function makeFixture({ scanned, scanThrows = false, defaultModel = null, storedModel = "stale-model" }) {
  n += 1;
  const providerConfigId = `pc-${n}`;
  let persisted = null;
  const agent = { id: "agent-1", providerConfigId, model: storedModel };
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => [{ defaultModel }] }) }),
    }),
    update: () => ({
      set: (vals) => ({
        where: () => {
          persisted = vals;
          return Promise.resolve();
        },
      }),
    }),
  };
  const providers = {
    getAdapter: async () => ({
      listModels: async () => {
        if (scanThrows) throw new Error("scan failed");
        return scanned.map((id) => ({ id }));
      },
    }),
  };
  return {
    deps: { db, providers },
    agent,
    get persisted() {
      return persisted;
    },
  };
}

test("keeps the stored model when the provider still offers it", async () => {
  clearModelListCache();
  const f = makeFixture({ scanned: ["stale-model", "other"], storedModel: "stale-model" });
  const model = await resolveEffectiveModel(f.deps, f.agent);
  assert.equal(model, "stale-model");
  assert.equal(f.persisted, null);
});

test("falls back to the provider default and persists the correction", async () => {
  clearModelListCache();
  const f = makeFixture({
    scanned: ["good-default", "other"],
    storedModel: "stale-model",
    defaultModel: "good-default",
  });
  const model = await resolveEffectiveModel(f.deps, f.agent);
  assert.equal(model, "good-default");
  assert.deepEqual(f.persisted, { model: "good-default" });
  assert.equal(f.agent.model, "good-default");
});

test("falls back to the first scanned model when the default is not offered", async () => {
  clearModelListCache();
  const f = makeFixture({
    scanned: ["first", "second"],
    storedModel: "stale-model",
    defaultModel: "retired-default",
  });
  const model = await resolveEffectiveModel(f.deps, f.agent);
  assert.equal(model, "first");
  assert.deepEqual(f.persisted, { model: "first" });
});

test("keeps the stored model when the scan fails", async () => {
  clearModelListCache();
  const f = makeFixture({ scanned: [], scanThrows: true, storedModel: "stale-model" });
  const model = await resolveEffectiveModel(f.deps, f.agent);
  assert.equal(model, "stale-model");
  assert.equal(f.persisted, null);
});

test("keeps the stored model when the scan returns nothing", async () => {
  clearModelListCache();
  const f = makeFixture({ scanned: [], storedModel: "stale-model" });
  const model = await resolveEffectiveModel(f.deps, f.agent);
  assert.equal(model, "stale-model");
  assert.equal(f.persisted, null);
});

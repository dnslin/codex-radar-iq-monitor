import assert from "node:assert/strict";
import test from "node:test";
import { hasLowCoverage, runtimeOptions, selectModels, valueDelta } from "../src/view.js";

function models() {
  return [
    { id: "codex:deepseek", modelId: "deepseek", label: "DeepSeek V4 Pro", runtime: "codex", runtimeLabel: "Codex", iq: 110 },
    { id: "dsh:deepseek", modelId: "deepseek", label: "DeepSeek V4 Pro", runtime: "dsh", runtimeLabel: "DSH", iq: 120 },
    { id: "future", modelId: "future-model", label: "Future Model", runtime: "new-tool", runtimeLabel: "New Tool", iq: null },
    { id: "zero", modelId: "gpt-6", label: "GPT-6", runtime: "codex", runtimeLabel: "Codex", iq: 0 },
    { id: "tie", modelId: "gpt-5", label: "GPT-5", runtime: "codex", runtimeLabel: "Codex", iq: 110 },
  ];
}

test("default list includes newly discovered models and sorts sampled IQ first", () => {
  const input = models();
  const originalOrder = input.map(({ id }) => id);
  assert.deepEqual(selectModels(input).map(({ id }) => id), [
    "dsh:deepseek", "codex:deepseek", "tie", "zero", "future",
  ]);
  assert.deepEqual(input.map(({ id }) => id), originalOrder, "snapshot order must remain unchanged");
});

test("model search matches words across names and runtime labels without merging equivalent models", () => {
  assert.deepEqual(selectModels(models(), { query: "  DEEPSEEK  " }).map(({ id }) => id), [
    "dsh:deepseek", "codex:deepseek",
  ]);
  assert.deepEqual(selectModels(models(), { query: "codex PRO" }).map(({ id }) => id), ["codex:deepseek"]);
  assert.deepEqual(selectModels(models(), { query: "New Tool" }).map(({ id }) => id), ["future"]);
  assert.deepEqual(selectModels(models(), { query: "future-model" }).map(({ id }) => id), ["future"]);
});

test("runtime filter combines with search and returns an empty result when neither matches", () => {
  assert.deepEqual(selectModels(models(), { query: "deepseek", runtime: "dsh" }).map(({ id }) => id), ["dsh:deepseek"]);
  assert.deepEqual(selectModels(models(), { query: "deepseek", runtime: "new-tool" }), []);
  assert.deepEqual(selectModels(models(), { query: "nonexistent" }), []);
});

test("runtime options count all models and discover new tools", () => {
  assert.deepEqual(runtimeOptions(models()), [
    { value: "codex", label: "Codex", count: 3 },
    { value: "dsh", label: "DSH", count: 1 },
    { value: "new-tool", label: "New Tool", count: 1 },
  ]);
  assert.deepEqual(runtimeOptions([]), []);
});

test("site and name sorting preserve complete filtered results", () => {
  assert.deepEqual(selectModels(models(), { sort: "site", runtime: "codex" }).map(({ id }) => id), [
    "codex:deepseek", "zero", "tie",
  ]);
  assert.deepEqual(selectModels(models(), { sort: "name" }).map(({ id }) => id), [
    "codex:deepseek", "dsh:deepseek", "future", "tie", "zero",
  ]);
});

test("deltas distinguish unchanged scores, unavailable scores, and actual zero IQ", () => {
  assert.equal(valueDelta(110, 114), 4);
  assert.equal(valueDelta(110, 108), -2);
  assert.equal(valueDelta(110, 110), 0);
  assert.equal(valueDelta(0, 10), 10);
  assert.equal(valueDelta(null, 110), null);
  assert.equal(valueDelta(110, null), null);
  assert.equal(valueDelta(undefined, 110), null);
  assert.equal(valueDelta(NaN, 110), null);
});

test("coverage warnings follow the source site's 60 percent tested-task threshold", () => {
  assert.equal(hasLowCoverage(67, 112), true);
  assert.equal(hasLowCoverage(68, 112), false);
  assert.equal(hasLowCoverage(3, 5), false);
  assert.equal(hasLowCoverage(0, 112), true);
  assert.equal(hasLowCoverage(0, 0), false);
  assert.equal(hasLowCoverage(undefined, 112), false);
});

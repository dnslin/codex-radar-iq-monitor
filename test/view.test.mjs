import assert from "node:assert/strict";
import test from "node:test";
import { hasLowCoverage, modelProvider, providerGroups, runtimeOptions, selectModels, valueDelta } from "../src/view.js";

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

test("provider groups cover the current catalog in a stable order without changing scores or records", () => {
  const catalog = [
    "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5",
    "deepseek-v4-flash", "deepseek-v4-pro", "dsh-deepseek-v4-flash", "dsh-deepseek-v4-pro",
    "grok-4.6", "k3", "glm-5.3", "glm-5.3-flash", "dsh-deepseek-v4-flash-vision-exp",
    "gemini-3.7-flash", "hy4-preview", "claude-sonnet-5", "claude-opus-5",
  ].map((modelId, index) => ({ id: modelId, modelId, iq: 70 + index }));
  const original = structuredClone(catalog);
  const groups = providerGroups(selectModels(catalog));
  assert.deepEqual(groups.map(({ id, models: entries }) => [id, entries.length]), [
    ["openai", 5], ["deepseek", 5], ["anthropic", 2], ["google", 1],
    ["xai", 1], ["moonshot", 1], ["zhipu", 2], ["tencent", 1],
  ]);
  for (const group of groups) {
    assert.deepEqual(group.models.map(({ iq }) => iq), group.models.map(({ iq }) => iq).sort((a, b) => b - a));
    for (const model of group.models) assert.equal(model, catalog.find(({ id }) => id === model.id));
  }
  assert.deepEqual(catalog, original);
  assert.equal(groups.reduce((count, group) => count + group.models.length, 0), 18);
  assert.deepEqual(providerGroups([]), []);
});

test("provider classification follows model identity across runtimes", () => {
  assert.equal(modelProvider({ modelId: "deepseek-v4-pro", runtime: "codex" }).id, "deepseek");
  assert.equal(modelProvider({ modelId: "dsh-deepseek-v4-pro", runtime: "dsh-minimal" }).id, "deepseek");
  assert.equal(modelProvider({ modelId: "gpt-6-astra", runtime: "new-tool" }).id, "openai");
  assert.equal(modelProvider({ modelId: "CLAUDE-SONNET-5", runtime: "codex" }).id, "anthropic");
  assert.deepEqual(selectModels(models(), { provider: "deepseek" }).map(({ id }) => id), [
    "dsh:deepseek", "codex:deepseek",
  ]);
});

test("unknown models stay visible under Other and are not assigned by runtime or partial name matches", () => {
  const unknown = ["future-model", "not-gpt-6", "deepseeker-1", "claudette", "hype-1", "k30"]
    .map((modelId) => ({ id: modelId, modelId, label: "GPT experimental", runtime: "codex", iq: null }));
  assert.deepEqual(unknown.map((model) => modelProvider(model).id), Array(unknown.length).fill("other"));
  const groups = providerGroups([...unknown, ...models()]);
  assert.equal(groups.at(-1).id, "other");
  assert.deepEqual(groups.at(-1).models.map(({ id }) => id), [...unknown.map(({ id }) => id), "future"]);
  assert.deepEqual(selectModels(unknown, { provider: "other" }), unknown);
});

test("provider filters combine with runtime and multiword search, including company aliases", () => {
  assert.deepEqual(selectModels(models(), { provider: "deepseek", runtime: "codex", query: "深度求索 PRO" })
    .map(({ id }) => id), ["codex:deepseek"]);
  assert.deepEqual(selectModels(models(), { provider: "deepseek", runtime: "dsh", query: "OpenAI" }), []);
  assert.deepEqual(selectModels(models(), { query: "chatgpt" }).map(({ id }) => id), ["tie", "zero"]);
  assert.deepEqual(selectModels(models(), { query: "OPENAI codex", sort: "site" }).map(({ id }) => id), ["zero", "tie"]);
  for (const [modelId, query] of [
    ["claude-opus-5", "Anthropic"], ["gemini-3.7-flash", "谷歌"], ["k3", "月之暗面"],
    ["k3", "Moonshot"], ["glm-5.3", "智谱"], ["hy4-preview", "腾讯"], ["hy4-preview", "混元"],
  ]) {
    const model = { id: modelId, modelId, label: modelId, iq: 100 };
    assert.deepEqual(selectModels([model], { query }), [model], `${query} should find ${modelId}`);
  }
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

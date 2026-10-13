import assert from "node:assert/strict";
import test from "node:test";

import * as radar from "../src/radar.js";
import { nextThemeMode, normalizeThemeMode, resolveTheme } from "../src/theme.js";
import { bindingFixture, radarBenchFixture, summaryFixture } from "./fixtures/radar-bench.mjs";

const { buildSnapshot, compareSnapshots, fetchRadarSnapshot, formatChangeLabel, normalizeSettings } = radar;
const BINDING_URL = "https://codexradar.com/data/radar-bench-binding.json";

function jsonResponse(value) {
  return { ok: true, status: 200, json: async () => value };
}

function snapshotFixture(models = []) {
  const binding = bindingFixture();
  return {
    version: 3,
    benchmarkId: binding.benchmark,
    scoringMode: binding.score_version,
    taskSetHash: binding.task_set_sha256,
    taskCount: binding.total_tasks,
    models,
  };
}

function multipleEffortsFixture(count = 7) {
  const pairs = Array.from({ length: count }, (_, index) => ({ model: `future-model-${index}`, effort: "high" }));
  return {
    binding: bindingFixture({ model_efforts: pairs }),
    summaries: pairs.map((pair, index) => summaryFixture({ ...pair, score: index })),
  };
}

function stallUntilAborted(signal) {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException("aborted", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

test("buildSnapshot copies public Radar Bench scores without recomputing or rounding", () => {
  const { binding, summaries } = radarBenchFixture();
  const fetchedAt = "2026-10-13T06:00:00.000Z";
  const snapshot = buildSnapshot(binding, summaries, fetchedAt);
  const sol = snapshot.models.find((model) => model.id === "gpt-6.1-sol");
  assert.equal(snapshot.version, 3);
  assert.equal(snapshot.benchmarkId, binding.benchmark);
  assert.equal(snapshot.scoringMode, binding.score_version);
  assert.equal(snapshot.taskSetHash, binding.task_set_sha256);
  assert.equal(snapshot.taskCount, 64);
  assert.equal(snapshot.comboCount, 3);
  assert.equal(snapshot.sourceUpdatedAt, null);
  assert.equal(snapshot.fetchedAt, fetchedAt);
  assert.deepEqual(sol.efforts, [
    { effort: "medium", iq: 76.71583850931677, rawSamples: 50, sampledTaskCount: 48, scoreStatus: "provisional" },
    { effort: "high", iq: 75.25, rawSamples: 55, sampledTaskCount: 49, scoreStatus: "provisional" },
  ]);
  assert.equal(sol.iq, 76.71583850931677);
  assert.equal(sol.bestEffort, "medium");
  assert.equal(sol.rawSamples, 50);
  assert.equal(sol.sampledTaskCount, 48);
  assert.equal(Object.hasOwn(sol, "scoreSum"), false);
  assert.equal(Object.hasOwn(snapshot, "rollingWindow"), false);
});

test("buildSnapshot discovers unfamiliar catalog models and keeps unavailable scores null", () => {
  const { binding, summaries } = radarBenchFixture();
  const snapshot = buildSnapshot(binding, summaries);
  assert.deepEqual(snapshot.models.map((model) => model.id), ["gpt-6.1-sol", "future-model"]);
  assert.equal(snapshot.models[0].label, "GPT-6.1 Sol");
  assert.equal(snapshot.models[0].runtimeLabel, "Codex");
  const future = snapshot.models[1];
  assert.equal(future.label, "future-model");
  assert.equal(future.iq, null);
  assert.equal(future.bestEffort, null);
  assert.deepEqual(future.efforts, [
    { effort: "high", iq: null, rawSamples: null, sampledTaskCount: 0, scoreStatus: "missing_current_result" },
  ]);
  assert.equal(snapshot.models.some((model) => model.id === "gpt-5.6-terra"), false);
});

test("a true zero score remains distinct from an unavailable score", () => {
  const binding = bindingFixture({ model_efforts: [
    { model: "gpt-6.1-sol", effort: "medium" },
    { model: "gpt-6.1-sol", effort: "high" },
  ] });
  const summaries = [
    summaryFixture({ score: null, coverage: 0, graded_runs_count: null, score_status: "missing_current_result" }),
    summaryFixture({ effort: "high", score: 0, coverage: 1, graded_runs_count: 1 }),
  ];
  const sol = buildSnapshot(binding, summaries).models[0];
  assert.equal(sol.efforts[0].iq, null);
  assert.equal(sol.efforts[1].iq, 0);
  assert.equal(sol.iq, 0);
  assert.equal(sol.bestEffort, "high");
  assert.equal(sol.rawSamples, 1);
  assert.equal(sol.sampledTaskCount, 1);
});

test("equal best scores use the first effort in effort order and its own coverage/samples", () => {
  const binding = bindingFixture({ model_efforts: [
    { model: "gpt-6.1-sol", effort: "high" },
    { model: "gpt-6.1-sol", effort: "low" },
  ] });
  const summaries = [
    summaryFixture({ effort: "high", score: 100, graded_runs_count: 60, coverage: 54 }),
    summaryFixture({ effort: "low", score: 100, graded_runs_count: null, coverage: 40 }),
  ];
  const sol = buildSnapshot(binding, summaries).models[0];
  assert.deepEqual(sol.efforts.map((value) => value.effort), ["low", "high"]);
  assert.equal(sol.bestEffort, "low");
  assert.equal(sol.iq, 100);
  assert.equal(sol.rawSamples, null);
  assert.equal(sol.sampledTaskCount, 40);
});

test("future efforts remain sorted and catalog duplicates do not duplicate scores", () => {
  const efforts = ["extended", "high", "off", "minimal", "low", "high"];
  const binding = bindingFixture({ model_efforts: efforts.map((effort) => ({ model: "future-model", effort })) });
  const summaries = [...new Set(efforts)].map((effort) => summaryFixture({ model: "future-model", effort, score: 0 }));
  const snapshot = buildSnapshot(binding, summaries);
  assert.equal(snapshot.comboCount, 5);
  assert.deepEqual(snapshot.models[0].efforts.map((value) => value.effort), ["off", "minimal", "low", "high", "extended"]);
});

test("separate catalog identities retain independent scores for the same display name", () => {
  const binding = bindingFixture({ model_efforts: [
    { model: "claude-opus-5-5", effort: "high" },
    { model: "kiro-claude-opus-5.5", effort: "high" },
  ] });
  const summaries = [
    summaryFixture({ model: "claude-opus-5-5", effort: "high", score: 50 }),
    summaryFixture({ model: "kiro-claude-opus-5.5", effort: "high", score: 100 }),
  ];
  assert.deepEqual(buildSnapshot(binding, summaries).models.map((model) => [model.id, model.label, model.runtimeLabel, model.iq]), [
    ["claude-opus-5-5", "Claude Opus 5.5", "Codex", 50],
    ["kiro-claude-opus-5.5", "Claude Opus 5.5", "Codex", 100],
  ]);
});

test("an empty catalog does not invent monitored models", () => {
  const snapshot = buildSnapshot(bindingFixture({ model_efforts: [] }), []);
  assert.deepEqual(snapshot.models, []);
  assert.equal(snapshot.comboCount, 0);
});

test("missing summaries fail rather than producing a partial snapshot", () => {
  const { binding, summaries } = radarBenchFixture();
  assert.throws(() => buildSnapshot(binding, summaries.slice(1)), /gpt-6\.1-sol.*high|high.*gpt-6\.1-sol/);
});

for (const [field, value] of [
  ["benchmark", "another-benchmark"], ["task_set_sha256", "another-task-set"],
  ["model", "another-model"], ["effort", "ultra"], ["required_tasks", 63],
  ["score_version", "another-score-version"], ["score_max", 100],
]) {
  test(`buildSnapshot rejects a summary with mismatched ${field}`, () => {
    assert.throws(() => buildSnapshot(bindingFixture(), [summaryFixture({ [field]: value })]), /mismatch|does not match|missing|unexpected|invalid/i);
  });
}

for (const score of [-1, 150.01, "76.7", undefined, NaN, Infinity, {}]) {
  test(`buildSnapshot rejects invalid score ${String(score)}`, () => {
    assert.throws(() => buildSnapshot(bindingFixture(), [summaryFixture({ score })]), /score/i);
  });
}

for (const coverage of [-1, 65, 1.5, "48", null, undefined]) {
  test(`buildSnapshot rejects invalid task coverage ${String(coverage)}`, () => {
    assert.throws(() => buildSnapshot(bindingFixture(), [summaryFixture({ coverage })]), /coverage/i);
  });
}

for (const graded_runs_count of [-1, 1.5, "50", undefined, NaN, Infinity]) {
  test(`buildSnapshot rejects invalid graded run count ${String(graded_runs_count)}`, () => {
    assert.throws(() => buildSnapshot(bindingFixture(), [summaryFixture({ graded_runs_count })]), /graded_runs_count|graded.*count/i);
  });
}

test("score endpoints accept inclusive limits and preserve a null graded run count", () => {
  for (const score of [0, 150, null]) {
    const snapshot = buildSnapshot(bindingFixture(), [summaryFixture({
      score,
      coverage: score === null ? 0 : 64,
      score_status: score === null ? "missing_current_result" : "complete",
      graded_runs_count: null,
    })]);
    assert.equal(snapshot.models[0].efforts[0].iq, score);
    assert.equal(snapshot.models[0].efforts[0].rawSamples, null);
  }
});

test("canCompareSnapshots requires matching current snapshot metadata", () => {
  assert.equal(typeof radar.canCompareSnapshots, "function");
  const snapshot = snapshotFixture();
  assert.equal(radar.canCompareSnapshots(snapshot, structuredClone(snapshot)), true);
  assert.equal(radar.canCompareSnapshots(null, snapshot), false);
  assert.equal(radar.canCompareSnapshots(snapshot, null), false);
  assert.equal(radar.canCompareSnapshots({ models: [] }, { models: [] }), false);
  for (const [field, value] of [
    ["version", 2], ["benchmarkId", "another-benchmark"],
    ["scoringMode", "another-policy"], ["taskSetHash", "another-task-set"],
  ]) {
    assert.equal(radar.canCompareSnapshots(snapshot, { ...snapshot, [field]: value }), false, field);
    const missing = { ...snapshot };
    delete missing[field];
    assert.equal(radar.canCompareSnapshots(snapshot, missing), false, `missing ${field}`);
  }
});

test("incompatible metadata and legacy caches establish a new baseline without notifications", () => {
  const current = snapshotFixture([{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol", iq: 80, efforts: [{ effort: "high", iq: 80 }] }]);
  for (const previous of [
    null,
    { version: 2, benchmarkId: "deep-swe", models: [{ id: "gpt-6.1-sol", iq: 120, efforts: [{ effort: "high", iq: 120 }] }] },
    { ...current, benchmarkId: "another-benchmark" },
    { ...current, scoringMode: "another-policy" },
    { ...current, taskSetHash: "another-task-set" },
  ]) assert.deepEqual(compareSnapshots(previous, current), []);
});

test("compareSnapshots applies the threshold to efforts and never compares model totals", () => {
  const previous = snapshotFixture([{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol", iq: 125, efforts: [
    { effort: "low", iq: 115 }, { effort: "high", iq: 125 },
  ] }]);
  const current = snapshotFixture([{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol", iq: 123, efforts: [
    { effort: "low", iq: 118 }, { effort: "high", iq: 123 },
  ] }]);
  assert.deepEqual(compareSnapshots(previous, current, 2).map((change) => [change.key, change.scope, change.delta]), [
    ["gpt-6.1-sol@low", "effort", 3], ["gpt-6.1-sol@high", "effort", -2],
  ]);
});

test("new efforts notify once available, including true zero, without an initial alert flood", () => {
  const previous = snapshotFixture([{ id: "k3", label: "Kimi K3", runtimeLabel: "Kimi Code", iq: null, efforts: [{ effort: "max", iq: null }] }]);
  const current = snapshotFixture([
    { ...previous.models[0], iq: 0, efforts: [{ effort: "max", iq: 0 }] },
    { id: "future-model", label: "Future model", runtimeLabel: "Future tool", iq: 100, efforts: [{ effort: "high", iq: 100 }] },
    { id: "unsampled", label: "Unsampled", iq: null, efforts: [{ effort: "high", iq: null }] },
  ]);
  assert.deepEqual(compareSnapshots(null, current), []);
  const changes = compareSnapshots(previous, current, 20);
  assert.deepEqual(changes.map((change) => [change.key, change.kind]), [
    ["future-model@high", "available"], ["k3@max", "available"],
  ]);
  assert.equal(changes.find((change) => change.key === "k3@max").newIq, 0);
  assert.equal(changes.find((change) => change.key === "k3@max").runtimeLabel, "Kimi Code");
});

test("removed efforts and unavailable scores report unavailable rather than a fall to zero", () => {
  const previous = snapshotFixture([{ id: "old-model", label: "Old model", iq: 90, efforts: [{ effort: "high", iq: 90 }] }]);
  for (const current of [snapshotFixture([]), snapshotFixture([{ id: "old-model", label: "Old model", iq: null, efforts: [{ effort: "high", iq: null }] }])]) {
    const changes = compareSnapshots(previous, current);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].key, "old-model@high");
    assert.equal(changes[0].kind, "unavailable");
    assert.equal(changes[0].delta, null);
    assert.equal(changes[0].newIq, null);
  }
});

test("notifications distinguish runtime and describe the public Radar score", () => {
  const change = { modelLabel: "DeepSeek V4 Pro", runtimeLabel: "DSH", effort: "high", kind: "changed", newIq: 90, delta: 3 };
  assert.match(formatChangeLabel(change), /^DeepSeek V4 Pro · DSH high：90 (?:IQ|雷达分)（\+3）$/);
});

test("notification labels round public scores and deltas to one decimal without changing snapshot precision", () => {
  const change = { modelLabel: "GPT-6.1 Sol", runtimeLabel: "Codex", effort: "medium", kind: "changed", newIq: 76.71583850931677, delta: -1.63225188317696 };
  assert.equal(formatChangeLabel(change), "GPT-6.1 Sol · Codex medium：76.7 雷达分（-1.6）");
  assert.equal(formatChangeLabel({ ...change, kind: "available" }), "GPT-6.1 Sol · Codex medium：新增 76.7 雷达分");
});

test("fetchRadarSnapshot fetches the catalog before deduplicated public summaries", async () => {
  const { binding, summaries } = radarBenchFixture();
  const requested = [];
  const snapshot = await fetchRadarSnapshot(async (value, options) => {
    const url = new URL(value);
    requested.push(url.href);
    assert.equal(options.cache, "no-store");
    assert.equal(options.method ?? "GET", "GET");
    assert.equal(new Headers(options.headers).get("Accept"), "application/json");
    if (url.href === BINDING_URL) return jsonResponse(binding);
    assert.equal(requested[0], BINDING_URL);
    assert.equal(url.origin, "https://codexradar.com");
    assert.equal(url.pathname, "/api/radar-bench-score");
    assert.equal(url.searchParams.get("view"), "summary");
    assert.equal(new Headers(options.headers).get("X-Radar-Bench-Selection"), "user-selected-v1");
    const summary = summaries.find((entry) => entry.model === url.searchParams.get("model") && entry.effort === url.searchParams.get("effort"));
    assert.ok(summary, `unexpected summary request ${url.href}`);
    return jsonResponse(summary);
  });
  assert.equal(requested.length, 4);
  assert.equal(new Set(requested).size, 4);
  assert.equal(snapshot.benchmarkId, binding.benchmark);
});

test("fetchRadarSnapshot uses at most three concurrent summary requests", async () => {
  const { binding, summaries } = multipleEffortsFixture();
  let active = 0;
  let maximumActive = 0;
  const snapshot = await fetchRadarSnapshot(async (value) => {
    const url = new URL(value);
    if (url.href === BINDING_URL) return jsonResponse(binding);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return jsonResponse(summaries.find((summary) => summary.model === url.searchParams.get("model")));
  });
  assert.equal(maximumActive, 3);
  assert.equal(active, 0);
  assert.equal(snapshot.comboCount, 7);
});

test("catalog HTTP errors surface before any summary requests", async () => {
  const requested = [];
  await assert.rejects(() => fetchRadarSnapshot(async (url) => {
    requested.push(String(url));
    return { ok: false, status: 503 };
  }), /catalog.*HTTP 503/);
  assert.deepEqual(requested, [BINDING_URL]);
});

test("HTTP 429 fails with model/effort context and stops queued summary requests", async () => {
  const { binding, summaries } = multipleEffortsFixture();
  const requested = [];
  await assert.rejects(() => fetchRadarSnapshot(async (value) => {
    const url = new URL(value);
    if (url.href === BINDING_URL) return jsonResponse(binding);
    const model = url.searchParams.get("model");
    requested.push(model);
    if (model === "future-model-0") return { ok: false, status: 429 };
    await new Promise((resolve) => setTimeout(resolve, 5));
    return jsonResponse(summaries.find((summary) => summary.model === model));
  }), /future-model-0.*high.*HTTP 429/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(requested.length <= 3, `queued requests continued after failure: ${requested.join(", ")}`);
});

test("summary network failures preserve model/effort context", async () => {
  await assert.rejects(() => fetchRadarSnapshot(async (url) => {
    if (String(url) === BINDING_URL) return jsonResponse(bindingFixture());
    throw new Error("connection reset");
  }), /gpt-6\.1-sol.*medium.*connection reset/);
});

test("fetchRadarSnapshot aborts a stalled catalog request", async () => {
  await assert.rejects(() => fetchRadarSnapshot(async (_url, options) => stallUntilAborted(options.signal), 5), /catalog.*timed out/);
});

test("fetchRadarSnapshot aborts a stalled summary with model/effort context", async () => {
  await assert.rejects(() => fetchRadarSnapshot(async (url, options) => {
    if (String(url) === BINDING_URL) return jsonResponse(bindingFixture());
    return stallUntilAborted(options.signal);
  }, 5), /gpt-6\.1-sol.*medium.*timed out/);
});

test("each request gets its own timeout rather than sharing the catalog deadline", async () => {
  const snapshot = await fetchRadarSnapshot(async (url, options) => {
    await Promise.race([
      new Promise((resolve) => setTimeout(resolve, 50)), stallUntilAborted(options.signal),
    ]);
    return jsonResponse(String(url) === BINDING_URL ? bindingFixture() : summaryFixture());
  }, 80);
  assert.equal(snapshot.models[0].efforts[0].iq, 76.71583850931677);
});

test("normalizeSettings applies defaults and bounds", () => {
  assert.deepEqual(normalizeSettings(), { refreshMinutes: 15, notificationsEnabled: true, notificationThreshold: 2 });
  assert.deepEqual(normalizeSettings({ refreshMinutes: 1, notificationsEnabled: false, notificationThreshold: 999 }), {
    refreshMinutes: 5, notificationsEnabled: false, notificationThreshold: 150,
  });
});

test("theme mode defaults to auto and cycles through all modes", () => {
  assert.equal(normalizeThemeMode(), "auto");
  assert.equal(normalizeThemeMode("unknown"), "auto");
  assert.equal(nextThemeMode("auto"), "light");
  assert.equal(nextThemeMode("light"), "dark");
  assert.equal(nextThemeMode("dark"), "auto");
});

test("automatic theme follows local system time", () => {
  assert.equal(resolveTheme("auto", new Date(2026, 7, 10, 6, 59)), "dark");
  assert.equal(resolveTheme("auto", new Date(2026, 7, 10, 7, 0)), "light");
  assert.equal(resolveTheme("auto", new Date(2026, 7, 10, 18, 59)), "light");
  assert.equal(resolveTheme("auto", new Date(2026, 7, 10, 19, 0)), "dark");
});

test("manual theme mode overrides system time", () => {
  assert.equal(resolveTheme("dark", new Date(2026, 7, 10, 12, 0)), "dark");
  assert.equal(resolveTheme("light", new Date(2026, 7, 10, 0, 0)), "light");
});

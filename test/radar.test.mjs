import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSnapshot,
  compareSnapshots,
  fetchRadarSnapshot,
  formatChangeLabel,
  normalizeSettings,
} from "../src/radar.js";
import {
  nextThemeMode,
  normalizeThemeMode,
  resolveTheme,
} from "../src/theme.js";

function fixture() {
  return {
    benchmark_id: "deep-swe",
    scoring_mode: "binary-majority",
    rolling_window: 3,
    baseline_generated_at: "2026-08-10T01:00:00Z",
    tasks: [{ id: "task-a" }, { id: "task-b" }],
    combos: [
      { model: "gpt-5.6-sol", effort: "high" },
      { model: "gpt-5.6-sol", effort: "low" },
      { model: "gpt-5.6-sol", effort: "low" },
      { model: "unknown-model", effort: "high" },
    ],
    cells: {
      "task-a|gpt-5.6-sol|low": {
        n: 3,
        score_sum: 2,
        iq_weight: 2,
      },
      "task-b|gpt-5.6-sol|low": {
        n: 2,
        score_sum: 1,
      },
      "task-a|gpt-5.6-sol|high": {
        n: 1,
        score_sum: 1,
      },
      "task-b|gpt-5.6-sol|high": {
        n: 0,
        score_sum: 100,
      },
    },
  };
}

test("buildSnapshot uses the same weighted IQ formula as Codex Radar", () => {
  const snapshot = buildSnapshot(fixture(), "2026-08-10T02:00:00Z");
  const sol = snapshot.models.find((model) => model.id === "gpt-5.6-sol");

  assert.equal(snapshot.taskCount, 2);
  assert.equal(snapshot.comboCount, 3);
  assert.deepEqual(
    sol.efforts.map((effort) => effort.effort),
    ["low", "high"],
  );

  const low = sol.efforts.find((effort) => effort.effort === "low");
  assert.equal(low.weightedScore, 5);
  assert.equal(low.weightedSamples, 8);
  assert.equal(low.rawSamples, 5);
  assert.equal(low.iq, 94);
  assert.equal(low.sampledTaskCount, 2);
  assert.equal(sol.efforts.find((effort) => effort.effort === "high").sampledTaskCount, 1);

  assert.equal(sol.weightedScore, 6);
  assert.equal(sol.weightedSamples, 9);
  assert.equal(sol.rawSamples, 6);
  assert.equal(sol.iq, 100);
  assert.equal(sol.sampledTaskCount, 2, "the same task at two efforts counts once for coverage");
});

test("buildSnapshot discovers models from the API, including unfamiliar models", () => {
  const snapshot = buildSnapshot(fixture());

  assert.deepEqual(
    snapshot.models.map((model) => model.id),
    ["gpt-5.6-sol", "unknown-model"],
  );
  const unknown = snapshot.models[1];
  assert.equal(unknown.label, "unknown-model");
  assert.equal(unknown.iq, null);
  assert.deepEqual(unknown.efforts.map((value) => [value.effort, value.iq]), [["high", null]]);
  assert.equal(snapshot.models[0].runtimeLabel, "Codex");
  assert.equal(snapshot.models.some((model) => model.id === "gpt-5.6-terra"), false);
});

test("buildSnapshot includes the current site's added models and their runtime labels", () => {
  const addedModels = [
    ["gpt-6-astra", undefined, "GPT-6 Astra", "Codex"],
    ["dsh-deepseek-v4-flash", "dsh-minimal", "DeepSeek V4 Flash", "DSH"],
    ["dsh-deepseek-v4-pro", "dsh-minimal", "DeepSeek V4 Pro", "DSH"],
    ["dsh-deepseek-v4-flash-vision-exp", "dsh-minimal", "DeepSeek V4 Flash Vision Exp", "DSH"],
    ["grok-4.6", "grok-build", "Grok 4.6", "Grok"],
    ["k3", "kimi-code", "Kimi K3", "Kimi Code"],
    ["glm-5.3", "zcode", "GLM-5.3", "ZCode"],
    ["glm-5.3-flash", "zcode", "GLM-5.3 Flash", "ZCode"],
    ["gemini-3.7-flash", "antigravity", "Gemini 3.7 Flash", "Antigravity"],
    ["hy4-preview", "codebuddy", "HY4 Preview", "CodeBuddy"],
    ["claude-sonnet-5", "claude-code", "Claude Sonnet 5", "Claude Code"],
    ["claude-opus-5", "claude-code", "Claude Opus 5", "Claude Code"],
  ];
  const input = fixture();
  input.combos = addedModels.map(([model, agent]) => ({ model, agent, effort: "high", manual_only: true }));
  input.cells = Object.fromEntries(addedModels.map(([model]) => [
    `task-a|${model}|high`, { n: 2, score_sum: 1 },
  ]));

  const snapshot = buildSnapshot(input);
  assert.deepEqual(snapshot.models.map((model) => [model.id, model.label, model.runtimeLabel, model.iq]),
    addedModels.map(([id, _agent, label, runtime]) => [id, label, runtime, 75]));
  assert.equal(snapshot.models.find((model) => model.id === "claude-opus-5").statusLabel, "内测中");
});

test("Codex and DSH keep separate scores for the same underlying DeepSeek model", () => {
  const input = fixture();
  input.combos = [
    { model: "deepseek-v4-pro", effort: "high" },
    { model: "dsh-deepseek-v4-pro", agent: "dsh-minimal", effort: "high" },
  ];
  input.cells = {
    "task-a|deepseek-v4-pro|high": { n: 3, score_sum: 1 },
    "task-a|dsh-deepseek-v4-pro|high": { n: 3, score_sum: 2 },
  };
  const snapshot = buildSnapshot(input);
  assert.deepEqual(snapshot.models.map((model) => [model.runtimeLabel, model.iq]), [["Codex", 50], ["DSH", 100]]);
  assert.notEqual(snapshot.models[0].id, snapshot.models[1].id);
});

test("future runtimes and efforts are retained, sorted and deduplicated", () => {
  const input = fixture();
  input.combos = ["extended", "high", "off", "minimal", "low", "high"].map((effort) => ({
    model: "future-model", agent: "future-tool", effort,
  }));
  input.combos.push({ model: "", effort: "high" }, { model: "invalid", effort: "" });
  const snapshot = buildSnapshot(input);
  assert.equal(snapshot.comboCount, 5);
  assert.equal(snapshot.models.length, 1);
  assert.equal(snapshot.models[0].runtimeLabel, "future-tool");
  assert.deepEqual(snapshot.models[0].efforts.map((value) => value.effort), ["off", "minimal", "low", "high", "extended"]);
  assert.equal(snapshot.models[0].iq, null);
});

test("empty API catalog does not invent monitored models", () => {
  const snapshot = buildSnapshot({ tasks: [], combos: [], cells: {} });
  assert.deepEqual(snapshot.models, []);
  assert.equal(snapshot.comboCount, 0);
});

test("buildSnapshot falls back to p and ignores invalid non-positive weights", () => {
  const input = fixture();
  input.cells["task-a|gpt-5.6-sol|low"] = {
    n: 2,
    p: 1,
    score_sum: "not-a-number",
    iq_weight: 0,
  };
  delete input.cells["task-b|gpt-5.6-sol|low"];

  const snapshot = buildSnapshot(input);
  const low = snapshot.models[0].efforts.find((effort) => effort.effort === "low");

  assert.equal(low.weightedScore, 1);
  assert.equal(low.weightedSamples, 2);
  assert.equal(low.iq, 75);
});

test("buildSnapshot validates required API fields", () => {
  assert.throws(() => buildSnapshot(null), /must be an object/);
  assert.throws(() => buildSnapshot({ tasks: [], combos: [] }), /missing cells/);
  assert.throws(() => buildSnapshot({ cells: {} }), /missing tasks or combos/);
});

test("null score_sum uses the site's pass count instead of reporting zero IQ", () => {
  const input = fixture();
  input.cells = { "task-a|gpt-5.6-sol|low": { n: 2, p: 1, score_sum: null } };
  assert.equal(buildSnapshot(input).models[0].iq, 75);
});

test("compareSnapshots filters numeric changes using the configured threshold", () => {
  const previous = {
    models: [
      {
        id: "gpt-5.6-sol",
        label: "GPT-5.6 Sol",
        iq: 120,
        efforts: [
          { effort: "low", iq: 115 },
          { effort: "high", iq: 125 },
        ],
      },
    ],
  };
  const current = {
    models: [
      {
        id: "gpt-5.6-sol",
        label: "GPT-5.6 Sol",
        iq: 121,
        efforts: [
          { effort: "low", iq: 118 },
          { effort: "high", iq: 123 },
        ],
      },
    ],
  };

  const changes = compareSnapshots(previous, current, 2);
  assert.deepEqual(
    changes.map((change) => [change.key, change.delta]),
    [
      ["gpt-5.6-sol@low", 3],
      ["gpt-5.6-sol@high", -2],
    ],
  );
});

test("compareSnapshots reports a newly available effort", () => {
  const previous = {
    models: [
      {
        id: "gpt-5.5",
        label: "GPT-5.5",
        iq: null,
        efforts: [{ effort: "high", iq: null }],
      },
    ],
  };
  const current = {
    models: [
      {
        id: "gpt-5.5",
        label: "GPT-5.5",
        iq: 110,
        efforts: [{ effort: "high", iq: 110 }],
      },
    ],
  };

  const changes = compareSnapshots(previous, current, 20);
  assert.equal(changes.length, 2);
  assert.ok(changes.every((change) => change.kind === "available"));
});

test("new API models and efforts notify once they have scores, without an initial alert flood", () => {
  const previous = { models: [{ id: "k3", label: "Kimi K3", runtimeLabel: "Kimi Code", iq: 90, efforts: [] }] };
  const current = { models: [
    { ...previous.models[0], efforts: [{ effort: "max", iq: 105 }] },
    { id: "future-model", label: "Future model", runtimeLabel: "Future tool", iq: 100, efforts: [] },
    { id: "unsampled", label: "Unsampled", iq: null, efforts: [{ effort: "high", iq: null }] },
  ] };
  assert.deepEqual(compareSnapshots(null, current), []);
  const changes = compareSnapshots(previous, current, 20);
  assert.deepEqual(changes.map((change) => [change.key, change.kind]), [
    ["future-model", "available"], ["k3@max", "available"],
  ]);
  assert.equal(changes.find((change) => change.key === "k3@max").runtimeLabel, "Kimi Code");
});

test("removed API combinations report unavailable, not a fall to zero IQ", () => {
  const previous = { models: [{ id: "old-model", label: "Old model", iq: 90, efforts: [] }] };
  const changes = compareSnapshots(previous, { models: [] });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "unavailable");
  assert.equal(changes[0].delta, null);
  assert.equal(changes[0].newIq, null);
});

test("notifications distinguish the runtime of identically named models", () => {
  const change = { modelLabel: "DeepSeek V4 Pro", runtimeLabel: "DSH", effort: "high", kind: "changed", newIq: 90, delta: 3 };
  assert.equal(formatChangeLabel(change), "DeepSeek V4 Pro · DSH high：90 IQ（+3）");
});

test("normalizeSettings applies defaults and bounds", () => {
  assert.deepEqual(normalizeSettings(), {
    refreshMinutes: 15,
    notificationsEnabled: true,
    notificationThreshold: 2,
  });
  assert.deepEqual(
    normalizeSettings({
      refreshMinutes: 1,
      notificationsEnabled: false,
      notificationThreshold: 999,
    }),
    {
      refreshMinutes: 5,
      notificationsEnabled: false,
      notificationThreshold: 150,
    },
  );
});

test("fetchRadarSnapshot accepts an injected fetch implementation", async () => {
  const snapshot = await fetchRadarSnapshot(async (url, options) => {
    assert.match(url, /api\.codexradar\.com/);
    assert.equal(options.cache, "no-store");
    return {
      ok: true,
      json: async () => fixture(),
    };
  });

  assert.equal(snapshot.benchmarkId, "deep-swe");
});

test("fetchRadarSnapshot surfaces non-success HTTP responses", async () => {
  await assert.rejects(
    () =>
      fetchRadarSnapshot(async () => ({
        ok: false,
        status: 503,
      })),
    /HTTP 503/,
  );
});

test("fetchRadarSnapshot aborts a stalled request", async () => {
  await assert.rejects(
    () =>
      fetchRadarSnapshot(
        async (_url, options) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          }),
        5,
      ),
    /timed out/,
  );
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
  const noon = new Date(2026, 7, 10, 12, 0);
  const midnight = new Date(2026, 7, 10, 0, 0);
  assert.equal(resolveTheme("dark", noon), "dark");
  assert.equal(resolveTheme("light", midnight), "light");
});

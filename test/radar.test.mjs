import assert from "node:assert/strict";
import test from "node:test";

import {
  MODELS,
  buildSnapshot,
  compareSnapshots,
  fetchRadarSnapshot,
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
  assert.equal(snapshot.comboCount, 2);
  assert.deepEqual(
    sol.efforts.map((effort) => effort.effort),
    ["low", "high"],
  );

  const low = sol.efforts.find((effort) => effort.effort === "low");
  assert.equal(low.weightedScore, 5);
  assert.equal(low.weightedSamples, 8);
  assert.equal(low.rawSamples, 5);
  assert.equal(low.iq, 94);

  assert.equal(sol.weightedScore, 6);
  assert.equal(sol.weightedSamples, 9);
  assert.equal(sol.rawSamples, 6);
  assert.equal(sol.iq, 100);
});

test("buildSnapshot always returns the six monitored models", () => {
  const snapshot = buildSnapshot(fixture());

  assert.deepEqual(
    snapshot.models.map((model) => model.id),
    MODELS.map((model) => model.id),
  );
  const terra = snapshot.models.find((model) => model.id === "gpt-5.6-terra");
  assert.equal(terra.iq, null);
  assert.deepEqual(terra.efforts, []);
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

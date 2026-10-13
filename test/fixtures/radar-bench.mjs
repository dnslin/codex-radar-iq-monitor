// Public binding and gpt-6.1-sol/medium summary observed on 2026-10-13.
const BENCHMARK = "radar-bench-final64-20261004";
const TASK_SET_HASH = "f75ff09b6117cd83d3ab6ea744fe379ac117676c042538d5df5e38489af27bc4";

export function bindingFixture(overrides = {}) {
  return {
    enabled: true,
    interface_confirmed: true,
    production_read_verified: true,
    transport_origin: "https://api.codexradar.com",
    endpoint_path: "/api/v1/radar-bench-score",
    benchmark: BENCHMARK,
    catalog_version: "dradar-four-library-deployment007-server024-20261004-config64",
    task_set_sha256: TASK_SET_HASH,
    total_tasks: 64,
    score_version: "radar-bench-v2-150",
    score_max: 150,
    model_efforts: [{ model: "gpt-6.1-sol", effort: "medium" }],
    ...overrides,
  };
}

export function summaryFixture(overrides = {}) {
  return {
    schema: "radar-bench-public-summary-v5-150-daily-graded-count",
    benchmark: BENCHMARK,
    catalog_version: "dradar-four-library-deployment007-server024-20261004-config64",
    task_set_sha256: TASK_SET_HASH,
    score_version: "radar-bench-v2-150",
    score_max: 150,
    model: "gpt-6.1-sol",
    effort: "medium",
    score: 76.71583850931677,
    coverage: 48,
    required_tasks: 64,
    score_status: "provisional",
    graded_runs_count: 50,
    ...overrides,
  };
}

export function radarBenchFixture() {
  return {
    binding: bindingFixture({ model_efforts: [
      { model: "gpt-6.1-sol", effort: "high" },
      { model: "gpt-6.1-sol", effort: "medium" },
      { model: "gpt-6.1-sol", effort: "medium" },
      { model: "future-model", effort: "high" },
    ] }),
    summaries: [
      summaryFixture({ effort: "high", score: 75.25, coverage: 49, graded_runs_count: 55 }),
      summaryFixture(),
      summaryFixture({ model: "future-model", effort: "high", score: null, coverage: 0, graded_runs_count: null, score_status: "missing_current_result" }),
    ],
  };
}

export const API_URL = "https://codexradar.com/api/radar-bench-score";
export const BINDING_URL = "https://codexradar.com/data/radar-bench-binding.json";

export const ALARM_NAME = "codex-radar-refresh";
export const STATE_KEY = "radarState";
export const SETTINGS_KEY = "radarSettings";

export const EFFORT_ORDER = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

// Display names only, never an allowlist. New API models retain their original ID
// as a readable label until the site gives them a familiar display name.
const MODEL_LABELS = new Map(Object.entries({
  "gpt-6-astra": "GPT-6 Astra",
  "gpt-6.1-sol": "GPT-6.1 Sol",
  "gpt-6-sol": "GPT-6 Sol",
  "gpt-6-luna": "GPT-6 Luna",
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "gpt-5.5": "GPT-5.5",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "deepseek-v4.1-flash": "DeepSeek V4.1 Flash",
  "dsh-deepseek-v4-pro": "DeepSeek V4 Pro",
  "dsh-deepseek-v4-flash": "DeepSeek V4 Flash",
  "dsh-deepseek-v4.1-flash": "DeepSeek V4.1 Flash",
  "dsh-deepseek-v4-flash-vision-exp": "DeepSeek V4 Flash Vision Exp",
  "grok-4.6": "Grok 4.6",
  "grok-4.7": "Grok 4.7",
  "k3": "Kimi K3",
  "kimi-k2.8-preview": "Kimi K2.8 Preview",
  "glm-5.3": "GLM-5.3",
  "glm-5.3-flash": "GLM-5.3 Flash",
  "gemini-3.7-flash": "Gemini 3.7 Flash",
  "gemini-3.8-flash": "Gemini 3.8 Flash",
  "hy4-preview": "HY4 Preview",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-opus-5": "Claude Opus 5",
  "claude-opus-5-5": "Claude Opus 5.5",
  "kiro-claude-opus-5.5": "Claude Opus 5.5",
}));

export const DEFAULT_SETTINGS = Object.freeze({
  refreshMinutes: 15,
  notificationsEnabled: true,
  notificationThreshold: 2,
});

const EFFORT_INDEX = new Map(EFFORT_ORDER.map((effort, index) => [effort, index]));

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sortEfforts(efforts) {
  return efforts.sort((left, right) => {
    const leftIndex = EFFORT_INDEX.get(left.effort) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = EFFORT_INDEX.get(right.effort) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex || left.effort.localeCompare(right.effort);
  });
}

function catalogSelections(binding) {
  if (!binding || binding.enabled !== true || binding.production_read_verified !== true ||
      !Array.isArray(binding.model_efforts) || !Number.isInteger(binding.total_tasks) ||
      binding.total_tasks <= 0 || binding.score_max !== 150 ||
      ![binding.benchmark, binding.score_version, binding.catalog_version, binding.task_set_sha256]
        .every((value) => typeof value === "string" && value.length > 0)) {
    throw new TypeError("Radar API catalog is invalid or unavailable");
  }
  const selections = new Map();
  for (const selection of binding.model_efforts) {
    if (typeof selection?.model !== "string" || !selection.model.trim() ||
        typeof selection.effort !== "string" || !selection.effort.trim()) {
      throw new TypeError("Radar API catalog contains an invalid model/effort");
    }
    selections.set(`${selection.model}|${selection.effort}`, selection);
  }
  return [...selections.values()];
}

function validateSummary(summary, binding, selection) {
  const context = `${selection.model} ${selection.effort}`;
  if (!summary || summary.model !== selection.model || summary.effort !== selection.effort ||
      summary.benchmark !== binding.benchmark || summary.task_set_sha256 !== binding.task_set_sha256 ||
      summary.catalog_version !== binding.catalog_version || summary.score_version !== binding.score_version ||
      summary.score_max !== 150 || summary.required_tasks !== binding.total_tasks) {
    throw new TypeError(`Radar API ${context} summary does not match the catalog`);
  }
  const validScore = typeof summary.score === "number" && Number.isFinite(summary.score) &&
    summary.score >= 0 && summary.score <= 150;
  if (!Number.isInteger(summary.coverage) || summary.coverage < 0 || summary.coverage > binding.total_tasks ||
      (summary.coverage === 0 ? summary.score !== null : !validScore) ||
      !(summary.graded_runs_count === null ||
        Number.isInteger(summary.graded_runs_count) && summary.graded_runs_count >= 0)) {
    throw new TypeError(`Radar API ${context} summary has invalid score, coverage or graded_runs_count`);
  }
  return summary;
}

// Scores are authoritative per effort. The model row shows its best measured
// effort, including that same effort's coverage and samples; no cross-effort 雷达分.
export function buildSnapshot(binding, summaries, fetchedAt = new Date().toISOString()) {
  const selections = catalogSelections(binding);
  if (!Array.isArray(summaries)) {
    throw new TypeError("Radar API snapshot requires every catalog summary");
  }
  const summariesByKey = new Map();
  for (const summary of summaries) {
    const key = `${summary?.model}|${summary?.effort}`;
    if (summariesByKey.has(key)) throw new TypeError(`Radar API duplicate summary: ${key}`);
    summariesByKey.set(key, summary);
  }
  if (summariesByKey.size > selections.length) {
    throw new TypeError("Radar API snapshot contains unexpected summaries");
  }
  const modelsById = new Map();
  for (const selection of selections) {
    const {model, effort} = selection;
    const summary = validateSummary(summariesByKey.get(`${model}|${effort}`), binding, selection);
    if (!modelsById.has(model)) {
      modelsById.set(model, {
        id: model, modelId: model, label: MODEL_LABELS.get(model) ?? model,
        runtime: "codex", runtimeLabel: "Codex", efforts: [],
      });
    }
    modelsById.get(model).efforts.push({
      effort, iq: summary.score, rawSamples: summary.graded_runs_count,
      sampledTaskCount: summary.coverage, scoreStatus: summary.score_status,
    });
  }
  const models = [...modelsById.values()].map((model) => {
    sortEfforts(model.efforts);
    const best = model.efforts.reduce((best, effort) =>
      effort.iq !== null && (best === null || effort.iq > best.iq) ? effort : best, null);
    return {...model, iq: best?.iq ?? null, bestEffort: best?.effort ?? null,
      rawSamples: best ? best.rawSamples : 0, sampledTaskCount: best?.sampledTaskCount ?? 0};
  });
  return {
    version: 3, benchmarkId: binding.benchmark, scoringMode: binding.score_version,
    taskSetHash: binding.task_set_sha256, taskCount: binding.total_tasks,
    comboCount: selections.length, sourceUpdatedAt: null, fetchedAt, models,
  };
}

async function requestJson(url, fetchImpl, timeoutMs, context, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, finiteNumber(timeoutMs, 15_000)));
  try {
    const response = await fetchImpl(url, {
      cache: "no-store", credentials: "omit", headers: {Accept: "application/json", ...headers},
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Radar API ${context} request timed out`);
    throw new Error(`Radar API ${context} request failed: ${error.message}`, {cause: error});
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchRadarSnapshot(fetchImpl = fetch, timeoutMs = 15_000) {
  const binding = await requestJson(BINDING_URL, fetchImpl, timeoutMs, "catalog");
  const selections = catalogSelections(binding);
  const summaries = new Array(selections.length);
  let index = 0;
  let failure = null;
  // Match the source site's three-request pool; never fan out all 34 requests.
  async function worker() {
    while (!failure && index < selections.length) {
      const currentIndex = index++;
      const selection = selections[currentIndex];
      try {
        const url = `${API_URL}?${new URLSearchParams({model: selection.model, effort: selection.effort, view: "summary"})}`;
        const summary = await requestJson(url, fetchImpl, timeoutMs,
          `${selection.model} ${selection.effort}`, {"X-Radar-Bench-Selection": "user-selected-v1"});
        summaries[currentIndex] = validateSummary(summary, binding, selection);
      } catch (error) {
        failure ??= error;
      }
    }
  }
  await Promise.all(Array.from({length: Math.min(3, selections.length)}, worker));
  if (failure) throw failure;
  return buildSnapshot(binding, summaries);
}

export function canCompareSnapshots(previous, current) {
  return Boolean(previous && current && previous.version === 3 && current.version === 3 &&
    ["benchmarkId", "scoringMode", "taskSetHash"].every((key) =>
      typeof previous[key] === "string" && previous[key].length > 0 && previous[key] === current[key]));
}

function valuesFromSnapshot(snapshot) {
  const values = new Map();
  for (const model of snapshot.models) {
    for (const effort of model.efforts) {
      values.set(`${model.id}@${effort.effort}`, {
        scope: "effort", modelId: model.id, modelLabel: model.label,
        runtimeLabel: model.runtimeLabel, effort: effort.effort, iq: effort.iq,
      });
    }
  }
  return values;
}

export function compareSnapshots(previous, current, threshold = 0) {
  if (!canCompareSnapshots(previous, current)) return [];
  const minimumChange = clamp(finiteNumber(threshold), 0, 150);
  const before = valuesFromSnapshot(previous);
  const after = valuesFromSnapshot(current);
  const changes = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const oldValue = before.get(key);
    const newValue = after.get(key);
    const value = newValue ?? oldValue;
    const oldIq = Number.isFinite(oldValue?.iq) ? oldValue.iq : null;
    const newIq = Number.isFinite(newValue?.iq) ? newValue.iq : null;
    if (oldIq === newIq) continue;
    let kind = "changed";
    let delta = null;
    if (oldIq === null) kind = "available";
    else if (newIq === null) kind = "unavailable";
    else delta = newIq - oldIq;
    if (delta !== null && Math.abs(delta) < minimumChange) continue;
    changes.push({key, scope: value.scope, modelId: value.modelId, modelLabel: value.modelLabel,
      runtimeLabel: value.runtimeLabel, effort: value.effort, oldIq, newIq, delta, kind});
  }
  return changes.sort((left, right) =>
    (right.delta === null ? 151 : Math.abs(right.delta)) -
    (left.delta === null ? 151 : Math.abs(left.delta)) || left.key.localeCompare(right.key));
}

export function normalizeSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  const refreshMinutes = clamp(
    Math.round(finiteNumber(source.refreshMinutes, DEFAULT_SETTINGS.refreshMinutes)),
    5,
    24 * 60,
  );
  const notificationThreshold = clamp(
    Math.round(
      finiteNumber(
        source.notificationThreshold,
        DEFAULT_SETTINGS.notificationThreshold,
      ) * 10,
    ) / 10,
    0,
    150,
  );

  return {
    refreshMinutes,
    notificationsEnabled:
      typeof source.notificationsEnabled === "boolean"
        ? source.notificationsEnabled
        : DEFAULT_SETTINGS.notificationsEnabled,
    notificationThreshold,
  };
}

const scoreFormatter = new Intl.NumberFormat("zh-CN", {maximumFractionDigits: 1});

export function formatChangeLabel(change) {
  const modelLabel = change.runtimeLabel
    ? `${change.modelLabel} · ${change.runtimeLabel}`
    : change.modelLabel;
  const target = change.effort
    ? `${modelLabel} ${change.effort}`
    : modelLabel;
  if (change.kind === "available") return `${target}：新增 ${scoreFormatter.format(change.newIq)} 雷达分`;
  if (change.kind === "unavailable") return `${target}：暂无数据`;
  const sign = change.delta > 0 ? "+" : "";
  return `${target}：${scoreFormatter.format(change.newIq)} 雷达分（${sign}${scoreFormatter.format(change.delta)}）`;
}

export const API_URL =
  "https://api.codexradar.com/api/v1/table?benchmark=deep-swe";

export const ALARM_NAME = "codex-radar-refresh";
export const STATE_KEY = "radarState";
export const SETTINGS_KEY = "radarSettings";

export const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max", "ultra"];

export const MODELS = [
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    shortLabel: "Sol",
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    shortLabel: "Terra",
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    shortLabel: "Luna",
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    shortLabel: "GPT-5.5",
  },
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    shortLabel: "V4 Flash",
  },
];

export const DEFAULT_SETTINGS = Object.freeze({
  refreshMinutes: 15,
  notificationsEnabled: true,
  notificationThreshold: 2,
});

const MODEL_INDEX = new Map(MODELS.map((model) => [model.id, model]));
const EFFORT_INDEX = new Map(EFFORT_ORDER.map((effort, index) => [effort, index]));

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sampleFromCell(cell) {
  const sampleCount = Math.max(0, finiteNumber(cell?.n));
  if (!sampleCount) {
    return { weightedScore: 0, weightedSamples: 0, rawSamples: 0 };
  }

  const scoreSum = Number.isFinite(Number(cell?.score_sum))
    ? Number(cell.score_sum)
    : finiteNumber(cell?.p);
  const rawWeight = finiteNumber(cell?.iq_weight, 1);
  const weight = rawWeight > 0 ? rawWeight : 1;

  return {
    weightedScore: scoreSum * weight,
    weightedSamples: sampleCount * weight,
    rawSamples: sampleCount,
  };
}

function emptySample() {
  return { weightedScore: 0, weightedSamples: 0, rawSamples: 0 };
}

function addSample(target, source) {
  target.weightedScore += source.weightedScore;
  target.weightedSamples += source.weightedSamples;
  target.rawSamples += source.rawSamples;
  return target;
}

function iqFromSample(sample) {
  if (!sample.weightedSamples) return null;
  const ratio = clamp(sample.weightedScore / sample.weightedSamples, 0, 1);
  return Math.round(ratio * 150);
}

function sortEfforts(efforts) {
  return efforts.sort((left, right) => {
    const leftIndex = EFFORT_INDEX.get(left.effort) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = EFFORT_INDEX.get(right.effort) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex || left.effort.localeCompare(right.effort);
  });
}

/**
 * Converts the Codex Radar table response into the compact data used by the
 * extension. The IQ formula intentionally mirrors the website:
 * round(sum(score_sum * iq_weight) / sum(n * iq_weight) * 150).
 */
export function buildSnapshot(table, fetchedAt = new Date().toISOString()) {
  if (!table || typeof table !== "object") {
    throw new TypeError("Radar API response must be an object");
  }
  if (!Array.isArray(table.tasks) || !Array.isArray(table.combos)) {
    throw new TypeError("Radar API response is missing tasks or combos");
  }
  if (!table.cells || typeof table.cells !== "object" || Array.isArray(table.cells)) {
    throw new TypeError("Radar API response is missing cells");
  }

  const comboKeys = new Set();
  const effortsByModel = new Map(MODELS.map((model) => [model.id, new Set()]));

  for (const combo of table.combos) {
    const model = String(combo?.model ?? "");
    const effort = String(combo?.effort ?? "");
    if (!MODEL_INDEX.has(model) || !effort) continue;
    const key = `${model}|${effort}`;
    if (comboKeys.has(key)) continue;
    comboKeys.add(key);
    effortsByModel.get(model).add(effort);
  }

  const models = MODELS.map((model) => {
    const modelSample = emptySample();
    const efforts = sortEfforts(
      [...effortsByModel.get(model.id)].map((effort) => {
        const effortSample = emptySample();

        for (const task of table.tasks) {
          const taskId = String(task?.id ?? "");
          if (!taskId) continue;
          const cell = table.cells[`${taskId}|${model.id}|${effort}`];
          if (!cell) continue;
          addSample(effortSample, sampleFromCell(cell));
        }

        addSample(modelSample, effortSample);
        return {
          effort,
          iq: iqFromSample(effortSample),
          weightedScore: effortSample.weightedScore,
          weightedSamples: effortSample.weightedSamples,
          rawSamples: effortSample.rawSamples,
        };
      }),
    );

    return {
      id: model.id,
      label: model.label,
      shortLabel: model.shortLabel,
      iq: iqFromSample(modelSample),
      weightedScore: modelSample.weightedScore,
      weightedSamples: modelSample.weightedSamples,
      rawSamples: modelSample.rawSamples,
      efforts,
    };
  });

  return {
    version: 1,
    benchmarkId: String(table.benchmark_id ?? "deep-swe"),
    scoringMode: String(table.scoring_mode ?? ""),
    rollingWindow: finiteNumber(table.rolling_window, 0),
    taskCount: table.tasks.length,
    comboCount: comboKeys.size,
    sourceUpdatedAt:
      typeof table.baseline_generated_at === "string"
        ? table.baseline_generated_at
        : null,
    fetchedAt,
    models,
  };
}

export async function fetchRadarSnapshot(fetchImpl = fetch, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1, finiteNumber(timeoutMs, 15_000)),
  );

  try {
    const response = await fetchImpl(API_URL, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Radar API request failed: HTTP ${response.status}`);
    }

    return buildSnapshot(await response.json());
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Radar API request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function valuesFromSnapshot(snapshot) {
  const values = new Map();
  for (const model of snapshot?.models ?? []) {
    values.set(model.id, {
      scope: "model",
      modelId: model.id,
      modelLabel: model.label,
      effort: null,
      iq: model.iq,
    });
    for (const effort of model.efforts ?? []) {
      values.set(`${model.id}@${effort.effort}`, {
        scope: "effort",
        modelId: model.id,
        modelLabel: model.label,
        effort: effort.effort,
        iq: effort.iq,
      });
    }
  }
  return values;
}

export function compareSnapshots(previous, current, threshold = 0) {
  if (!previous || !current) return [];

  const minimumChange = clamp(finiteNumber(threshold), 0, 150);
  const before = valuesFromSnapshot(previous);
  const after = valuesFromSnapshot(current);
  const keys = new Set([...before.keys(), ...after.keys()]);
  const changes = [];

  for (const key of keys) {
    const oldValue = before.get(key);
    const newValue = after.get(key);
    if (!oldValue || !newValue) continue;

    const oldIq = Number.isFinite(oldValue.iq) ? oldValue.iq : null;
    const newIq = Number.isFinite(newValue.iq) ? newValue.iq : null;
    if (oldIq === newIq) continue;

    let kind = "changed";
    let delta = null;
    if (oldIq === null && newIq !== null) kind = "available";
    else if (oldIq !== null && newIq === null) kind = "unavailable";
    else delta = newIq - oldIq;

    if (delta !== null && Math.abs(delta) < minimumChange) continue;

    changes.push({
      key,
      scope: newValue.scope,
      modelId: newValue.modelId,
      modelLabel: newValue.modelLabel,
      effort: newValue.effort,
      oldIq,
      newIq,
      delta,
      kind,
    });
  }

  return changes.sort((left, right) => {
    const leftMagnitude = left.delta === null ? 151 : Math.abs(left.delta);
    const rightMagnitude = right.delta === null ? 151 : Math.abs(right.delta);
    return rightMagnitude - leftMagnitude || left.key.localeCompare(right.key);
  });
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

export function formatChangeLabel(change) {
  const target = change.effort
    ? `${change.modelLabel} ${change.effort}`
    : `${change.modelLabel} 总体`;
  if (change.kind === "available") return `${target}：新增 ${change.newIq} IQ`;
  if (change.kind === "unavailable") return `${target}：暂无数据`;
  const sign = change.delta > 0 ? "+" : "";
  return `${target}：${change.newIq} IQ（${sign}${change.delta}）`;
}

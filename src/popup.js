import {
  EFFORT_ORDER,
  MODELS,
  SETTINGS_KEY,
  STATE_KEY,
  normalizeSettings,
} from "./radar.js";
import {
  THEME_KEY,
  nextThemeMode,
  normalizeThemeMode,
  resolveTheme,
} from "./theme.js";

const statusText = document.querySelector("#status-text");
const themeButton = document.querySelector("#theme-button");
const themeIcon = document.querySelector("#theme-icon");
const themeLabel = document.querySelector("#theme-label");
const refreshButton = document.querySelector("#refresh-button");
const errorBanner = document.querySelector("#error-banner");
const datasetMeta = document.querySelector("#dataset-meta");
const modelSummary = document.querySelector("#model-summary");
const matrixBody = document.querySelector("#matrix-body");
const sourceTime = document.querySelector("#source-time");
const refreshMinutes = document.querySelector("#refresh-minutes");
const notificationsEnabled = document.querySelector("#notifications-enabled");
const notificationThreshold = document.querySelector("#notification-threshold");
const settingsStatus = document.querySelector("#settings-status");

let currentState = null;
let currentSettings = normalizeSettings();
let currentThemeMode = "auto";
let settingsStatusTimer = null;
let autoThemeTimer = null;

const numberFormatter = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 1,
});
const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const THEME_PRESENTATION = Object.freeze({
  auto: { label: "自动", icon: "◐" },
  light: { label: "浅色", icon: "☀" },
  dark: { label: "深色", icon: "☾" },
});

function applyTheme(mode, now = new Date()) {
  currentThemeMode = normalizeThemeMode(mode);
  const resolvedTheme = resolveTheme(currentThemeMode, now);
  const presentation = THEME_PRESENTATION[currentThemeMode];
  const resolvedLabel = resolvedTheme === "light" ? "浅色" : "深色";
  const nextMode = nextThemeMode(currentThemeMode);

  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.dataset.themeMode = currentThemeMode;
  themeIcon.textContent = presentation.icon;
  themeLabel.textContent = presentation.label;

  const description = currentThemeMode === "auto"
    ? `主题：自动（当前${resolvedLabel}，07:00–18:59 为浅色）`
    : `主题：${presentation.label}`;
  themeButton.title = description;
  themeButton.setAttribute(
    "aria-label",
    `${description}。点击切换为${THEME_PRESENTATION[nextMode].label}模式`,
  );
}

async function initializeTheme() {
  applyTheme("auto");
  try {
    const stored = await chrome.storage.local.get(THEME_KEY);
    const mode = normalizeThemeMode(stored[THEME_KEY]);
    applyTheme(mode);
    if (stored[THEME_KEY] !== mode) {
      await chrome.storage.local.set({ [THEME_KEY]: mode });
    }
  } catch (error) {
    console.warn("Unable to restore theme preference", error);
  }

  clearInterval(autoThemeTimer);
  autoThemeTimer = setInterval(() => {
    if (currentThemeMode === "auto") applyTheme("auto");
  }, 60_000);
}

async function cycleTheme() {
  const previousMode = currentThemeMode;
  const nextMode = nextThemeMode(previousMode);
  applyTheme(nextMode);
  try {
    await chrome.storage.local.set({ [THEME_KEY]: nextMode });
  } catch (error) {
    applyTheme(previousMode);
    console.warn("Unable to save theme preference", error);
  }
}

function isNumber(value) {
  return value !== null && value !== "" && Number.isFinite(Number(value));
}

function sendMessage(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (!response?.ok) {
      throw new Error(response?.error || "扩展后台没有返回有效结果");
    }
    return response;
  });
}

function formatDateTime(value) {
  if (!value) return "未知时间";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未知时间" : dateTimeFormatter.format(date);
}

function formatRelativeTime(value) {
  if (!value) return "尚未更新";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "更新时间未知";

  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 15) return "刚刚更新";
  if (seconds < 60) return `${seconds} 秒前更新`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前更新`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前更新`;
  return `${Math.round(hours / 24)} 天前更新`;
}

function formatSample(value) {
  const weighted = Number(value?.weightedSamples) || 0;
  const raw = Number(value?.rawSamples) || 0;
  if (!weighted) return "暂无样本";
  if (Math.abs(weighted - raw) > 0.001) {
    return `加权 ${numberFormatter.format(weighted)}`;
  }
  return `${numberFormatter.format(raw)} 次`;
}

function valueDelta(previous, current) {
  const before = isNumber(previous) ? Number(previous) : null;
  const after = isNumber(current) ? Number(current) : null;
  if (before === null || after === null || before === after) return null;
  return after - before;
}

function appendDelta(container, delta, className = "delta") {
  const element = document.createElement("span");
  element.className = className;
  if (delta === null) {
    element.classList.add("neutral");
    element.textContent = "";
  } else {
    element.classList.add(delta > 0 ? "positive" : "negative");
    element.textContent = `${delta > 0 ? "+" : ""}${delta}`;
  }
  container.append(element);
}

function modelMap(snapshot) {
  return new Map((snapshot?.models ?? []).map((model) => [model.id, model]));
}

function effortMap(model) {
  return new Map((model?.efforts ?? []).map((effort) => [effort.effort, effort]));
}

function renderStatus(state) {
  const lastSuccess = state?.lastSuccessAt || state?.snapshot?.fetchedAt;
  switch (state?.status) {
    case "loading":
      statusText.textContent = "正在首次获取数据…";
      break;
    case "refreshing":
      statusText.textContent = `正在刷新 · ${formatRelativeTime(lastSuccess)}`;
      break;
    case "error":
      statusText.textContent = lastSuccess
        ? `刷新失败 · ${formatRelativeTime(lastSuccess)}`
        : "刷新失败";
      break;
    case "ready":
      statusText.textContent = formatRelativeTime(lastSuccess);
      break;
    default:
      statusText.textContent = "尚未获取数据";
  }

  const isLoading = state?.status === "loading" || state?.status === "refreshing";
  refreshButton.disabled = isLoading;
  refreshButton.classList.toggle("loading", isLoading);
}

function renderError(state) {
  if (!state?.error) {
    errorBanner.hidden = true;
    errorBanner.textContent = "";
    return;
  }
  errorBanner.hidden = false;
  errorBanner.textContent = `数据更新失败：${state.error}`;
}

function renderSummary(snapshot, previousSnapshot) {
  const currentModels = modelMap(snapshot);
  const previousModels = modelMap(previousSnapshot);
  modelSummary.replaceChildren();

  for (const definition of MODELS) {
    const model = currentModels.get(definition.id);
    const previous = previousModels.get(definition.id);
    const card = document.createElement("article");
    card.className = "model-card";
    card.dataset.model = definition.id;

    const name = document.createElement("div");
    name.className = "model-card-name";
    name.textContent = definition.shortLabel;
    name.title = definition.label;

    const scoreRow = document.createElement("div");
    scoreRow.className = "model-card-score";
    const score = document.createElement("strong");
    score.textContent = isNumber(model?.iq) ? String(model.iq) : "—";
    const unit = document.createElement("small");
    unit.textContent = "IQ";
    scoreRow.append(score, unit);

    const meta = document.createElement("div");
    meta.className = "model-card-meta";
    const sample = document.createElement("span");
    sample.textContent = formatSample(model);
    meta.append(sample);
    appendDelta(meta, valueDelta(previous?.iq, model?.iq));

    card.append(name, scoreRow, meta);
    modelSummary.append(card);
  }
}

function createScoreCell(value, previousValue, label) {
  const cell = document.createElement("td");
  const wrapper = document.createElement("div");
  wrapper.className = "score-cell";
  const scoreLine = document.createElement("div");
  scoreLine.className = "score-line";
  const score = document.createElement("span");
  score.className = "score";

  if (!value || !isNumber(value.iq)) {
    wrapper.classList.add("missing");
    score.textContent = "—";
    cell.title = `${label}：暂无数据`;
  } else {
    score.textContent = String(value.iq);
    cell.title = `${label}：${value.iq} IQ，${formatSample(value)}`;
  }

  scoreLine.append(score);
  appendDelta(scoreLine, valueDelta(previousValue?.iq, value?.iq), "cell-delta");

  const sample = document.createElement("div");
  sample.className = "sample";
  sample.textContent = value ? formatSample(value) : "";
  wrapper.append(scoreLine, sample);
  cell.append(wrapper);
  return cell;
}

function renderMatrix(snapshot, previousSnapshot) {
  const currentModels = modelMap(snapshot);
  const previousModels = modelMap(previousSnapshot);
  matrixBody.replaceChildren();

  for (const definition of MODELS) {
    const model = currentModels.get(definition.id);
    const previousModel = previousModels.get(definition.id);
    const efforts = effortMap(model);
    const previousEfforts = effortMap(previousModel);
    const row = document.createElement("tr");
    row.dataset.model = definition.id;

    const heading = document.createElement("th");
    heading.scope = "row";
    const modelName = document.createElement("span");
    modelName.className = "model-name-row";
    const dot = document.createElement("span");
    dot.className = "model-dot";
    const text = document.createElement("span");
    text.textContent = definition.shortLabel;
    text.title = definition.label;
    modelName.append(dot, text);
    heading.append(modelName);
    row.append(heading);

    row.append(createScoreCell(model, previousModel, `${definition.label} 总体`));
    for (const effort of EFFORT_ORDER) {
      row.append(
        createScoreCell(
          efforts.get(effort),
          previousEfforts.get(effort),
          `${definition.label} ${effort}`,
        ),
      );
    }
    matrixBody.append(row);
  }
}

function renderMetadata(snapshot) {
  if (!snapshot) {
    datasetMeta.textContent = "";
    sourceTime.textContent = "尚未获取数据";
    return;
  }

  datasetMeta.textContent = `${snapshot.taskCount} 个任务 · ${snapshot.comboCount} 个档位`;
  const source = snapshot.sourceUpdatedAt
    ? `站点快照 ${formatDateTime(snapshot.sourceUpdatedAt)}`
    : "站点快照时间未知";
  sourceTime.textContent = `${source} · 本地获取 ${formatDateTime(snapshot.fetchedAt)}`;
}

function renderState(state) {
  currentState = state;
  renderStatus(state);
  renderError(state);
  renderSummary(state?.snapshot, state?.previousSnapshot);
  renderMatrix(state?.snapshot, state?.previousSnapshot);
  renderMetadata(state?.snapshot);
}

function renderSettings(settings) {
  currentSettings = normalizeSettings(settings);
  const knownRefreshValues = ["5", "15", "30", "60"];
  const refreshValue = String(currentSettings.refreshMinutes);
  refreshMinutes.value = knownRefreshValues.includes(refreshValue) ? refreshValue : "15";
  notificationsEnabled.checked = currentSettings.notificationsEnabled;
  notificationThreshold.value = String(currentSettings.notificationThreshold);
  notificationThreshold.disabled = !currentSettings.notificationsEnabled;
}

function showSettingsStatus(message, error = false) {
  clearTimeout(settingsStatusTimer);
  settingsStatus.textContent = message;
  settingsStatus.classList.toggle("error", error);
  if (message) {
    settingsStatusTimer = setTimeout(() => {
      settingsStatus.textContent = "";
      settingsStatus.classList.remove("error");
    }, 1800);
  }
}

async function saveSettings() {
  const nextSettings = {
    refreshMinutes: Number(refreshMinutes.value),
    notificationsEnabled: notificationsEnabled.checked,
    notificationThreshold: Number(notificationThreshold.value),
  };
  notificationThreshold.disabled = !nextSettings.notificationsEnabled;
  showSettingsStatus("保存中…");

  try {
    const response = await sendMessage({
      type: "SAVE_SETTINGS",
      settings: nextSettings,
    });
    renderSettings(response.settings);
    showSettingsStatus("已保存");
  } catch (error) {
    showSettingsStatus(error.message, true);
  }
}

async function refreshNow() {
  refreshButton.disabled = true;
  refreshButton.classList.add("loading");
  try {
    const response = await sendMessage({ type: "REFRESH_NOW" });
    renderState(response.state);
  } catch (error) {
    renderError({ error: error.message });
  } finally {
    refreshButton.disabled = false;
    refreshButton.classList.remove("loading");
  }
}

async function initialize() {
  renderState({ status: "idle", snapshot: null, previousSnapshot: null });
  try {
    const response = await sendMessage({ type: "GET_STATE" });
    renderSettings(response.settings);
    renderState(response.state);

    if (!response.state?.snapshot && response.state?.status !== "loading") {
      await refreshNow();
    }
    void sendMessage({ type: "MARK_SEEN" }).catch(() => {});
  } catch (error) {
    renderError({ error: error.message });
    statusText.textContent = "扩展后台不可用";
  }
}

themeButton.addEventListener("click", () => {
  void cycleTheme();
});
refreshButton.addEventListener("click", refreshNow);
refreshMinutes.addEventListener("change", saveSettings);
notificationsEnabled.addEventListener("change", saveSettings);
notificationThreshold.addEventListener("change", saveSettings);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[STATE_KEY]?.newValue) renderState(changes[STATE_KEY].newValue);
  if (changes[SETTINGS_KEY]?.newValue) renderSettings(changes[SETTINGS_KEY].newValue);
  if (changes[THEME_KEY]) applyTheme(changes[THEME_KEY].newValue);
});

void initializeTheme();
void initialize();

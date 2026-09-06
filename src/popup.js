import {
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
import { hasLowCoverage, isNumber, runtimeOptions, selectModels, valueDelta } from "./view.js";

const statusText = document.querySelector("#status-text");
const themeButton = document.querySelector("#theme-button");
const themeIcon = document.querySelector("#theme-icon");
const themeLabel = document.querySelector("#theme-label");
const refreshButton = document.querySelector("#refresh-button");
const errorBanner = document.querySelector("#error-banner");
const datasetMeta = document.querySelector("#dataset-meta");
const modelList = document.querySelector("#model-list");
const modelScroll = document.querySelector("#model-scroll");
const modelSearch = document.querySelector("#model-search");
const runtimeFilter = document.querySelector("#runtime-filter");
const modelSort = document.querySelector("#model-sort");
const resultCount = document.querySelector("#result-count");
const resultsStatus = document.querySelector("#results-status");
const emptyState = document.querySelector("#empty-state");
const emptyTitle = document.querySelector("#empty-title");
const emptyDescription = document.querySelector("#empty-description");
const clearFilters = document.querySelector("#clear-filters");
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
let renderedData = "";
const modelRows = new Map();

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
  if (!weighted) return "待采样";
  if (Math.abs(weighted - raw) > 0.001) {
    return `加权 ${numberFormatter.format(weighted)}`;
  }
  return `${numberFormatter.format(raw)} 次`;
}

function renderDelta(element, delta) {
  element.className = "delta";
  if (delta === null) {
    element.classList.add("neutral");
    element.textContent = "—";
    element.title = "暂无可对比的上次分数";
  } else if (delta === 0) {
    element.classList.add("neutral");
    element.textContent = "持平";
    element.title = "与上次快照相比没有变化";
  } else {
    element.classList.add(delta > 0 ? "positive" : "negative");
    element.textContent = `${delta > 0 ? "+" : ""}${numberFormatter.format(delta)}`;
    element.title = `较上次${delta > 0 ? "上升" : "下降"} ${numberFormatter.format(Math.abs(delta))} IQ`;
  }
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
  const cached = state.snapshot ? "。当前显示上次成功获取的数据。" : "。请点击刷新重试。";
  errorBanner.textContent = `数据更新失败：${state.error}${cached}`;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function createModelRow(model) {
  const row = element("details", "model-row");
  row.dataset.model = model.id;
  const summary = element("summary", "model-summary row-layout");
  const identity = element("span", "model-identity");
  const nameLine = element("span", "model-name-line");
  const name = element("span", "model-name");
  const status = element("span", "model-status");
  nameLine.append(name, status);
  const metadata = element("span", "model-meta");
  const runtime = element("span", "runtime-badge");
  const effortCount = element("span", "effort-count");
  const coverageNote = element("span", "coverage-note", "样本覆盖不足");
  coverageNote.title = "已测题目不足全部题目的 60%，IQ 仅供参考";
  metadata.append(runtime, effortCount, coverageNote);
  identity.append(nameLine, metadata);
  const score = element("strong", "model-score");
  const sample = element("span", "sample");
  const delta = element("span", "delta");
  const chevron = element("span", "chevron", "›");
  chevron.setAttribute("aria-hidden", "true");
  summary.append(identity, score, sample, delta, chevron);

  const content = element("div", "effort-content");
  const table = element("table", "effort-table");
  const caption = element("caption", "sr-only");
  const head = document.createElement("thead");
  const heading = document.createElement("tr");
  for (const label of ["思考等级", "IQ", "样本", "较上次"]) {
    const cell = element("th", "", label);
    cell.scope = "col";
    heading.append(cell);
  }
  head.append(heading);
  const body = document.createElement("tbody");
  table.append(caption, head, body);
  const noEfforts = element("p", "no-efforts", "源站尚未提供思考等级数据");
  content.append(table, noEfforts);
  row.append(summary, content);
  return { row, summary, name, status, runtime, effortCount, coverageNote, score, sample, delta, table, caption, body, noEfforts };
}

function renderSample(container, sample) {
  const count = element("span", "sample-count", formatSample(sample));
  const coverage = element("span", "coverage-count", `${sample.sampledTaskCount} / ${currentState.snapshot.taskCount} 题`);
  coverage.hidden = !isNumber(sample.sampledTaskCount);
  container.replaceChildren(count, coverage);
  container.title = `原始 ${numberFormatter.format(sample.rawSamples)} 次 · 加权 ${numberFormatter.format(sample.weightedSamples)} · 已测 ${sample.sampledTaskCount} / ${currentState.snapshot.taskCount} 题`;
}

function updateModelRow(view, model, previous) {
  view.model = model;
  view.previous = previous;
  view.name.textContent = model.label;
  view.name.title = model.modelId;
  view.status.textContent = model.statusLabel;
  view.status.hidden = !model.statusLabel;
  view.runtime.textContent = model.runtimeLabel;
  view.effortCount.textContent = `${model.efforts.length} 个等级`;
  view.coverageNote.hidden = !hasLowCoverage(model.sampledTaskCount, currentState.snapshot.taskCount);
  view.score.textContent = isNumber(model.iq) ? numberFormatter.format(model.iq) : "—";
  view.score.classList.toggle("missing", !isNumber(model.iq));
  renderSample(view.sample, model);
  renderDelta(view.delta, valueDelta(previous?.iq, model.iq));
  view.summary.setAttribute("aria-label", `${model.label}，${model.runtimeLabel}${model.statusLabel ? `，${model.statusLabel}` : ""}，总体 ${view.score.textContent} IQ，${view.sample.textContent}，较上次${view.delta.textContent}。展开查看思考等级`);
  view.caption.textContent = `${model.label}（${model.runtimeLabel}）的思考等级 IQ`;
  view.table.hidden = model.efforts.length === 0;
  view.noEfforts.hidden = model.efforts.length > 0;

  const previousEfforts = effortMap(previous);
  view.body.replaceChildren(...model.efforts.map((effort) => {
    const row = document.createElement("tr");
    const name = element("th", "effort-name", effort.effort);
    name.scope = "row";
    const score = element("td", isNumber(effort.iq) ? "effort-score" : "missing", isNumber(effort.iq) ? numberFormatter.format(effort.iq) : "—");
    const sample = element("td", "sample");
    renderSample(sample, effort);
    const delta = element("td", "delta");
    renderDelta(delta, valueDelta(previousEfforts.get(effort.effort)?.iq, effort.iq));
    row.append(name, score, sample, delta);
    return row;
  }));
}

function updateRuntimeFilter(models) {
  const options = runtimeOptions(models);
  const definitions = [
    { value: "", label: `全部运行工具 · ${models.length}` },
    ...options.map((option) => ({ value: option.value, label: `${option.label} · ${option.count}` })),
  ];
  const previousValue = runtimeFilter.value;
  definitions.forEach((definition, index) => {
    const option = runtimeFilter.options[index] ?? runtimeFilter.appendChild(document.createElement("option"));
    option.value = definition.value;
    option.textContent = definition.label;
  });
  while (runtimeFilter.options.length > definitions.length) {
    runtimeFilter.remove(runtimeFilter.options.length - 1);
  }
  runtimeFilter.value = options.some((option) => option.value === previousValue) ? previousValue : "";
}

function renderEmptyState(visibleCount) {
  emptyState.hidden = visibleCount > 0;
  if (visibleCount) return;
  const snapshot = currentState?.snapshot;
  const hasModels = snapshot?.models.length > 0;
  const loading = ["loading", "refreshing"].includes(currentState?.status);
  clearFilters.hidden = !hasModels;
  if (hasModels) {
    emptyTitle.textContent = "没有匹配的模型";
    emptyDescription.textContent = "试试其他关键词，或清空筛选查看全部模型。";
  } else if (loading) {
    emptyTitle.textContent = "正在获取模型数据…";
    emptyDescription.textContent = "首次获取可能需要几秒钟。";
  } else if (currentState?.error) {
    emptyTitle.textContent = "暂时无法获取模型数据";
    emptyDescription.textContent = "请点击右上角刷新重试。";
  } else if (snapshot) {
    emptyTitle.textContent = "源站暂未提供模型数据";
    emptyDescription.textContent = "下次刷新时会自动检查新增模型。";
  } else {
    emptyTitle.textContent = "正在读取模型数据…";
    emptyDescription.textContent = "稍后即可查看所有模型的最新 IQ。";
  }
}

function renderModels({ updateData = false, resetScroll = false } = {}) {
  const models = currentState?.snapshot?.models ?? [];
  const previousModels = modelMap(currentState?.previousSnapshot);
  const visible = selectModels(models, {
    query: modelSearch.value,
    runtime: runtimeFilter.value,
    sort: modelSort.value,
  });
  const visibleIds = new Set(visible.map((model) => model.id));
  const currentIds = new Set(models.map((model) => model.id));
  const focused = document.activeElement;
  const scrollTop = modelScroll.scrollTop;

  for (const [id, view] of modelRows) {
    if (!currentIds.has(id)) {
      view.row.remove();
      modelRows.delete(id);
    } else {
      view.row.hidden = !visibleIds.has(id);
    }
  }

  visible.forEach((model, index) => {
    let view = modelRows.get(model.id);
    const isNew = !view;
    if (isNew) {
      view = createModelRow(model);
      modelRows.set(model.id, view);
    }
    const previous = previousModels.get(model.id);
    if (updateData || isNew || view.model !== model || view.previous !== previous) {
      updateModelRow(view, model, previous);
    }
    view.row.hidden = false;
    if (modelList.children[index] !== view.row) modelList.insertBefore(view.row, modelList.children[index] ?? null);
  });

  if (focused instanceof HTMLElement && focused.isConnected && !focused.closest("[hidden]") && document.activeElement !== focused) {
    focused.focus({ preventScroll: true });
  }
  modelScroll.scrollTop = resetScroll ? 0 : scrollTop;
  resultCount.textContent = `${visible.length} / ${models.length} 个模型`;
  resultsStatus.textContent = `显示 ${visible.length} 个模型，共 ${models.length} 个`;
  renderEmptyState(visible.length);
}

function renderMetadata(snapshot) {
  if (!snapshot) {
    datasetMeta.textContent = "";
    sourceTime.textContent = "尚未获取数据";
    return;
  }

  datasetMeta.textContent = `${snapshot.models.length} 模型 · ${runtimeOptions(snapshot.models).length} 运行工具 · ${snapshot.taskCount} 任务`;
  const source = snapshot.sourceUpdatedAt
    ? `站点快照 ${formatDateTime(snapshot.sourceUpdatedAt)}`
    : "站点快照时间未知";
  sourceTime.textContent = `${source} · 本地获取 ${formatDateTime(snapshot.fetchedAt)}`;
}

function renderState(state) {
  currentState = state;
  renderStatus(state);
  renderError(state);
  const nextData = JSON.stringify([state?.snapshot, state?.previousSnapshot]);
  if (nextData !== renderedData) {
    renderedData = nextData;
    updateRuntimeFilter(state?.snapshot?.models ?? []);
    renderModels({ updateData: true });
  } else {
    renderEmptyState(selectModels(state?.snapshot?.models ?? [], {
      query: modelSearch.value,
      runtime: runtimeFilter.value,
      sort: modelSort.value,
    }).length);
  }
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
  renderState({
    ...currentState,
    status: currentState?.snapshot ? "refreshing" : "loading",
    error: null,
  });
  try {
    const response = await sendMessage({ type: "REFRESH_NOW" });
    renderState(response.state);
  } catch (error) {
    renderState({ ...currentState, status: "error", error: error.message });
  } finally {
    refreshButton.disabled = false;
    refreshButton.classList.remove("loading");
  }
}

async function initialize() {
  renderState({ status: "loading", snapshot: null, previousSnapshot: null });
  try {
    const response = await sendMessage({ type: "GET_STATE" });
    renderSettings(response.settings);
    renderState(response.state);

    if (!response.state?.snapshot && response.state?.status !== "loading") {
      await refreshNow();
    }
    void sendMessage({ type: "MARK_SEEN" }).catch(() => {});
  } catch (error) {
    renderState({ ...currentState, status: "error", error: error.message });
    statusText.textContent = "扩展后台不可用";
  }
}

themeButton.addEventListener("click", () => {
  void cycleTheme();
});
refreshButton.addEventListener("click", refreshNow);
modelSearch.addEventListener("input", () => renderModels({ resetScroll: true }));
runtimeFilter.addEventListener("change", () => renderModels({ resetScroll: true }));
modelSort.addEventListener("change", () => renderModels({ resetScroll: true }));
clearFilters.addEventListener("click", () => {
  modelSearch.value = "";
  runtimeFilter.value = "";
  renderModels({ resetScroll: true });
  modelSearch.focus();
});
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

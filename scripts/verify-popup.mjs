import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { buildSnapshot, STATE_KEY } from "../src/radar.js";
import { providerGroups } from "../src/view.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = await realpath(resolve(process.argv[2] || root));
const screenshotPath = process.argv[3] ? resolve(process.argv[3]) : null;
const manifest = JSON.parse(await readFile(resolve(extensionPath, "manifest.json"), "utf8"));
const session = `radar-popup-${process.pid}`;

function browser(args, input) {
  return execFileSync("agent-browser", ["--session", session, ...args], {
    encoding: "utf8",
    input,
    timeout: 35_000,
  }).trim();
}

function evaluate(expression) {
  return JSON.parse(browser(["eval", "--stdin"], expression));
}

function inPopup(callback, argument) {
  return evaluate(`(${callback})(chrome.extension.getViews({ type: "popup" })[0], ${JSON.stringify(argument ?? null)})`);
}

async function waitFor(callback, description, argument) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = inPopup(callback, argument);
    if (result) return result;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${description}: ${inPopup((view) => view?.document.body.innerText)}`);
}

function measure(view) {
  const doc = view.document;
  const list = doc.querySelector("#model-scroll");
  return {
    width: view.innerWidth,
    height: view.innerHeight,
    listHeight: list.clientHeight,
    documentOverflow: doc.documentElement.scrollWidth - doc.documentElement.clientWidth,
    listOverflow: list.scrollWidth - list.clientWidth,
    modelCount: doc.querySelectorAll(".model-row:not([hidden])").length,
  };
}

function assertLayout(layout) {
  assert.equal(layout.width, 720, "toolbar popup must naturally open at 720px wide");
  assert.equal(layout.height, 600, "toolbar popup must naturally open at 600px high");
  assert.ok(layout.listHeight >= 250, `model list must have usable height, got ${layout.listHeight}px`);
  assert.ok(layout.documentOverflow <= 1, "popup must not overflow horizontally");
  assert.ok(layout.listOverflow <= 1, "model list must not overflow horizontally");
}

async function popupCommand(target, method, params) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  try {
    return await new Promise((resolveResult, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Popup ${method} timed out`)), 10_000);
      socket.addEventListener("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ id: 1, method, params }));
      });
      socket.addEventListener("message", ({ data: message }) => {
        const response = JSON.parse(message);
        if (response.id !== 1) return;
        clearTimeout(timeout);
        if (response.error) reject(new Error(response.error.message));
        else resolveResult(response.result);
      });
    });
  } finally {
    socket.close();
  }
}

async function capturePopup(target, outputPath = screenshotPath) {
  const { data } = await popupCommand(target, "Page.captureScreenshot", { format: "png" });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.from(data, "base64"));
  console.log(`Toolbar popup screenshot: ${outputPath}`);
}

function screenshotVariant(suffix) {
  return `${screenshotPath.slice(0, screenshotPath.length - extname(screenshotPath).length)}-${suffix}.png`;
}

async function assertProviderIcons() {
  const icons = inPopup((view) => {
    const doc = view.document;
    const entries = [
      ...[...doc.querySelectorAll("#provider-nav button")].map((element) => ({ element, provider: element.dataset.provider || "all", location: "navigation" })),
      ...[...doc.querySelectorAll(".provider-group-heading")].map((element) => ({ element, provider: element.closest(".provider-group").dataset.provider, location: "group heading" })),
    ];
    return entries.map(({ element, provider, location }) => {
      const icon = element.querySelector(".provider-icon");
      const image = icon?.querySelector("img");
      const box = icon?.getBoundingClientRect();
      return {
        provider, location,
        exists: Boolean(icon),
        hiddenFromReader: icon?.getAttribute("aria-hidden") === "true" && image?.getAttribute("alt") === "",
        source: image?.currentSrc,
        loaded: Boolean(image?.complete && image.naturalWidth > 0),
        width: box?.width,
        height: box?.height,
      };
    });
  });
  assert.ok(icons.length > 0, "provider navigation and headings must have icons");
  for (const icon of icons) {
    const label = `${icon.provider} ${icon.location}`;
    assert.equal(icon.exists, true, `${label} must contain a provider icon`);
    assert.equal(icon.hiddenFromReader, true, `${label} icon must not repeat the provider name to screen readers`);
    assert.equal(icon.loaded, true, `${label} SVG must load successfully`);
    const source = new URL(icon.source);
    assert.equal(source.protocol, "chrome-extension:", `${label} icon must be local`);
    assert.equal(source.pathname, `/icons/providers/${icon.provider}.svg`, `${label} must use its matching brand asset`);
    assert.ok(icon.width >= 16 && icon.height >= 16, `${label} icon must be visible at a usable size`);
    const svg = await readFile(resolve(extensionPath, `icons/providers/${icon.provider}.svg`), "utf8");
    assert.match(svg, /<svg\b/, `${label} asset must be an SVG`);
  }
}

function appearanceState(view) {
  const doc = view.document;
  const rgba = (color) => {
    const values = color.match(/[\d.]+/g).map(Number);
    return [values[0], values[1], values[2], values[3] ?? 1];
  };
  const over = (foreground, background) => foreground.slice(0, 3).map((channel, index) => channel * foreground[3] + background[index] * (1 - foreground[3]));
  const background = (element) => {
    const layers = [];
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      layers.push(rgba(view.getComputedStyle(ancestor).backgroundColor));
    }
    return layers.reverse().reduce((result, layer) => over(layer, result), [255, 255, 255]);
  };
  const selectors = [
    ".brand h1", "#status-text", ".section-heading h2", ".section-heading p", "#dataset-meta",
    "#provider-nav .provider-label", "#provider-nav .provider-count", ".sidebar-heading", ".list-heading > span",
    ".provider-group-name", ".provider-company", ".provider-group-count", ".model-name", ".runtime-badge",
    ".effort-count", ".coverage-note", ".model-score", ".sample-count", ".coverage-count", ".delta",
    ".effort-table th", ".effort-score", ".settings-panel > summary", "#source-time", "footer a",
    "#theme-label", "#refresh-button > span:last-child", "#runtime-filter", "#model-sort",
  ];
  const text = [...doc.querySelectorAll(selectors.join(","))]
    .filter((element) => element.getClientRects().length && !element.closest("[hidden]") && element.textContent.trim())
    .map((element) => {
      const style = view.getComputedStyle(element);
      const base = background(element);
      return { text: element.textContent.trim().slice(0, 60), selector: element.id || element.className || element.tagName, foreground: over(rgba(style.color), base), background: base };
    });
  const searchInput = doc.querySelector("#model-search");
  const searchBackground = background(searchInput);
  text.push({ text: searchInput.placeholder, selector: "model-search::placeholder", foreground: over(rgba(view.getComputedStyle(searchInput, "::placeholder").color), searchBackground), background: searchBackground });
  const nav = doc.querySelector("#provider-nav");
  const navBox = nav.getBoundingClientRect();
  const buttons = [...nav.querySelectorAll("button")].map((button) => {
    const box = button.getBoundingClientRect();
    return { provider: button.dataset.provider || "all", top: box.top, bottom: box.bottom, navTop: navBox.top, navBottom: navBox.bottom, fullyVisible: box.top >= navBox.top - 1 && box.bottom <= navBox.bottom + 1 && box.left >= navBox.left - 1 && box.right <= navBox.right + 1 };
  });
  const focused = doc.activeElement;
  const focusStyle = view.getComputedStyle(focused);
  const focusBackground = background(parseFloat(focusStyle.outlineOffset) < 0 ? focused : focused.parentElement || focused);
  return {
    text, buttons,
    focus: {
      inNavigation: Boolean(focused.closest("#provider-nav")),
      visible: focused.matches(":focus-visible"),
      width: parseFloat(focusStyle.outlineWidth),
      style: focusStyle.outlineStyle,
      foreground: over(rgba(focusStyle.outlineColor), focusBackground),
      background: focusBackground,
    },
  };
}

function contrastRatio(foreground, background) {
  const luminance = (color) => color.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }).reduce((result, value, index) => result + value * [0.2126, 0.7152, 0.0722][index], 0);
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function assertFocus(focus, label) {
  assert.equal(focus.inNavigation && focus.visible, true, `${label} keyboard focus must be visible in provider navigation`);
  assert.ok(focus.width >= 2 && focus.style !== "none", `${label} keyboard focus needs at least a 2px outline`);
  const ratio = contrastRatio(focus.foreground, focus.background);
  assert.ok(ratio >= 3, `${label} focus outline has insufficient contrast: ${ratio.toFixed(2)}:1`);
  return ratio;
}

async function assertAppearance(target, theme) {
  setTheme(theme);
  inPopup((view) => {
    view.document.querySelector('#provider-nav button[data-provider=""]').focus();
    return true;
  });
  const tab = { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 };
  await popupCommand(target, "Input.dispatchKeyEvent", { type: "keyDown", ...tab });
  await popupCommand(target, "Input.dispatchKeyEvent", { type: "keyUp", ...tab });
  const appearance = inPopup(appearanceState);
  const ratios = appearance.text.map((sample) => {
    const ratio = contrastRatio(sample.foreground, sample.background);
    assert.ok(ratio >= 4.5, `${theme} text ${sample.selector} (${sample.text}) has insufficient contrast: ${ratio.toFixed(2)}:1`);
    return ratio;
  });
  assert.ok(ratios.length > 0, "text contrast check must include rendered text");
  for (const button of appearance.buttons) assert.equal(button.fullyVisible, true, `${theme} ${button.provider} navigation must be fully visible (button ${button.top}–${button.bottom}, navigation ${button.navTop}–${button.navBottom})`);
  const focusRatios = [assertFocus(appearance.focus, `${theme} unselected`)];
  const selectedPoint = inPopup((view) => {
    const button = view.document.querySelector('#provider-nav button[aria-pressed="true"]');
    button.focus();
    const box = button.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
  focusRatios.push(assertFocus(inPopup(appearanceState).focus, `${theme} selected`));
  await popupCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", ...selectedPoint });
  focusRatios.push(assertFocus(inPopup(appearanceState).focus, `${theme} selected hover`));
  await popupCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 710, y: 70 });
  assertLayout(inPopup(measure));
  inPopup((view) => { view.document.activeElement.blur(); return true; });
  console.log(`${theme} appearance: ${ratios.length} text samples, minimum ${Math.min(...ratios).toFixed(2)}:1 contrast, ${appearance.buttons.length} navigation buttons visible, minimum focus ${Math.min(...focusRatios).toFixed(2)}:1 across unselected/selected/hover states.`);
}
function providerState(view) {
  const doc = view.document;
  return {
    selected: [...doc.querySelectorAll('#provider-nav button[aria-pressed="true"]')].map((button) => button.dataset.provider),
    groups: [...doc.querySelectorAll("#model-list > .provider-group")].map((group) => ({
      provider: group.dataset.provider,
      hidden: group.hidden,
      rows: [...group.querySelectorAll(".model-row")].map((row) => ({
        id: row.dataset.model,
        hidden: row.hidden,
        name: row.querySelector(".model-name").textContent,
      })),
    })),
  };
}

function selectProvider(provider) {
  assert.equal(inPopup((view, value) => {
    const button = [...view.document.querySelectorAll("#provider-nav button[data-provider]")]
      .find((candidate) => candidate.dataset.provider === value);
    if (!button) return false;
    button.click();
    return true;
  }, provider), true, `provider navigation must include ${provider || "all"}`);
}

function search(query) {
  inPopup((view, value) => {
    const input = view.document.querySelector("#model-search");
    input.value = value;
    input.dispatchEvent(new view.Event("input", { bubbles: true }));
    return true;
  }, query);
}

function assertVisibleModels(expected, provider) {
  const state = inPopup(providerState);
  assert.deepEqual(state.selected, [provider], "selected provider must remain visible in the navigation");
  const visibleIds = state.groups.flatMap((group) => group.rows.filter((row) => !row.hidden).map((row) => row.id));
  assert.deepEqual(visibleIds.sort(), expected.map(({ id }) => id).sort(), "visible records must match the selected source models");
  for (const group of state.groups) {
    assert.equal(group.hidden, group.rows.every((row) => row.hidden), "empty provider groups must be hidden");
    if (provider && !group.hidden) assert.equal(group.provider, provider, "selected view must not include another provider");
  }
  return state;
}

function sourceModels() {
  const response = evaluate('chrome.runtime.sendMessage({ type: "GET_STATE" })');
  assert.equal(response.ok, true);
  assert.equal(response.state.status, "ready", response.state.error || "source data must be ready");
  return response.state.snapshot.models;
}

function setTheme(mode) {
  assert.equal(inPopup((view, expected) => {
    const doc = view.document;
    for (let attempt = 0; attempt < 3 && doc.documentElement.dataset.themeMode !== expected; attempt += 1) {
      doc.querySelector("#theme-button").click();
    }
    return doc.documentElement.dataset.themeMode;
  }, mode), mode, "theme control must apply the requested appearance");
}

async function assertEffortCoverage(target) {
  const response = evaluate('chrome.runtime.sendMessage({ type: "GET_STATE" })');
  assert.equal(response.ok, true);
  const model = "gpt-6-sol";
  const values = [
    { effort: "low", score: 147.26, coverage: 3, samples: 7 },
    { effort: "medium", score: 0, coverage: 5, samples: 5 },
    { effort: "high", score: 140.125, coverage: 4, samples: 9 },
    { effort: "max", score: null, coverage: 0, samples: 0 },
    { effort: "ultra", score: 130.675, coverage: 2, samples: null },
  ];
  const binding = {
    enabled: true,
    production_read_verified: true,
    benchmark: "radar-bench-coverage-fixture",
    catalog_version: "coverage-catalog",
    task_set_sha256: "coverage-tasks",
    total_tasks: 5,
    score_version: "radar-bench-v2-150",
    score_max: 150,
    model_efforts: values.map(({ effort }) => ({ model, effort })),
  };
  const snapshot = buildSnapshot(binding, values.map((value) => ({
    benchmark: binding.benchmark,
    catalog_version: binding.catalog_version,
    task_set_sha256: binding.task_set_sha256,
    score_version: binding.score_version,
    score_max: binding.score_max,
    model,
    effort: value.effort,
    score: value.score,
    coverage: value.coverage,
    required_tasks: binding.total_tasks,
    score_status: value.coverage === 0 ? "missing_current_result"
      : value.coverage === binding.total_tasks ? "complete" : "provisional",
    graded_runs_count: value.samples,
  })));
  try {
    evaluate(`chrome.storage.local.set(${JSON.stringify({ [STATE_KEY]: {
      ...response.state, snapshot, previousSnapshot: null,
    } })}).then(() => true)`);
    await waitFor((view) => view.document.querySelectorAll(".model-row").length === 1 &&
      view.document.querySelectorAll(".effort-table tbody tr").length === 5, "coverage fixture");
    const coverage = inPopup((view) => {
      const doc = view.document;
      const row = doc.querySelector(".model-row");
      row.querySelector("summary").click();
      return {
        headline: {
          score: row.querySelector(".model-score").textContent,
          effort: row.querySelector(".effort-count").textContent,
          samples: row.querySelector("summary .sample-count").textContent,
          coverage: row.querySelector("summary .coverage-count").textContent,
          warning: row.querySelector(".model-meta .coverage-note").hidden
            ? null : row.querySelector(".model-meta .coverage-note").textContent,
        },
        efforts: [...row.querySelectorAll("tbody tr")].map((effort) => ({
          effort: effort.querySelector("th").textContent,
          iq: effort.children[1].textContent,
          warning: effort.querySelector(".coverage-note")?.textContent ?? null,
          samples: effort.querySelector(".sample-count").textContent,
          coverage: effort.querySelector(".coverage-count").textContent,
        })),
        metric: doc.querySelector(".section-heading p").textContent,
        ariaLabel: row.querySelector("summary").getAttribute("aria-label"),
        caption: row.querySelector("caption").textContent,
        obsoleteStatus: Boolean(doc.querySelector(".model-status")),
      };
    });
    assert.deepEqual(coverage.headline, {
      score: "147.3", effort: "最高分 · low", samples: "7 次", coverage: "3 / 5 题", warning: "阶段分",
    }, "headline score, samples and coverage must all come from its explicitly named highest-scoring effort");
    assert.deepEqual(coverage.efforts, [
      { effort: "low", iq: "147.3", warning: "阶段分", samples: "7 次", coverage: "3 / 5 题" },
      { effort: "medium", iq: "0", warning: null, samples: "5 次", coverage: "5 / 5 题" },
      { effort: "high", iq: "140.1", warning: "阶段分", samples: "9 次", coverage: "4 / 5 题" },
      { effort: "max", iq: "—", warning: "阶段分", samples: "待采样", coverage: "0 / 5 题" },
      { effort: "ultra", iq: "130.7", warning: "阶段分", samples: "样本数未知", coverage: "2 / 5 题" },
    ], "each effort must retain decimal precision, valid zero, missing scores and its own coverage/sample meaning");
    assert.match(coverage.metric, /雷达Bench.*最高分档位/);
    assert.match(coverage.ariaLabel, /雷达Bench.*最高分.*low/);
    assert.match(coverage.caption, /雷达Bench/);
    assert.doesNotMatch(coverage.caption, /DeepSWE/);
    assert.equal(coverage.obsoleteStatus, false);
    await assertAppearance(target, "light");
    if (screenshotPath) await capturePopup(target, screenshotVariant("coverage-light"));

    const oldSnapshot = { ...snapshot, version: 2, benchmarkId: "deep-swe", scoringMode: "binary-majority" };
    delete oldSnapshot.taskSetHash;
    evaluate(`chrome.storage.local.set(${JSON.stringify({ [STATE_KEY]: {
      ...response.state, snapshot: oldSnapshot, previousSnapshot: null,
    } })}).then(() => true)`);
    await waitFor((view) => view.document.querySelectorAll(".model-row").length === 0 &&
      !view.document.querySelector("#empty-state").hidden, "old DeepSWE cache isolation");
    assert.equal(inPopup((view) => view.document.querySelector("#dataset-meta").textContent), "",
      "an old DeepSWE cache must not be labeled as Radar Bench data");
  } finally {
    evaluate(`chrome.storage.local.set(${JSON.stringify({ [STATE_KEY]: response.state })}).then(() => true)`);
    await waitFor((view, count) => view.document.querySelectorAll(".model-row").length === count,
      "restored live snapshot", response.state.snapshot.models.length);
  }
  console.log("Passed: highest-effort headline with matching samples/coverage, decimals, valid zero, null score, unknown samples, provisional scores, and old DeepSWE cache isolation.");
}

try {
  browser(["--headed", "--extension", extensionPath, "open", "chrome://extensions/"]);
  const extensionId = evaluate(`(() => {
    const list = document.querySelector("extensions-manager").shadowRoot
      .querySelector("extensions-item-list").shadowRoot;
    return [...list.querySelectorAll("extensions-item")]
      .find((item) => item.data.path === ${JSON.stringify(extensionPath)})?.id;
  })()`);
  assert.ok(extensionId, `extension was not loaded from ${extensionPath}`);
  const popupUrl = `chrome-extension://${extensionId}/${manifest.action.default_popup}`;

  // This tab only calls the extension API. All measurements and interactions use
  // the separate toolbar popup; never set a viewport to make the layout pass.
  browser(["open", popupUrl]);
  const endpoint = new URL(browser(["get", "cdp-url"]));
  const targets = async () => {
    const response = await fetch(`http://${endpoint.host}/json/list`);
    assert.ok(response.ok, `Chrome target discovery returned ${response.status}`);
    return response.json();
  };
  const originalTargets = new Set((await targets()).map(({ id }) => id));
  evaluate("chrome.action.openPopup().then(() => true)");
  await waitFor((view) => Boolean(view?.document.querySelector("#model-scroll")), "toolbar popup");
  const layout = inPopup(measure);
  console.log(`Toolbar popup v${manifest.version}: ${JSON.stringify(layout)}`);
  const popup = (await targets()).find(({ id, url }) => url === popupUrl && !originalTargets.has(id));
  assert.ok(popup, "separate toolbar popup target must exist");
  try {
    assertLayout(layout);
  } catch (error) {
    if (screenshotPath) await capturePopup(popup);
    throw error;
  }

  await waitFor((view) => view.document.querySelectorAll(".model-row").length > 0, "live model data");
  await assertEffortCoverage(popup);
  let models = sourceModels();
  const initial = inPopup(measure);
  assertLayout(initial);
  assert.equal(initial.modelCount, models.length, "UI must show every source model");
  const all = assertVisibleModels(models, "");
  const allIds = all.groups.flatMap((group) => group.rows.map(({ id }) => id));
  assert.equal(new Set(allIds).size, allIds.length, "a source record must not be duplicated across providers");
  for (const expected of providerGroups(models)) {
    const group = all.groups.find((candidate) => candidate.provider === expected.id);
    assert.ok(group, `all view must contain a ${expected.id} group`);
    assert.deepEqual(group.rows.map(({ id }) => id).sort(), expected.models.map(({ id }) => id).sort(),
      `${expected.id} group must contain exactly its source models`);
  }
  await waitFor((view) => [...view.document.querySelectorAll(".provider-icon img")].every((image) => image.complete), "provider SVG assets");
  await assertProviderIcons();
  await assertAppearance(popup, "dark");
  if (screenshotPath) await capturePopup(popup);
  await assertAppearance(popup, "light");
  if (screenshotPath) await capturePopup(popup, screenshotVariant("all-light"));

  const query = models[0].label;
  search(query);
  const searched = inPopup((view) => [...view.document.querySelectorAll(".model-row:not([hidden]) .model-name")].map((name) => name.textContent));
  assert.ok(searched.length > 0, "search must keep the matching model");
  assert.ok(searched.every((name) => name.toLowerCase().includes(query.toLowerCase())), "search must hide unrelated models");
  search("");
  assertVisibleModels(models, "");

  const selectedProvider = providerGroups(models)[0].id;
  const providerModels = () => providerGroups(models).find(({ id }) => id === selectedProvider)?.models ?? [];
  selectProvider(selectedProvider);
  assertVisibleModels(providerModels(), selectedProvider);
  inPopup((view) => { view.document.querySelector("#refresh-button").click(); return true; });
  assert.deepEqual(inPopup(providerState).selected, [selectedProvider], "refresh must keep the selected provider");
  await waitFor((view) => !view.document.querySelector("#refresh-button").disabled, "selected-provider refresh");
  models = sourceModels();
  assertVisibleModels(providerModels(), selectedProvider);

  const expanded = inPopup((view) => {
    const row = view.document.querySelector(".model-row:not([hidden])");
    row.querySelector("summary").click();
    return { open: row.open, contentHeight: row.querySelector(".effort-content").getBoundingClientRect().height };
  });
  assert.equal(expanded.open, true, "model summary must expand");
  assert.ok(expanded.contentHeight > 0, "expanded model details must be visible");
  await assertAppearance(popup, "light");
  if (screenshotPath) {
    await capturePopup(popup, screenshotVariant(`${selectedProvider}-light`));
  }

  for (const group of providerGroups(models)) {
    selectProvider(group.id);
    assertVisibleModels(group.models, group.id);
  }
  selectProvider("");
  const groups = providerGroups(models);
  for (const group of groups) {
    const alias = group.company || group.label;
    search(alias);
    const expected = groups.filter((candidate) =>
      [candidate.label, candidate.company, ...candidate.aliases]
        .some((name) => name.toLocaleLowerCase().includes(alias.toLocaleLowerCase())))
      .flatMap(({ models: entries }) => entries);
    assertVisibleModels(expected, "");
  }
  search("");
  const beforeSort = inPopup(providerState).groups.map(({ provider }) => provider);
  inPopup((view) => {
    const sort = view.document.querySelector("#model-sort");
    sort.value = "name";
    sort.dispatchEvent(new view.Event("change", { bubbles: true }));
    return true;
  });
  const sorted = assertVisibleModels(models, "");
  assert.deepEqual(sorted.groups.map(({ provider }) => provider), beforeSort, "sorting must retain provider groups and their order");
  for (const group of sorted.groups) {
    const names = group.rows.filter((row) => !row.hidden).map(({ name }) => name);
    assert.deepEqual(names, [...names].sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true, sensitivity: "base" })), "name sorting must apply within each provider");
  }

  selectProvider(selectedProvider);
  search("__radar_popup_no_matching_model__");
  assertVisibleModels([], selectedProvider);
  assert.equal(inPopup((view) => !view.document.querySelector("#empty-state").hidden && !view.document.querySelector("#clear-filters").hidden), true, "empty results must provide a clear action");
  const clearedQuery = inPopup((view) => {
    view.document.querySelector("#clear-filters").click();
    return view.document.querySelector("#model-search").value;
  });
  assert.equal(clearedQuery, "", "clear action must remove the search query");
  assertVisibleModels(models, "");
  assertLayout(inPopup(measure));
  console.log(`Passed: natural 720×600 toolbar popup, ${models.length} source models, Radar Bench highest-effort labels and coverage, local accessible brand icons, theme contrast/focus, provider groups/navigation, refresh retention, provider aliases, group sorting, empty-result reset, expand, and no horizontal overflow.`);
} finally {
  browser(["close"]);
}

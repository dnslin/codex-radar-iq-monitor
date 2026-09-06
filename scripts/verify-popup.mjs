import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

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

async function waitFor(callback, description) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = inPopup(callback);
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

async function capturePopup(target, outputPath = screenshotPath) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  try {
    const data = await new Promise((resolveImage, reject) => {
      const timeout = setTimeout(() => reject(new Error("Popup screenshot timed out")), 10_000);
      socket.addEventListener("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ id: 1, method: "Page.captureScreenshot", params: { format: "png" } }));
      });
      socket.addEventListener("message", ({ data: message }) => {
        const response = JSON.parse(message);
        if (response.id !== 1) return;
        clearTimeout(timeout);
        if (response.error) reject(new Error(response.error.message));
        else resolveImage(response.result.data);
      });
    });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(data, "base64"));
    console.log(`Toolbar popup screenshot: ${outputPath}`);
  } finally {
    socket.close();
  }
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
  let models = sourceModels();
  const initial = inPopup(measure);
  assertLayout(initial);
  assert.equal(initial.modelCount, models.length, "UI must show every source model");
  const all = assertVisibleModels(models, "");
  const allIds = all.groups.flatMap((group) => group.rows.map(({ id }) => id));
  assert.equal(new Set(allIds).size, allIds.length, "a source record must not be duplicated across providers");
  for (const [provider, name] of [["deepseek", /deepseek/i], ["anthropic", /claude/i]]) {
    const expected = models.filter((model) => name.test(model.label));
    assert.ok(expected.length > 0, `live snapshot must contain ${provider} records for this check`);
    const group = all.groups.find((candidate) => candidate.provider === provider);
    assert.ok(group, `all view must contain a ${provider} group`);
    assert.deepEqual(group.rows.map(({ id }) => id).sort(), expected.map(({ id }) => id).sort(), `${provider} group must contain its models across all runtimes only`);
  }
  setTheme("dark");
  if (screenshotPath) await capturePopup(popup);

  const query = models[0].label;
  search(query);
  const searched = inPopup((view) => [...view.document.querySelectorAll(".model-row:not([hidden]) .model-name")].map((name) => name.textContent));
  assert.ok(searched.length > 0, "search must keep the matching model");
  assert.ok(searched.every((name) => name.toLowerCase().includes(query.toLowerCase())), "search must hide unrelated models");
  search("");
  assertVisibleModels(models, "");

  selectProvider("deepseek");
  assertVisibleModels(models.filter(({ label }) => /deepseek/i.test(label)), "deepseek");
  inPopup((view) => { view.document.querySelector("#refresh-button").click(); return true; });
  assert.deepEqual(inPopup(providerState).selected, ["deepseek"], "refresh must keep the selected provider");
  await waitFor((view) => !view.document.querySelector("#refresh-button").disabled, "selected-provider refresh");
  models = sourceModels();
  assertVisibleModels(models.filter(({ label }) => /deepseek/i.test(label)), "deepseek");

  const expanded = inPopup((view) => {
    const row = view.document.querySelector(".model-row:not([hidden])");
    row.querySelector("summary").click();
    return { open: row.open, contentHeight: row.querySelector(".effort-content").getBoundingClientRect().height };
  });
  assert.equal(expanded.open, true, "model summary must expand");
  assert.ok(expanded.contentHeight > 0, "expanded model details must be visible");
  setTheme("light");
  assertLayout(inPopup(measure));
  if (screenshotPath) {
    const detailPath = `${screenshotPath.slice(0, screenshotPath.length - extname(screenshotPath).length)}-deepseek-light.png`;
    await capturePopup(popup, detailPath);
  }

  selectProvider("anthropic");
  assertVisibleModels(models.filter(({ label }) => /claude/i.test(label)), "anthropic");
  selectProvider("");
  for (const [alias, pattern] of [["Anthropic", /claude/i], ["深度求索", /deepseek/i]]) {
    search(alias);
    assertVisibleModels(models.filter(({ label }) => pattern.test(label)), "");
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

  selectProvider("deepseek");
  search("__radar_popup_no_matching_model__");
  assertVisibleModels([], "deepseek");
  assert.equal(inPopup((view) => !view.document.querySelector("#empty-state").hidden && !view.document.querySelector("#clear-filters").hidden), true, "empty results must provide a clear action");
  const clearedQuery = inPopup((view) => {
    view.document.querySelector("#clear-filters").click();
    return view.document.querySelector("#model-search").value;
  });
  assert.equal(clearedQuery, "", "clear action must remove the search query");
  assertVisibleModels(models, "");
  assertLayout(inPopup(measure));
  console.log(`Passed: natural 720×600 toolbar popup, ${models.length} source models, provider groups/navigation, refresh retention, provider aliases, group sorting, empty-result reset, themes, expand, and no horizontal overflow.`);
} finally {
  browser(["close"]);
}

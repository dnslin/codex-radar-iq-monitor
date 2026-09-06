import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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

function inPopup(callback) {
  return evaluate(`(${callback})(chrome.extension.getViews({ type: "popup" })[0])`);
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

async function capturePopup(target) {
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
    await mkdir(dirname(screenshotPath), { recursive: true });
    await writeFile(screenshotPath, Buffer.from(data, "base64"));
    console.log(`Toolbar popup screenshot: ${screenshotPath}`);
  } finally {
    socket.close();
  }
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
  const response = evaluate('chrome.runtime.sendMessage({ type: "GET_STATE" })');
  assert.equal(response.ok, true);
  assert.equal(response.state.status, "ready", response.state.error || "source data must be ready");
  const initial = inPopup(measure);
  assertLayout(initial);
  assert.equal(initial.modelCount, response.state.snapshot.models.length, "UI must show every source model");
  if (screenshotPath) await capturePopup(popup);

  const searched = inPopup((view) => {
    const doc = view.document;
    const query = doc.querySelector(".model-name").textContent;
    const input = doc.querySelector("#model-search");
    input.value = query;
    input.dispatchEvent(new view.Event("input", { bubbles: true }));
    const names = [...doc.querySelectorAll(".model-row:not([hidden]) .model-name")].map((name) => name.textContent);
    return { query, names };
  });
  assert.ok(searched.names.length > 0, "search must keep the matching model");
  assert.ok(searched.names.every((name) => name.toLowerCase().includes(searched.query.toLowerCase())), "search must hide unrelated models");

  const clearedCount = inPopup((view) => {
    const input = view.document.querySelector("#model-search");
    input.value = "";
    input.dispatchEvent(new view.Event("input", { bubbles: true }));
    return view.document.querySelectorAll(".model-row:not([hidden])").length;
  });
  assert.equal(clearedCount, initial.modelCount, "clearing search must restore all models");

  const expanded = inPopup((view) => {
    const row = view.document.querySelector(".model-row:not([hidden])");
    row.querySelector("summary").click();
    return { open: row.open, contentHeight: row.querySelector(".effort-content").getBoundingClientRect().height };
  });
  assert.equal(expanded.open, true, "model summary must expand");
  assert.ok(expanded.contentHeight > 0, "expanded model details must be visible");
  assertLayout(inPopup(measure));
  console.log(`Passed: natural 720×600 toolbar popup, ${initial.modelCount} source models, search, clear, expand, and no horizontal overflow.`);
} finally {
  browser(["close"]);
}

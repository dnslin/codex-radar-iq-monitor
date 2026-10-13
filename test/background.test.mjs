import assert from "node:assert/strict";
import test from "node:test";
import {
  ALARM_NAME,
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  STATE_KEY,
} from "../src/radar.js";
import { THEME_KEY } from "../src/theme.js";

let moduleNumber = 0;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const binding = {
  enabled: true,
  production_read_verified: true,
  benchmark: "radar-bench-final64-20261004",
  catalog_version: "catalog",
  task_set_sha256: "tasks",
  total_tasks: 64,
  score_version: "radar-bench-v2-150",
  score_max: 150,
  model_efforts: [{ model: "test-model", effort: "high" }],
};

function summary(iq) {
  return {
    benchmark: binding.benchmark,
    catalog_version: binding.catalog_version,
    task_set_sha256: binding.task_set_sha256,
    score_version: binding.score_version,
    score_max: 150,
    model: "test-model",
    effort: "high",
    score: iq,
    coverage: 1,
    required_tasks: 64,
    score_status: "provisional",
    graded_runs_count: 1,
  };
}

function snapshot(iq = 100) {
  return {
    version: 3,
    benchmarkId: binding.benchmark,
    scoringMode: binding.score_version,
    taskSetHash: binding.task_set_sha256,
    taskCount: 64,
    fetchedAt: "2026-10-02T00:00:00Z",
    models: [{
      id: "test-model",
      modelId: "test-model",
      label: "test-model",
      runtime: "codex",
      runtimeLabel: "Codex",
      iq,
      efforts: [{ effort: "high", iq }],
    }],
  };
}

async function background(t, {
  unreadCount = 3,
  settings = DEFAULT_SETTINGS,
  initialSnapshot = snapshot(),
  recentChanges = [],
} = {}) {
  const store = {
    [STATE_KEY]: {
      status: "ready",
      snapshot: initialSnapshot,
      previousSnapshot: null,
      recentChanges,
      unreadCount,
      lastSuccessAt: initialSnapshot.fetchedAt,
    },
    [SETTINGS_KEY]: structuredClone(settings),
    [THEME_KEY]: "dark",
  };
  const fetchStarted = deferred();
  const fetchResponse = deferred();
  const listeners = {};
  const notifications = new Map();
  const notificationHistory = [];
  const alarms = new Map();
  let badge = "";
  const fetchCounts = { binding: 0, summary: 0 };
  let stateWriteGate = null;
  let stateWriteError = null;
  const releases = [];
  const savedChrome = globalThis.chrome;
  const savedFetch = globalThis.fetch;
  const event = (name) => ({ addListener(listener) { listeners[name] = listener; } });

  globalThis.chrome = {
    storage: { local: {
      async get(keys) {
        return Object.fromEntries((typeof keys === "string" ? [keys] : keys)
          .filter((key) => key in store)
          .map((key) => [key, structuredClone(store[key])]));
      },
      async set(values) {
        const copied = structuredClone(values);
        if (copied[STATE_KEY] && stateWriteError) {
          const error = stateWriteError;
          stateWriteError = null;
          throw error;
        }
        if (stateWriteGate?.matches(copied[STATE_KEY])) {
          const gate = stateWriteGate;
          stateWriteGate = null;
          gate.entered.resolve();
          await gate.released.promise;
        }
        Object.assign(store, copied);
      },
    } },
    action: {
      async setBadgeText({ text }) { badge = text; },
      async setBadgeBackgroundColor() {},
    },
    alarms: {
      async clear(name) { return alarms.delete(name); },
      async create(name, alarm) { alarms.set(name, alarm); },
      onAlarm: event("alarm"),
    },
    notifications: {
      async create(id, value) {
        notificationHistory.push({ id, ...value });
        notifications.set(id, value);
      },
      async clear(id) { return notifications.delete(id); },
    },
    runtime: {
      getURL(path) { return `chrome-extension://test/${path}`; },
      onInstalled: event("installed"),
      onStartup: event("startup"),
      onMessage: event("message"),
    },
  };
  globalThis.fetch = async (url) => {
    if (url === "https://codexradar.com/data/radar-bench-binding.json") {
      fetchCounts.binding += 1;
      return { ok: true, json: async () => structuredClone(binding) };
    }
    assert.equal(url, "https://codexradar.com/api/radar-bench-score?model=test-model&effort=high&view=summary");
    fetchCounts.summary += 1;
    fetchStarted.resolve();
    return fetchResponse.promise;
  };
  t.after(() => {
    for (const release of releases) release();
    globalThis.chrome = savedChrome;
    globalThis.fetch = savedFetch;
  });

  const url = new URL("../src/background.js", import.meta.url);
  url.searchParams.set("test", String(++moduleNumber));
  await import(url.href);

  const message = (value) => new Promise((resolve) => {
    assert.equal(listeners.message(value, {}, resolve), true);
  });

  return {
    initialSnapshot,
    notificationHistory,
    notifications,
    alarms,
    message,
    badge: () => badge,
    fetchCounts: () => ({ ...fetchCounts }),
    preferences: () => ({ settings: store[SETTINGS_KEY], theme: store[THEME_KEY] }),
    getState: async () => (await message({ type: "GET_STATE" })).state,
    async refresh() {
      listeners.alarm({ name: ALARM_NAME });
      await fetchStarted.promise;
      return { result: message({ type: "REFRESH_NOW" }) };
    },
    complete(iq = 100) {
      fetchResponse.resolve({ ok: true, json: async () => summary(iq) });
    },
    fail() {
      fetchResponse.resolve({ ok: false, status: 503 });
    },
    pauseStateWrite(matches) {
      const entered = deferred();
      const released = deferred();
      stateWriteGate = { matches, entered, released };
      releases.push(released.resolve);
      return { entered: entered.promise, release: released.resolve };
    },
    failNextStateWrite(error) { stateWriteError = error; },
  };
}

test("a refreshed Radar Bench snapshot replaces the old DeepSWE notification baseline", async (t) => {
  const oldSnapshot = {
    ...snapshot(),
    version: 2,
    benchmarkId: "deep-swe",
    scoringMode: "binary-majority",
  };
  delete oldSnapshot.taskSetHash;
  const settings = { ...DEFAULT_SETTINGS, refreshMinutes: 30 };
  const h = await background(t, {
    initialSnapshot: oldSnapshot,
    unreadCount: 7,
    recentChanges: [{ modelId: "removed-model", kind: "changed" }],
    settings,
  });
  h.notifications.set("codex-radar-iq-change", { message: "Old DeepSWE change" });

  const refresh = await h.refresh();
  h.complete(103);
  assert.equal((await refresh.result).ok, true);

  const state = await h.getState();
  assert.equal(state.snapshot.version, 3);
  assert.equal(state.snapshot.models[0].iq, 103);
  assert.equal(state.previousSnapshot, null);
  assert.deepEqual(state.recentChanges, []);
  assert.equal(state.unreadCount, 0);
  assert.equal(h.badge(), "");
  assert.equal(h.notificationHistory.length, 0);
  assert.equal(h.notifications.size, 0);
  assert.deepEqual(h.preferences(), { settings, theme: "dark" });
});

test("successful refresh preserves MARK_SEEN while the API request is pending", async (t) => {
  const h = await background(t);
  const refresh = await h.refresh();
  const seen = await h.message({ type: "MARK_SEEN" });
  assert.equal(seen.state.unreadCount, 0, "MARK_SEEN must complete before the network response");

  h.complete();
  assert.equal((await refresh.result).ok, true);
  const state = await h.getState();
  assert.equal(state.unreadCount, 0);
  assert.equal(h.badge(), "");
  assert.deepEqual(state.recentChanges, []);
});

test("failed refresh preserves the acknowledged unread count and cached snapshot", async (t) => {
  const h = await background(t);
  const refresh = await h.refresh();
  await h.message({ type: "MARK_SEEN" });

  h.fail();
  assert.deepEqual(await refresh.result, { ok: false, error: "Radar API test-model high request failed: HTTP 503" });
  const state = await h.getState();
  assert.equal(state.status, "error");
  assert.equal(state.error, "Radar API test-model high request failed: HTTP 503");
  assert.deepEqual(state.snapshot, h.initialSnapshot);
  assert.equal(state.unreadCount, 0);
  assert.equal(h.badge(), "");
});

test("refresh adds only new changed models after MARK_SEEN", async (t) => {
  const h = await background(t);
  const refresh = await h.refresh();
  await h.message({ type: "MARK_SEEN" });

  h.complete(103);
  await refresh.result;
  const state = await h.getState();
  assert.equal(state.snapshot.models[0].iq, 103);
  assert.equal(state.unreadCount, 1);
  assert.equal(h.badge(), "1");
  assert.equal(h.notificationHistory.length, 1);
});

test("disabling notifications during refresh takes effect before its response", async (t) => {
  const h = await background(t, { unreadCount: 0 });
  const refresh = await h.refresh();
  const saved = await h.message({
    type: "SAVE_SETTINGS",
    settings: { ...DEFAULT_SETTINGS, notificationsEnabled: false, refreshMinutes: 30 },
  });
  assert.equal(saved.settings.notificationsEnabled, false);
  assert.equal(h.alarms.get(ALARM_NAME).periodInMinutes, 30);

  h.complete(103);
  await refresh.result;
  assert.equal(h.notificationHistory.length, 0);
  assert.equal(h.notifications.size, 0);
  assert.equal((await h.getState()).unreadCount, 1, "disabling notifications still records changes");
});

test("raising the threshold during refresh filters changes using the saved value", async (t) => {
  const h = await background(t, { unreadCount: 0 });
  const refresh = await h.refresh();
  await h.message({
    type: "SAVE_SETTINGS",
    settings: { ...DEFAULT_SETTINGS, notificationThreshold: 10 },
  });

  h.complete(103);
  await refresh.result;
  const state = await h.getState();
  assert.deepEqual(state.recentChanges, []);
  assert.equal(state.unreadCount, 0);
  assert.equal(h.notificationHistory.length, 0);
});

test("lowering the threshold during refresh includes newly qualifying changes", async (t) => {
  const h = await background(t, {
    unreadCount: 0,
    settings: { ...DEFAULT_SETTINGS, notificationThreshold: 10 },
  });
  const refresh = await h.refresh();
  await h.message({
    type: "SAVE_SETTINGS",
    settings: { ...DEFAULT_SETTINGS, notificationThreshold: 2 },
  });

  h.complete(103);
  await refresh.result;
  const state = await h.getState();
  assert.equal(state.recentChanges.length, 1, "the effort changed; the headline is only a projection");
  assert.equal(state.unreadCount, 1, "a model is counted only once");
  assert.equal(h.notificationHistory.length, 1);
});

test("MARK_SEEN cannot overwrite a refreshed snapshot during its storage write", async (t) => {
  const h = await background(t);
  const refresh = await h.refresh();
  const gate = h.pauseStateWrite((state) => state?.unreadCount === 0);
  const seen = h.message({ type: "MARK_SEEN" });
  await gate.entered;
  h.complete(103);
  await new Promise((resolve) => setImmediate(resolve));
  gate.release();

  await Promise.all([seen, refresh.result]);
  const state = await h.getState();
  assert.equal(state.status, "ready");
  assert.equal(state.snapshot.models[0].iq, 103);
  assert.deepEqual(state.previousSnapshot, h.initialSnapshot);
  assert.equal(state.unreadCount, 1);
});

test("MARK_SEEN during the refresh commit keeps the new snapshot and clears its badge", async (t) => {
  const h = await background(t);
  const refresh = await h.refresh();
  const gate = h.pauseStateWrite((state) => state?.status === "ready");
  h.complete(103);
  await gate.entered;
  const seen = h.message({ type: "MARK_SEEN" });
  await new Promise((resolve) => setImmediate(resolve));
  gate.release();

  await Promise.all([seen, refresh.result]);
  const state = await h.getState();
  assert.equal(state.snapshot.models[0].iq, 103);
  assert.equal(state.unreadCount, 0);
  assert.equal(h.badge(), "");
  assert.equal(h.notifications.size, 0);
});

test("disabling notifications during the refresh commit clears the notification before acknowledging settings", async (t) => {
  const h = await background(t, { unreadCount: 0 });
  const refresh = await h.refresh();
  const gate = h.pauseStateWrite((state) => state?.status === "ready");
  h.complete(103);
  await gate.entered;
  const save = h.message({
    type: "SAVE_SETTINGS",
    settings: { ...DEFAULT_SETTINGS, notificationsEnabled: false },
  });
  await new Promise((resolve) => setImmediate(resolve));
  gate.release();

  const [saved, refreshed] = await Promise.all([save, refresh.result]);
  assert.equal(saved.settings.notificationsEnabled, false);
  assert.equal(refreshed.ok, true);
  assert.equal(h.notifications.size, 0);
});

test("a failed state write returns its error and does not block later settings or refresh", async (t) => {
  const h = await background(t);
  const refresh = await h.refresh();
  h.failNextStateWrite(new Error("Storage write failed"));
  assert.deepEqual(await h.message({ type: "MARK_SEEN" }), {
    ok: false,
    error: "Storage write failed",
  });

  const saved = await h.message({ type: "SAVE_SETTINGS", settings: DEFAULT_SETTINGS });
  assert.equal(saved.ok, true);
  h.complete();
  assert.equal((await refresh.result).ok, true);
  assert.equal((await h.getState()).unreadCount, 3, "the failed acknowledgement did not clear unread changes");
});

test("overlapping Alarm and manual refresh use one API request", async (t) => {
  const h = await background(t);
  const refresh = await h.refresh();
  const second = h.message({ type: "REFRESH_NOW" });
  h.complete();

  assert.equal((await refresh.result).ok, true);
  assert.equal((await second).ok, true);
  assert.deepEqual(h.fetchCounts(), { binding: 1, summary: 1 });
});

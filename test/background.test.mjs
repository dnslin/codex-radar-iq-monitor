import assert from "node:assert/strict";
import test from "node:test";
import {
  ALARM_NAME,
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  STATE_KEY,
  buildSnapshot,
} from "../src/radar.js";

let moduleNumber = 0;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function table(iq) {
  return {
    tasks: [{ id: "task-a" }],
    combos: [{ model: "test-model", effort: "high", agent: "codex" }],
    cells: { "task-a|test-model|high": { n: 150, score_sum: iq } },
  };
}

async function background(t, { unreadCount = 3, settings = DEFAULT_SETTINGS } = {}) {
  const initialSnapshot = buildSnapshot(table(100), "2026-10-02T00:00:00Z");
  const store = {
    [STATE_KEY]: {
      status: "ready",
      snapshot: initialSnapshot,
      previousSnapshot: null,
      recentChanges: [],
      unreadCount,
      lastSuccessAt: initialSnapshot.fetchedAt,
    },
    [SETTINGS_KEY]: structuredClone(settings),
  };
  const fetchStarted = deferred();
  const fetchResponse = deferred();
  const listeners = {};
  const notifications = new Map();
  const notificationHistory = [];
  const alarms = new Map();
  let badge = "";
  let fetchCount = 0;
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
  globalThis.fetch = async () => {
    fetchCount += 1;
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
    fetchCount: () => fetchCount,
    getState: async () => (await message({ type: "GET_STATE" })).state,
    async refresh() {
      listeners.alarm({ name: ALARM_NAME });
      await fetchStarted.promise;
      return { result: message({ type: "REFRESH_NOW" }) };
    },
    complete(iq = 100) {
      fetchResponse.resolve({ ok: true, json: async () => table(iq) });
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
  assert.deepEqual(await refresh.result, { ok: false, error: "Radar API request failed: HTTP 503" });
  const state = await h.getState();
  assert.equal(state.status, "error");
  assert.equal(state.error, "Radar API request failed: HTTP 503");
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
  assert.equal(state.recentChanges.length, 2, "both the model and effort changed");
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
  assert.equal(h.fetchCount(), 1);
});

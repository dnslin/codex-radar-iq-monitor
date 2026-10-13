import {
  ALARM_NAME,
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  STATE_KEY,
  canCompareSnapshots,
  compareSnapshots,
  fetchRadarSnapshot,
  formatChangeLabel,
  normalizeSettings,
} from "./radar.js";

const NOTIFICATION_ID = "codex-radar-iq-change";
let refreshPromise = null;
let storeUpdatePromise = Promise.resolve();

// Keep state writes, badges and notifications in order. Network requests run
// outside this queue so MARK_SEEN and SAVE_SETTINGS remain available while fetching.
function updateStore(operation) {
  storeUpdatePromise = storeUpdatePromise.then(operation, operation);
  return storeUpdatePromise;
}

function emptyState() {
  return {
    status: "idle",
    snapshot: null,
    previousSnapshot: null,
    recentChanges: [],
    unreadCount: 0,
    lastAttemptAt: null,
    lastSuccessAt: null,
    error: null,
  };
}

async function readStore() {
  const stored = await chrome.storage.local.get([STATE_KEY, SETTINGS_KEY]);
  return {
    state:
      stored[STATE_KEY] && typeof stored[STATE_KEY] === "object"
        ? { ...emptyState(), ...stored[STATE_KEY] }
        : emptyState(),
    settings: normalizeSettings(stored[SETTINGS_KEY]),
  };
}

async function writeState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
  await updateBadge(state.unreadCount);
}

async function updateBadge(unreadCount) {
  const count = Number(unreadCount) || 0;
  await chrome.action.setBadgeText({
    text: count > 99 ? "99+" : count > 0 ? String(count) : "",
  });
  if (count > 0) {
    await chrome.action.setBadgeBackgroundColor({ color: "#d97706" });
  }
}

async function scheduleRefresh(settings) {
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: settings.refreshMinutes,
    periodInMinutes: settings.refreshMinutes,
  });
}

function notificationChanges(changes) {
  return changes.slice(0, 4);
}

async function showChangeNotification(changes) {
  const selected = notificationChanges(changes);
  if (!selected.length) return;

  const extraCount = Math.max(0, changes.length - selected.length);
  const message = selected.map(formatChangeLabel).join("\n") +
    (extraCount ? `\n另有 ${extraCount} 项变化` : "");

  try {
    await chrome.notifications.create(NOTIFICATION_ID, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: "Codex Radar 雷达分有变化",
      message,
      priority: 1,
    });
  } catch (error) {
    console.warn("Unable to show Codex Radar notification", error);
  }
}

async function performRefresh() {
  const startedAt = new Date().toISOString();

  await updateStore(async () => {
    const { state } = await readStore();
    await writeState({
      ...state,
      status: state.snapshot ? "refreshing" : "loading",
      lastAttemptAt: startedAt,
      error: null,
    });
  });

  try {
    const snapshot = await fetchRadarSnapshot();
    return await updateStore(async () => {
      const { state, settings } = await readStore();
      const previousSnapshot = canCompareSnapshots(state.snapshot, snapshot)
        ? state.snapshot
        : null;
      const changes = compareSnapshots(
        previousSnapshot,
        snapshot,
        settings.notificationThreshold,
      );
      const changedModels = new Set(changes.map((change) => change.modelId));
      const unreadCount = previousSnapshot
        ? Math.min(999, (Number(state.unreadCount) || 0) + changedModels.size)
        : 0;
      const nextState = {
        status: "ready",
        snapshot,
        previousSnapshot,
        recentChanges: changes,
        unreadCount,
        lastAttemptAt: startedAt,
        lastSuccessAt: snapshot.fetchedAt,
        error: null,
      };

      await writeState(nextState);
      if (!previousSnapshot) {
        await chrome.notifications.clear(NOTIFICATION_ID);
      } else if (settings.notificationsEnabled && changes.length) {
        await showChangeNotification(changes);
      }
      return nextState;
    });
  } catch (error) {
    await updateStore(async () => {
      const { state } = await readStore();
      await writeState({
        ...state,
        status: "error",
        lastAttemptAt: startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    throw error;
  }
}

function refreshRadar() {
  if (!refreshPromise) {
    refreshPromise = performRefresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

async function initialize() {
  await updateStore(async () => {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const settings = normalizeSettings(stored[SETTINGS_KEY] ?? DEFAULT_SETTINGS);
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    await scheduleRefresh(settings);
    const { state } = await readStore();
    await updateBadge(state.unreadCount);
  });
  await refreshRadar().catch((error) => {
    console.warn("Initial Codex Radar refresh failed", error);
  });
}

async function handleMessage(message) {
  switch (message?.type) {
    case "GET_STATE": {
      const { state, settings } = await readStore();
      return { ok: true, state, settings };
    }
    case "REFRESH_NOW": {
      const state = await refreshRadar();
      const { settings } = await readStore();
      return { ok: true, state, settings };
    }
    case "SAVE_SETTINGS": {
      return updateStore(async () => {
        const settings = normalizeSettings(message.settings);
        await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
        await scheduleRefresh(settings);
        if (!settings.notificationsEnabled) {
          await chrome.notifications.clear(NOTIFICATION_ID);
        }
        const { state } = await readStore();
        return { ok: true, state, settings };
      });
    }
    case "MARK_SEEN": {
      return updateStore(async () => {
        const { state, settings } = await readStore();
        const nextState = { ...state, unreadCount: 0 };
        await writeState(nextState);
        await chrome.notifications.clear(NOTIFICATION_ID);
        return { ok: true, state: nextState, settings };
      });
    }
    default:
      throw new Error("Unknown extension message");
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void initialize();
});

chrome.runtime.onStartup.addListener(() => {
  void initialize();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    void refreshRadar().catch((error) => {
      console.warn("Scheduled Codex Radar refresh failed", error);
    });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  return true;
});

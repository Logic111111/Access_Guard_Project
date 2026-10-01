import test from "node:test";
import assert from "node:assert/strict";

test("service worker arms from authenticated policy and releases only after backend terminal policy", async () => {
  const listeners = {};
  const storage = {};
  const fetchCalls = [];
  const tabUpdates = [];
  const windowUpdates = [];
  const examWindow = { id: 9, focused: true, state: "normal" };
  let dynamicRules = [];
  let backendState = "armed";
  let backendEnforcement = true;
  let policyVersion = 1;

  const event = (name) => ({
    addListener(listener) {
      listeners[name] = listener;
    },
  });

  globalThis.chrome = {
    runtime: {
      getURL: (path = "") => `chrome-extension://test-extension/${path}`,
      getManifest: () => ({ version: "1.0.0" }),
      onMessage: event("runtime.onMessage"),
      onInstalled: event("runtime.onInstalled"),
      onStartup: event("runtime.onStartup"),
    },
    action: {
      setBadgeBackgroundColor: async () => undefined,
      setBadgeText: async () => undefined,
    },
    storage: {
      local: {
        get: async (key) => ({ [key]: storage[key] }),
        set: async (values) => Object.assign(storage, values),
        setAccessLevel: async () => undefined,
      },
      managed: {
        get: async () => ({}),
      },
    },
    declarativeNetRequest: {
      getDynamicRules: async () => dynamicRules,
      updateDynamicRules: async ({ removeRuleIds = [], addRules = [] }) => {
        dynamicRules = dynamicRules.filter((rule) => !removeRuleIds.includes(rule.id));
        dynamicRules.push(...addRules);
      },
    },
    tabs: {
      query: async () => [],
      update: async (tabId, options) => {
        tabUpdates.push({ tabId, options });
        return {};
      },
      create: async ({ url }) => ({ id: 44, windowId: 9, url }),
      get: async () => null,
      sendMessage: async () => undefined,
      onUpdated: event("tabs.onUpdated"),
      onCreated: event("tabs.onCreated"),
      onActivated: event("tabs.onActivated"),
      onRemoved: event("tabs.onRemoved"),
    },
    webNavigation: {
      onBeforeNavigate: event("webNavigation.onBeforeNavigate"),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      getLastFocused: async () => ({ ...examWindow }),
      get: async () => ({ ...examWindow }),
      update: async (windowId, options) => {
        windowUpdates.push({ windowId, options });
        Object.assign(examWindow, options);
        return { ...examWindow };
      },
      onFocusChanged: event("windows.onFocusChanged"),
    },
    idle: {
      onStateChanged: event("idle.onStateChanged"),
    },
    alarms: {
      create: async () => undefined,
      onAlarm: event("alarms.onAlarm"),
    },
    notifications: {
      create: async () => "notification-id",
      clear: async () => undefined,
      onClicked: event("notifications.onClicked"),
    },
  };

  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    if (String(url).includes("/public/extension/policy")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidate_id: "candidate_123",
          session_id: "session_456",
          state: backendState,
          enforcement: backendEnforcement,
          policy_version: policyVersion,
          exam_url: "https://configured.example.edu/configured/entry?source=policy#discarded",
          app_origins: ["https://exam.example.edu"],
          allowed_origins: ["https://docs.example.edu"],
          timestamps: { generated_at: new Date().toISOString() },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    };
  };

  await import(`../service-worker.js?smoke=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(typeof listeners["runtime.onMessage"], "function");

  const sender = {
    url: "https://exam.example.edu/student/exam?attempt=abc#question-2",
    tab: {
      id: 33,
      windowId: 9,
      url: "https://exam.example.edu/student/exam?attempt=abc#question-2",
    },
  };

  const sendMessage = (message, messageSender = sender) => new Promise((resolve) => {
    const keepChannelOpen = listeners["runtime.onMessage"](message, messageSender, resolve);
    assert.equal(keepChannelOpen, true);
  });

  const armed = await sendMessage({
    scope: "accessguard-content-bridge",
    action: "ARM",
    payload: {
      candidateId: "candidate_123",
      candidateToken: "candidate-token-long-enough",
      apiBase: "/api",
      appOrigin: "https://exam.example.edu",
    },
  });

  assert.equal(armed.ok, true);
  assert.equal(armed.data.mode, "enforced");
  assert.equal(armed.data.enforcementActive, true);
  assert.equal(
    armed.data.examUrl,
    "https://exam.example.edu/configured/entry?source=policy"
  );
  assert.equal(dynamicRules.some((rule) => rule.action.type === "block"), true);
  assert.equal(dynamicRules.filter((rule) => rule.action.type === "allow").length, 2);
  assert.equal(
    fetchCalls.find((call) => call.url.includes("/public/extension/policy"))
      ?.options?.headers?.["X-AccessGuard-App-Origin"],
    "https://exam.example.edu"
  );
  // Arming fullscreens the exam window once, without re-focusing a focused window.
  assert.deepEqual(windowUpdates, [{ windowId: 9, options: { state: "fullscreen" } }]);

  // A routine policy refresh while already enforced must not touch the window;
  // doing so makes the exam page blur and records false violations.
  const refreshed = await sendMessage({
    scope: "accessguard-content-bridge",
    action: "REFRESH_POLICY",
    payload: {},
  });
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.data.mode, "enforced");
  assert.equal(windowUpdates.length, 1);

  const blockedSender = {
    url: "chrome-extension://test-extension/blocked.html?reason=navigation_blocked",
    tab: {
      id: 55,
      windowId: 9,
      url: "chrome-extension://test-extension/blocked.html?reason=navigation_blocked",
    },
  };
  const returned = await sendMessage({
    scope: "accessguard-blocked",
    action: "RETURN_TO_EXAM",
  }, blockedSender);
  assert.equal(returned.ok, true);
  assert.deepEqual(tabUpdates.at(-1), {
    tabId: 55,
    options: {
      url: "https://exam.example.edu/student/exam?attempt=abc",
      active: true,
    },
  });

  // Simulate an active v1.0.0 runtime after an extension update. The legacy
  // origin-only policy URL has the wrong origin, no useful route, and no
  // immutable armedExamUrl field.
  storage.accessguardRuntime.armedExamUrl = null;
  storage.accessguardRuntime.examUrl = "https://configured.example.edu/";
  const migratedReturn = await sendMessage({
    scope: "accessguard-blocked",
    action: "RETURN_TO_EXAM",
  }, blockedSender);
  assert.equal(migratedReturn.ok, true);
  assert.equal(
    tabUpdates.at(-1).options.url,
    "https://exam.example.edu/student/exam"
  );
  assert.equal(
    storage.accessguardRuntime.armedExamUrl,
    "https://exam.example.edu/student/exam"
  );

  const accessRequested = await sendMessage({
    scope: "accessguard-blocked",
    action: "REQUEST_ACCESS",
    url: "https://reference.example.org/guide",
  }, blockedSender);
  assert.equal(accessRequested.ok, true);
  assert.equal(
    fetchCalls.find((call) => call.url.includes("/public/extension/access-requests"))
      ?.options?.headers?.["X-AccessGuard-App-Origin"],
    "https://exam.example.edu"
  );

  backendEnforcement = false;
  policyVersion = 2;
  const monitoring = await sendMessage({
    scope: "accessguard-content-bridge",
    action: "REFRESH_POLICY",
    payload: {},
  });
  assert.equal(monitoring.ok, true);
  assert.equal(monitoring.data.mode, "monitoring");
  assert.equal(monitoring.data.enforcementActive, false);
  assert.equal(dynamicRules.length, 0);

  backendEnforcement = true;
  policyVersion = 3;
  const reenforced = await sendMessage({
    scope: "accessguard-content-bridge",
    action: "REFRESH_POLICY",
    payload: {},
  });
  assert.equal(reenforced.ok, true);
  assert.equal(reenforced.data.mode, "enforced");
  assert.equal(dynamicRules.some((rule) => rule.action.type === "block"), true);

  const unsupportedUnlock = await sendMessage({
    scope: "accessguard-content-bridge",
    action: "UNLOCK",
    payload: {},
  });
  assert.equal(unsupportedUnlock.ok, false);
  assert.equal(dynamicRules.some((rule) => rule.action.type === "block"), true);

  backendState = "finished";
  backendEnforcement = false;
  policyVersion = 4;
  const released = await sendMessage({
    scope: "accessguard-content-bridge",
    action: "REFRESH_POLICY",
    payload: {},
  });

  assert.equal(released.ok, true);
  assert.equal(released.data.mode, "released");
  assert.equal(released.data.enforcementActive, false);
  assert.equal(dynamicRules.length, 0);

  await new Promise((resolve) => setTimeout(resolve, 10));
  const authenticatedExtensionCalls = fetchCalls.filter((call) =>
    call.url.includes("/public/extension/policy") ||
    call.url.includes("/public/extension/heartbeat") ||
    call.url.includes("/public/extension/access-requests")
  );
  assert.equal(
    authenticatedExtensionCalls.some((call) => call.url.includes("/public/extension/heartbeat")),
    true
  );
  assert.equal(
    authenticatedExtensionCalls.every(
      (call) => call.options?.headers?.["X-AccessGuard-App-Origin"] === "https://exam.example.edu"
    ),
    true
  );
});

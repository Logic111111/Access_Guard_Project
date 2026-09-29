import test from "node:test";
import assert from "node:assert/strict";

export function createChromeMock({ managedTrust = {} } = {}) {
  const listeners = {};
  const storage = {};
  const event = (name) => ({ addListener(listener) { listeners[name] = listener; } });
  const chrome = {
    runtime: {
      getURL: (path = "") => `chrome-extension://test-extension/${path}`,
      getManifest: () => ({ version: "1.1.0" }),
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
        get: async () => managedTrust,
      },
    },
    declarativeNetRequest: {
      getDynamicRules: async () => [],
      updateDynamicRules: async () => undefined,
    },
    tabs: {
      query: async () => [],
      update: async () => ({}),
      create: async ({ url }) => ({ id: 44, windowId: 9, url }),
      get: async () => null,
      sendMessage: async () => undefined,
      onUpdated: event("tabs.onUpdated"),
      onCreated: event("tabs.onCreated"),
      onActivated: event("tabs.onActivated"),
      onRemoved: event("tabs.onRemoved"),
    },
    webNavigation: { onBeforeNavigate: event("webNavigation.onBeforeNavigate") },
    windows: {
      WINDOW_ID_NONE: -1,
      getLastFocused: async () => ({ id: 9, focused: true, state: "normal" }),
      get: async () => ({ id: 9, focused: true, state: "normal" }),
      update: async () => ({ id: 9, focused: true, state: "fullscreen" }),
      onFocusChanged: event("windows.onFocusChanged"),
    },
    idle: { onStateChanged: event("idle.onStateChanged") },
    alarms: { create: async () => undefined, onAlarm: event("alarms.onAlarm") },
  };
  return { chrome, listeners, storage };
}

export async function importFreshServiceWorker() {
  return import(`../service-worker.js?case=${Math.random().toString(36).slice(2)}`);
}

export function popupSender() {
  return { url: "chrome-extension://test-extension/popup.html" };
}

export function makeSend(listeners) {
  return (message) => new Promise((resolve) => {
    listeners["runtime.onMessage"](message, popupSender(), resolve);
  });
}

test("popup can configure a deployment manually", async () => {
  const { chrome, listeners, storage } = createChromeMock();
  globalThis.chrome = chrome;
  globalThis.fetch = async () => { throw new Error("no network expected in this test"); };
  await importFreshServiceWorker();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const send = makeSend(listeners);

  const before = await send({ scope: "accessguard-popup", action: "GET_DEPLOYMENT" });
  assert.equal(before.ok, true);
  assert.equal(before.data, null);

  const configured = await send({
    scope: "accessguard-popup",
    action: "CONFIGURE_DEPLOYMENT",
    appUrl: "https://exam.example.edu",
  });
  assert.equal(configured.ok, true);
  assert.equal(configured.data.appOrigin, "https://exam.example.edu");
  assert.equal(configured.data.apiBase, "https://exam.example.edu/api");
  assert.equal(storage.accessguardDeployment.appOrigin, "https://exam.example.edu");
});

test("popup auto-detects a managed deployment without prompting", async () => {
  const { chrome, listeners } = createChromeMock({
    managedTrust: {
      trusted_app_origins: ["https://managed.example.edu"],
      trusted_api_origins: ["https://managed.example.edu/api"],
    },
  });
  globalThis.chrome = chrome;
  globalThis.fetch = async () => { throw new Error("no network expected in this test"); };
  await importFreshServiceWorker();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const send = makeSend(listeners);

  const detected = await send({ scope: "accessguard-popup", action: "GET_DEPLOYMENT" });
  assert.equal(detected.ok, true);
  assert.equal(detected.data.appOrigin, "https://managed.example.edu");
  assert.equal(detected.data.managed, true);
});

test("configuring a new deployment is refused while a candidate is armed", async () => {
  const { chrome, listeners, storage } = createChromeMock();
  globalThis.chrome = chrome;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/public/extension/policy")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidate_id: "candidate-1",
          session_id: "session-1",
          state: "enforced",
          enforcement: true,
          policy_version: 1,
          exam_url: "https://exam.example.edu/student/exam",
          app_origins: ["https://exam.example.edu"],
          allowed_origins: [],
          timestamps: { generated_at: new Date().toISOString() },
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  await importFreshServiceWorker();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const send = makeSend(listeners);

  storage.accessguardRuntime = {
    mode: "enforced",
    enforcementActive: true,
    candidateId: "candidate-1",
    candidateToken: "candidate-token-long-enough",
    apiBase: "https://exam.example.edu/api",
    appOrigin: "https://exam.example.edu",
    allowedOrigins: ["https://exam.example.edu"],
  };

  const rejected = await send({
    scope: "accessguard-popup",
    action: "CONFIGURE_DEPLOYMENT",
    appUrl: "https://other.example.edu",
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "cannot_reconfigure_while_armed");
});

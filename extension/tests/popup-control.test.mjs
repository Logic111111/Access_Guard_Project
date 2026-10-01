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
    notifications: {
      create: async () => `notification-${Math.random().toString(36).slice(2)}`,
      clear: async () => undefined,
      onClicked: event("notifications.onClicked"),
    },
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
  assert.equal(detected.data.apiBase, "https://managed.example.edu/api");
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

test("invigilator can sign in, start a quick session, poll status, and end it", async () => {
  const { chrome, listeners, storage } = createChromeMock();
  globalThis.chrome = chrome;
  const fetchCalls = [];
  let candidateCount = 0;
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    const href = String(url);
    if (href.endsWith("/auth/login")) {
      return { ok: true, status: 200, json: async () => ({ token: "inv-token-123", inv_id: "EG/STAFF/0001", name: "Ada Lovelace" }) };
    }
    if (href.endsWith("/sessions")) {
      return { ok: true, status: 200, json: async () => ({ id: "session-1", session_code: "QUIK-ABCD-EFGH", exam_name: "Quick Lockdown" }) };
    }
    if (href.endsWith("/sessions/session-1/start")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, started_at: new Date().toISOString() }) };
    }
    if (href.endsWith("/sessions/session-1/candidates")) {
      return { ok: true, status: 200, json: async () => Array.from({ length: candidateCount }, (_, i) => ({ id: `cand-${i}` })) };
    }
    if (href.endsWith("/sessions/session-1/end")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, ended_at: new Date().toISOString() }) };
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  await importFreshServiceWorker();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const send = makeSend(listeners);

  await send({ scope: "accessguard-popup", action: "CONFIGURE_DEPLOYMENT", appUrl: "https://exam.example.edu" });

  const login = await send({
    scope: "accessguard-popup",
    action: "INVIGILATOR_LOGIN",
    invId: "EG/STAFF/0001",
    password: "AccessGuard2026!",
  });
  assert.equal(login.ok, true);
  assert.equal(login.data.name, "Ada Lovelace");
  assert.equal(storage.accessguardInvigilatorAuth.token, "inv-token-123");

  const created = await send({
    scope: "accessguard-popup",
    action: "CREATE_QUICK_SESSION",
    durationMinutes: 45,
    questionText: "Summarize the reading.",
    modelAnswer: "Any reasonable summary.",
    whitelistedUrls: [],
  });
  assert.equal(created.ok, true);
  assert.equal(created.data.sessionCode, "QUIK-ABCD-EFGH");
  assert.ok(fetchCalls.some((c) => c.url.endsWith("/sessions/session-1/start")));
  const createCall = fetchCalls.find((c) => c.url.endsWith("/sessions") && c.options.method === "POST");
  assert.equal(createCall.options.headers.Authorization, "Bearer inv-token-123");

  candidateCount = 3;
  const status = await send({ scope: "accessguard-popup", action: "GET_CONTROL_STATUS" });
  assert.equal(status.ok, true);
  assert.equal(status.data.invigilator.signedIn, true);
  assert.equal(status.data.quickSession.active, true);
  assert.equal(status.data.quickSession.candidateCount, 3);

  const ended = await send({ scope: "accessguard-popup", action: "END_QUICK_SESSION" });
  assert.equal(ended.ok, true);
  const statusAfterEnd = await send({ scope: "accessguard-popup", action: "GET_CONTROL_STATUS" });
  assert.equal(statusAfterEnd.data.quickSession.active, false);
});

test("an expired invigilator token is cleared instead of shown as signed in forever", async () => {
  const { chrome, listeners, storage } = createChromeMock();
  globalThis.chrome = chrome;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.endsWith("/auth/login")) {
      return { ok: true, status: 200, json: async () => ({ token: "stale-token", inv_id: "EG/STAFF/0001", name: "Ada Lovelace" }) };
    }
    if (href.endsWith("/sessions/session-1/candidates")) {
      return { ok: false, status: 401, json: async () => ({ detail: "Invalid token" }) };
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  await importFreshServiceWorker();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const send = makeSend(listeners);

  await send({ scope: "accessguard-popup", action: "CONFIGURE_DEPLOYMENT", appUrl: "https://exam.example.edu" });
  await send({ scope: "accessguard-popup", action: "INVIGILATOR_LOGIN", invId: "EG/STAFF/0001", password: "x" });
  storage.accessguardActiveQuickSession = { sessionId: "session-1", sessionCode: "QUIK-ABCD-EFGH" };

  const status = await send({ scope: "accessguard-popup", action: "GET_CONTROL_STATUS" });
  assert.equal(status.ok, true);
  assert.equal(status.data.invigilator.signedIn, false);
  assert.equal(status.data.quickSession.active, false);
  assert.equal(storage.accessguardInvigilatorAuth, null);
});

test("a student can join a quick session directly from the popup, and a second join is refused", async () => {
  const { chrome, listeners, storage } = createChromeMock();
  globalThis.chrome = chrome;
  const fetchCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    const href = String(url);
    if (href.includes("/public/candidates/join")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "candidate-9", candidate_token: "candidate-token-long-enough", status: "approved" }),
      };
    }
    if (href.includes("/public/extension/policy")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidate_id: "candidate-9",
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

  await send({ scope: "accessguard-popup", action: "CONFIGURE_DEPLOYMENT", appUrl: "https://exam.example.edu" });

  const joined = await send({
    scope: "accessguard-popup",
    action: "EXTENSION_JOIN",
    sessionCode: "quik-abcd-efgh",
    studentId: "S-42",
    fullName: "Asha Perera",
  });

  assert.equal(joined.ok, true);
  assert.equal(joined.data.mode, "enforced");
  assert.equal(joined.data.candidateId, "candidate-9");
  const joinCall = fetchCalls.find((c) => c.url.includes("/public/candidates/join"));
  assert.equal(JSON.parse(joinCall.options.body).session_code, "QUIK-ABCD-EFGH");
  assert.equal(storage.accessguardRuntime.candidateId, "candidate-9");

  const secondJoin = await send({
    scope: "accessguard-popup",
    action: "EXTENSION_JOIN",
    sessionCode: "OTHR-WXYZ-1234",
    studentId: "S-99",
    fullName: "Someone Else",
  });
  assert.equal(secondJoin.ok, false);
  assert.equal(secondJoin.error.code, "already_armed_for_candidate");
});

test("joining with an unknown session code surfaces the backend's error", async () => {
  const { chrome, listeners } = createChromeMock();
  globalThis.chrome = chrome;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/public/candidates/join")) {
      return { ok: false, status: 404, json: async () => ({ detail: "Invalid session code" }) };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  await importFreshServiceWorker();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const send = makeSend(listeners);

  await send({ scope: "accessguard-popup", action: "CONFIGURE_DEPLOYMENT", appUrl: "https://exam.example.edu" });
  const result = await send({
    scope: "accessguard-popup",
    action: "EXTENSION_JOIN",
    sessionCode: "BOGUS-CODE-0000",
    studentId: "S-1",
    fullName: "Nobody",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.message, "Invalid session code");
});

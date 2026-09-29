import {
  ENFORCED_POLICY_STATES,
  RELEASE_POLICY_STATES,
  compileNavigationRules,
  isAllowedHttpNavigation,
  isLoopbackOrigin,
  isOwnedRuleId,
  isSecureOrLoopbackOrigin,
  normalizeApiBase,
  normalizeExamUrl,
  normalizeOrigin,
  normalizeOriginList,
  normalizePolicy,
  sanitizeAttemptedUrl,
} from "./rule-helpers.js";
import { buildQuickSessionPayload, validateJoinForm, validateLoginForm } from "./quick-session.js";
import {
  ACCESS_REQUEST_PATH,
  ACTIVE_QUICK_SESSION_STORAGE_KEY,
  AUTH_LOGIN_PATH,
  BUILD_TRUSTED_API_ORIGINS,
  BUILD_TRUSTED_APP_ORIGINS,
  CANDIDATE_JOIN_PATH,
  DEPLOYMENT_STORAGE_KEY,
  FETCH_TIMEOUT_MS,
  HEARTBEAT_PATH,
  INVIGILATOR_AUTH_STORAGE_KEY,
  MAX_ALLOWED_ORIGINS,
  POLICY_ALARM,
  POLICY_PATH,
  POLICY_REFRESH_MINUTES,
  PROTOCOL_VERSION,
  RUNTIME_STORAGE_KEY,
  SESSIONS_PATH,
} from "./config.js";

const BRIDGE_SCOPE = "accessguard-content-bridge";
const BLOCKED_SCOPE = "accessguard-blocked";
const POPUP_SCOPE = "accessguard-popup";
const INTERNAL_SCOPE = "accessguard-internal";
const OWN_EXTENSION_PREFIX = chrome.runtime.getURL("");
const manifest = chrome.runtime.getManifest();

let operationQueue = Promise.resolve();

class LockdownError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LockdownError";
    this.code = code;
  }
}

function defaultRuntime() {
  return {
    mode: "inactive",
    backendState: null,
    enforcementActive: false,
    candidateId: null,
    candidateToken: null,
    sessionId: null,
    policyVersion: null,
    apiBase: null,
    appOrigin: null,
    armedExamUrl: null,
    examUrl: null,
    allowedOrigins: [],
    examTabId: null,
    examWindowId: null,
    policyIssuedAt: null,
    policyExpiresAt: null,
    lastPolicyAt: null,
    lastHeartbeatAt: null,
    lastBlockedAttempt: null,
    lastError: null,
    managed: false,
    armedAt: null,
    releasedAt: null,
    heartbeatSequence: 0,
  };
}

function serialize(task) {
  const run = operationQueue.then(task, task);
  operationQueue = run.catch(() => undefined);
  return run;
}

function errorDetails(error, fallbackCode = "extension_error") {
  return {
    code: typeof error?.code === "string" ? error.code : fallbackCode,
    message: error instanceof Error ? error.message : String(error || "Unknown extension error"),
    at: new Date().toISOString(),
  };
}

function assert(condition, code, message) {
  if (!condition) throw new LockdownError(code, message);
}

function safeOrigin(value) {
  try {
    return normalizeOrigin(value);
  } catch {
    return null;
  }
}

async function readRuntime() {
  const stored = await chrome.storage.local.get(RUNTIME_STORAGE_KEY);
  const value = stored?.[RUNTIME_STORAGE_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaultRuntime();
  }
  const runtime = {
    ...defaultRuntime(),
    ...value,
    allowedOrigins: Array.isArray(value.allowedOrigins) ? value.allowedOrigins : [],
  };

  // v1.0.0 stored only the backend policy URL. On deployments reached through
  // an alias (localhost vs. 127.0.0.1, LAN DNS, etc.), that URL can have the
  // wrong browser-storage origin. Migrate it onto the exact armed app origin so
  // an extension update does not send an active student back to a logged-out
  // landing page. New runtimes retain the exact sender URL in armedExamUrl.
  if (runtime.appOrigin) {
    let armedExamUrl;
    try {
      armedExamUrl = normalizeExamUrl(
        runtime.armedExamUrl || runtime.examUrl || "/student/exam",
        runtime.appOrigin,
        "/student/exam"
      );
    } catch {
      armedExamUrl = normalizeExamUrl("/student/exam", runtime.appOrigin);
    }

    let examUrl;
    try {
      examUrl = normalizeExamUrl(runtime.examUrl || armedExamUrl, runtime.appOrigin);
    } catch {
      examUrl = armedExamUrl;
    }

    if (runtime.armedExamUrl !== armedExamUrl || runtime.examUrl !== examUrl) {
      runtime.armedExamUrl = armedExamUrl;
      runtime.examUrl = examUrl;
      await chrome.storage.local.set({ [RUNTIME_STORAGE_KEY]: runtime }).catch(() => undefined);
    }
  }

  return runtime;
}

async function writeRuntime(runtime, { notify = true } = {}) {
  const next = { ...defaultRuntime(), ...runtime };
  await chrome.storage.local.set({ [RUNTIME_STORAGE_KEY]: next });
  await updateBadge(next);
  if (notify) await notifyStatus(next);
  return next;
}

function publicStatus(runtime, { minimal = false } = {}) {
  const base = {
    installed: true,
    protocolVersion: PROTOCOL_VERSION,
    extensionVersion: manifest.version,
    mode: minimal ? "available" : runtime.mode,
    enforcementActive: minimal ? false : Boolean(runtime.enforcementActive),
  };

  if (minimal) return base;

  return {
    ...base,
    backendState: runtime.backendState,
    candidateId: runtime.candidateId,
    sessionId: runtime.sessionId,
    policyVersion: runtime.policyVersion,
    examUrl: runtime.examUrl,
    allowedOrigins: [...runtime.allowedOrigins],
    lastPolicyAt: runtime.lastPolicyAt,
    lastHeartbeatAt: runtime.lastHeartbeatAt,
    lastError: runtime.lastError,
    managed: Boolean(runtime.managed),
  };
}

async function updateBadge(runtime) {
  let text = "";
  let color = "#475569";

  if (runtime.mode === "locked" || runtime.mode === "fail_closed") {
    text = "LOCK";
    color = "#dc2626";
  } else if (runtime.enforcementActive) {
    text = "ON";
    color = "#0891b2";
  } else if (runtime.mode === "error") {
    text = "ERR";
    color = "#d97706";
  }

  await chrome.action.setBadgeBackgroundColor({ color }).catch(() => undefined);
  await chrome.action.setBadgeText({ text }).catch(() => undefined);
}

async function notifyStatus(runtime) {
  if (!runtime.appOrigin) return;
  const status = publicStatus(runtime);
  const tabs = await chrome.tabs.query({}).catch(() => []);

  await Promise.allSettled(
    tabs
      .filter((tab) => safeOrigin(tab.url || tab.pendingUrl || "") === runtime.appOrigin)
      .map((tab) => chrome.tabs.sendMessage(tab.id, {
        scope: INTERNAL_SCOPE,
        action: "STATUS_PUSH",
        data: status,
      }))
  );
}

async function configureStorageAccess() {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch {
    // Older/managed builds may not expose setAccessLevel. Manifest requires
    // Chrome 120, but failing here must not disable enforcement.
  }
}

function normalizeTrustedOrigins(values) {
  const normalized = [];
  for (const value of values || []) {
    const origin = safeOrigin(value);
    if (origin && isSecureOrLoopbackOrigin(origin)) normalized.push(origin);
  }
  return [...new Set(normalized)];
}

async function loadTrustConfiguration() {
  let managed = {};
  try {
    managed = await chrome.storage.managed.get([
      "trusted_app_origins",
      "trusted_api_origins",
    ]);
  } catch {
    managed = {};
  }

  const appOrigins = normalizeTrustedOrigins([
    ...BUILD_TRUSTED_APP_ORIGINS,
    ...(managed.trusted_app_origins || []),
  ]);
  const apiOrigins = normalizeTrustedOrigins([
    ...BUILD_TRUSTED_API_ORIGINS,
    ...(managed.trusted_api_origins || []),
  ]);

  return {
    appOrigins,
    apiOrigins,
    managed: Boolean(
      (managed.trusted_app_origins || []).length ||
      (managed.trusted_api_origins || []).length
    ),
  };
}

async function readDeployment() {
  const stored = await chrome.storage.local.get(DEPLOYMENT_STORAGE_KEY);
  const value = stored?.[DEPLOYMENT_STORAGE_KEY];
  if (!value || typeof value !== "object" || !value.appOrigin || !value.apiBase) return null;
  return { appOrigin: value.appOrigin, apiBase: value.apiBase, managed: Boolean(value.managed) };
}

async function writeDeployment(deployment) {
  await chrome.storage.local.set({ [DEPLOYMENT_STORAGE_KEY]: deployment });
  return deployment;
}

async function getOrDetectDeployment() {
  const existing = await readDeployment();
  if (existing) return existing;

  const trust = await loadTrustConfiguration();
  if (trust.appOrigins.length && trust.apiOrigins.length) {
    const appOrigin = trust.appOrigins[0];
    const apiBase = normalizeApiBase(trust.apiOrigins[0], appOrigin);
    return writeDeployment({ appOrigin, apiBase, managed: true });
  }
  return null;
}

async function configureDeployment(appUrl) {
  const runtime = await readRuntime();
  assert(
    !runtime.candidateToken,
    "cannot_reconfigure_while_armed",
    "Sign out or release the active lockdown before changing servers"
  );

  const appOrigin = normalizeOrigin(appUrl);
  const apiBase = normalizeApiBase(undefined, appOrigin);
  const trust = await validateBootstrapTrust(appOrigin, apiBase);
  return writeDeployment({ appOrigin, apiBase, managed: trust.managed });
}

function invigilatorHeaders(token, hasBody = false) {
  return {
    Accept: "application/json",
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
    Authorization: `Bearer ${token}`,
    "Cache-Control": "no-store",
  };
}

async function readInvigilatorAuth() {
  const stored = await chrome.storage.local.get(INVIGILATOR_AUTH_STORAGE_KEY);
  const value = stored?.[INVIGILATOR_AUTH_STORAGE_KEY];
  if (!value || typeof value !== "object" || !value.token) return null;
  return value;
}

async function writeInvigilatorAuth(auth) {
  await chrome.storage.local.set({ [INVIGILATOR_AUTH_STORAGE_KEY]: auth });
  return auth;
}

async function clearInvigilatorAuth() {
  await chrome.storage.local.set({ [INVIGILATOR_AUTH_STORAGE_KEY]: null });
}

async function readActiveQuickSession() {
  const stored = await chrome.storage.local.get(ACTIVE_QUICK_SESSION_STORAGE_KEY);
  const value = stored?.[ACTIVE_QUICK_SESSION_STORAGE_KEY];
  if (!value || typeof value !== "object" || !value.sessionId) return null;
  return value;
}

async function writeActiveQuickSession(session) {
  await chrome.storage.local.set({ [ACTIVE_QUICK_SESSION_STORAGE_KEY]: session });
  return session;
}

async function clearActiveQuickSession() {
  await chrome.storage.local.set({ [ACTIVE_QUICK_SESSION_STORAGE_KEY]: null });
}

async function invigilatorLogin({ invId, password }) {
  const { invId: normalizedInvId, password: normalizedPassword } = validateLoginForm({ invId, password });
  const deployment = await getOrDetectDeployment();
  assert(deployment, "deployment_not_configured", "Connect this extension to an AccessGuard server first");

  const response = await fetchWithTimeout(endpointUrl(deployment.apiBase, AUTH_LOGIN_PATH), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ inv_id: normalizedInvId, password: normalizedPassword, login_method: "password" }),
  });
  const data = await readJsonResponse(response, "invigilator_login_failed");
  await writeInvigilatorAuth({ token: data.token, invId: data.inv_id, name: data.name });
  return { invId: data.inv_id, name: data.name };
}

async function invigilatorLogout() {
  await clearInvigilatorAuth();
  await clearActiveQuickSession();
  return { signedOut: true };
}

async function requireInvigilatorContext() {
  const deployment = await getOrDetectDeployment();
  assert(deployment, "deployment_not_configured", "Connect this extension to an AccessGuard server first");
  const auth = await readInvigilatorAuth();
  assert(auth?.token, "invigilator_not_signed_in", "Sign in as an invigilator first");
  return { deployment, auth };
}

async function createQuickSession(form) {
  const { deployment, auth } = await requireInvigilatorContext();
  const payload = buildQuickSessionPayload(form);

  const createResponse = await fetchWithTimeout(endpointUrl(deployment.apiBase, SESSIONS_PATH), {
    method: "POST",
    headers: invigilatorHeaders(auth.token, true),
    body: JSON.stringify(payload),
  });
  const session = await readJsonResponse(createResponse, "quick_session_create_failed");

  const startResponse = await fetchWithTimeout(endpointUrl(deployment.apiBase, `${SESSIONS_PATH}/${session.id}/start`), {
    method: "POST",
    headers: invigilatorHeaders(auth.token, false),
  });
  await readJsonResponse(startResponse, "quick_session_start_failed");

  await writeActiveQuickSession({ sessionId: session.id, sessionCode: session.session_code });
  return { sessionId: session.id, sessionCode: session.session_code };
}

async function endQuickSession() {
  const { deployment, auth } = await requireInvigilatorContext();
  const active = await readActiveQuickSession();
  assert(active?.sessionId, "no_active_quick_session", "No quick session is currently running");

  const response = await fetchWithTimeout(endpointUrl(deployment.apiBase, `${SESSIONS_PATH}/${active.sessionId}/end`), {
    method: "POST",
    headers: invigilatorHeaders(auth.token, false),
  });
  await readJsonResponse(response, "quick_session_end_failed");
  await clearActiveQuickSession();
  return { ended: true };
}

async function joinFromExtension({ sessionCode, studentId, fullName }) {
  const deployment = await getOrDetectDeployment();
  assert(deployment, "deployment_not_configured", "Connect this extension to an AccessGuard server first");

  const current = await readRuntime();
  assert(!current.candidateToken, "already_armed_for_candidate", "This device is already joined to an exam attempt");

  const { sessionCode: code, studentId: id, fullName: name } = validateJoinForm({ sessionCode, studentId, fullName });

  const response = await fetchWithTimeout(endpointUrl(deployment.apiBase, CANDIDATE_JOIN_PATH), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      session_code: code,
      student_id: id,
      full_name: name,
      id_front_b64: "",
      id_back_b64: "",
      selfie_b64: "",
      liveness_passed: true,
      face_match_score: 1,
    }),
  });
  const candidate = await readJsonResponse(response, "extension_join_failed");
  const candidateId = validateCandidateId(candidate?.id);
  const candidateToken = validateCandidateToken(candidate?.candidate_token);

  const armedExamUrl = normalizeExamUrl("/student/exam", deployment.appOrigin);
  const tab = await chrome.tabs.create({ url: armedExamUrl, active: true });

  return finalizeArm({
    candidateId,
    candidateToken,
    apiBase: deployment.apiBase,
    appOrigin: deployment.appOrigin,
    armedExamUrl,
    examTabId: tab.id,
    examWindowId: tab.windowId,
    managed: deployment.managed,
  });
}

async function fetchQuickSessionCandidateCount(apiBase, token, sessionId) {
  const response = await fetchWithTimeout(endpointUrl(apiBase, `${SESSIONS_PATH}/${sessionId}/candidates`), {
    method: "GET",
    headers: invigilatorHeaders(token, false),
  });
  const rows = await readJsonResponse(response, "quick_session_status_failed");
  return Array.isArray(rows) ? rows.length : 0;
}

async function getControlStatus() {
  const deployment = await getOrDetectDeployment();
  const invigilatorAuth = await readInvigilatorAuth();
  const active = await readActiveQuickSession();

  let quickSession = { active: false, sessionId: null, sessionCode: null, candidateCount: 0 };
  if (active?.sessionId && deployment && invigilatorAuth?.token) {
    try {
      const candidateCount = await fetchQuickSessionCandidateCount(deployment.apiBase, invigilatorAuth.token, active.sessionId);
      quickSession = { active: true, sessionId: active.sessionId, sessionCode: active.sessionCode, candidateCount };
    } catch (error) {
      if (error?.code === "candidate_auth_failed") {
        await clearInvigilatorAuth();
        await clearActiveQuickSession();
        return getControlStatus();
      }
      quickSession = { active: true, sessionId: active.sessionId, sessionCode: active.sessionCode, candidateCount: 0 };
    }
  }

  const auth = await readInvigilatorAuth();
  return {
    deployment,
    invigilator: { signedIn: Boolean(auth?.token), invId: auth?.invId || null, name: auth?.name || null },
    quickSession,
  };
}

async function validateBootstrapTrust(appOrigin, apiBase) {
  const normalizedAppOrigin = normalizeOrigin(appOrigin);
  const apiOrigin = normalizeOrigin(apiBase);

  assert(
    isSecureOrLoopbackOrigin(normalizedAppOrigin),
    "insecure_app_origin",
    "The AccessGuard app must use HTTPS (loopback HTTP is allowed for development)"
  );
  assert(
    isSecureOrLoopbackOrigin(apiOrigin),
    "insecure_api_origin",
    "The AccessGuard API must use HTTPS (loopback HTTP is allowed for development)"
  );

  const trust = await loadTrustConfiguration();
  const sameOrigin = normalizedAppOrigin === apiOrigin;
  const loopbackPair = isLoopbackOrigin(normalizedAppOrigin) && isLoopbackOrigin(apiOrigin);
  const explicitlyTrusted =
    trust.appOrigins.includes(normalizedAppOrigin) && trust.apiOrigins.includes(apiOrigin);

  assert(
    sameOrigin || loopbackPair || explicitlyTrusted,
    "untrusted_bootstrap_origin",
    "Cross-origin AccessGuard deployments must configure trusted app and API origins"
  );

  return trust;
}

function senderOrigin(sender) {
  assert(sender?.tab?.id !== undefined, "invalid_sender", "A browser tab is required");
  const origin = safeOrigin(sender.url || sender.tab.url || "");
  assert(origin, "invalid_sender_origin", "The sender must be an HTTP(S) page");
  return origin;
}

function isAuthorizedAppSender(sender, runtime) {
  return Boolean(runtime.appOrigin && safeOrigin(sender?.url || "") === runtime.appOrigin);
}

function isOwnExtensionSender(sender, expectedPage) {
  const url = sender?.url || sender?.tab?.url || "";
  return url.startsWith(chrome.runtime.getURL(expectedPage));
}

function validateCandidateId(value) {
  const candidateId = String(value || "").trim();
  assert(
    /^[A-Za-z0-9_-]{1,128}$/.test(candidateId),
    "invalid_candidate_id",
    "candidateId is invalid"
  );
  return candidateId;
}

function validateCandidateToken(value) {
  const token = String(value || "").trim();
  assert(
    token.length >= 16 && token.length <= 4096 && !/[\r\n]/.test(token),
    "invalid_candidate_token",
    "candidateToken is invalid"
  );
  return token;
}

function endpointUrl(apiBase, path) {
  return `${String(apiBase).replace(/\/$/, "")}${path}`;
}

function candidateHeaders(candidateToken, appOrigin, hasBody = false) {
  return {
    Accept: "application/json",
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
    Authorization: `Bearer ${candidateToken}`,
    "X-Candidate-Token": candidateToken,
    "X-AccessGuard-App-Origin": normalizeOrigin(appOrigin),
    "Cache-Control": "no-store",
  };
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new LockdownError("backend_timeout", "The AccessGuard policy request timed out");
    }
    throw new LockdownError("backend_unreachable", "The AccessGuard policy service is unreachable");
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonResponse(response, errorCode) {
  let data = null;
  try {
    data = await response.json();
  } catch {
    throw new LockdownError(errorCode, "The AccessGuard API returned invalid JSON");
  }

  if (!response.ok) {
    const message = data?.detail || data?.message || `AccessGuard API returned HTTP ${response.status}`;
    throw new LockdownError(
      response.status === 401 || response.status === 403 ? "candidate_auth_failed" : errorCode,
      message
    );
  }
  return data;
}

async function fetchPolicy(runtime) {
  assert(runtime.candidateId && runtime.candidateToken && runtime.apiBase, "not_armed", "Extension is not armed");
  const url = new URL(endpointUrl(runtime.apiBase, POLICY_PATH));
  url.searchParams.set("candidate_id", runtime.candidateId);

  const response = await fetchWithTimeout(url.toString(), {
    method: "GET",
    headers: candidateHeaders(runtime.candidateToken, runtime.appOrigin),
  });
  const raw = await readJsonResponse(response, "policy_fetch_failed");
  const policyBody = raw?.policy && typeof raw.policy === "object" ? raw.policy : raw;

  try {
    return normalizePolicy(policyBody, {
      candidateId: runtime.candidateId,
      appOrigin: runtime.appOrigin,
      examUrl: runtime.armedExamUrl || runtime.examUrl,
    });
  } catch (error) {
    throw new LockdownError("invalid_policy", error.message);
  }
}

async function ownedRuleIds() {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  return rules.map((rule) => rule.id).filter(isOwnedRuleId);
}

async function installNavigationRules(allowedOrigins) {
  const rules = compileNavigationRules(allowedOrigins, MAX_ALLOWED_ORIGINS);
  const removeRuleIds = await ownedRuleIds();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: rules,
  });
}

async function removeNavigationRules() {
  const removeRuleIds = await ownedRuleIds();
  if (!removeRuleIds.length) return;
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: [],
  });
}

function isOwnExtensionUrl(value) {
  return typeof value === "string" && value.startsWith(OWN_EXTENSION_PREFIX);
}

function isAllowedNavigation(value, runtime) {
  if (isOwnExtensionUrl(value)) return true;
  if (value === "about:blank" || value === "") return true;
  return isAllowedHttpNavigation(value, runtime.allowedOrigins);
}

function displayAttempt(value) {
  try {
    return sanitizeAttemptedUrl(value);
  } catch {
    return String(value || "Blocked navigation").slice(0, 1024);
  }
}

function blockedPageUrl(attemptedUrl, reason) {
  const url = new URL(chrome.runtime.getURL("blocked.html"));
  url.searchParams.set("url", displayAttempt(attemptedUrl));
  url.searchParams.set("reason", String(reason || "navigation_blocked").slice(0, 80));
  return url.toString();
}

async function rememberBlockedAttempt(runtime, attemptedUrl, reason) {
  const attempted = displayAttempt(attemptedUrl);
  const previous = runtime.lastBlockedAttempt;
  if (previous?.url === attempted && Date.now() - Date.parse(previous.at || 0) < 1500) {
    return runtime;
  }
  return writeRuntime({
    ...runtime,
    lastBlockedAttempt: {
      url: attempted,
      reason,
      at: new Date().toISOString(),
    },
  });
}

async function redirectBlockedTab(tabId, attemptedUrl, reason = "navigation_blocked") {
  const runtime = await readRuntime();
  if (!runtime.enforcementActive || isAllowedNavigation(attemptedUrl, runtime)) return;
  if (isOwnExtensionUrl(attemptedUrl)) return;

  await rememberBlockedAttempt(runtime, attemptedUrl, reason);
  await chrome.tabs.update(tabId, {
    url: blockedPageUrl(attemptedUrl, reason),
    active: true,
  }).catch(() => undefined);
}

async function enforceExistingTabs(runtime) {
  if (!runtime.enforcementActive) return;
  const tabs = await chrome.tabs.query({}).catch(() => []);
  await Promise.allSettled(
    tabs.map(async (tab) => {
      const url = tab.pendingUrl || tab.url || "";
      if (isAllowedNavigation(url, runtime)) return;
      await redirectBlockedTab(tab.id, url, "existing_tab_not_allowed");
    })
  );
}

async function focusExamWindow(runtime) {
  if (!runtime.enforcementActive || !Number.isInteger(runtime.examWindowId)) return;
  let current = null;
  try {
    current = await chrome.windows.get(runtime.examWindowId);
  } catch {
    return;
  }
  if (!current) return;
  // Only change what differs. Re-applying focus/fullscreen to a window that is
  // already compliant makes the exam page blur and can exit HTML fullscreen,
  // which the page would otherwise record as a student violation.
  const update = {};
  if (!current.focused) update.focused = true;
  if (current.state !== "fullscreen") update.state = "fullscreen";
  if (!Object.keys(update).length) return;
  await chrome.windows.update(runtime.examWindowId, update).catch(() => undefined);
}

async function sendHeartbeat(runtime, reason = "periodic", policyOverride = null) {
  if (!runtime.candidateId || !runtime.candidateToken || !runtime.apiBase) return runtime;

  let activeOrigin = null;
  let activeUrl = null;
  let fullscreen = false;
  let openTabCount = 0;
  try {
    const activeWindow = await chrome.windows.getLastFocused();
    fullscreen = activeWindow?.state === "fullscreen";
    const openTabs = await chrome.tabs.query({});
    openTabCount = openTabs.length;
    if (activeWindow?.id !== undefined) {
      const [activeTab] = await chrome.tabs.query({ active: true, windowId: activeWindow.id });
      activeOrigin = safeOrigin(activeTab?.url || activeTab?.pendingUrl || "");
      if (activeOrigin) {
        const candidateUrl = activeTab?.url || activeTab?.pendingUrl || null;
        activeUrl = candidateUrl && candidateUrl.length <= 2048 ? candidateUrl : activeOrigin;
      }
    }
  } catch {
    // Heartbeat remains useful without focus metadata.
  }

  const nextSequence = Number(runtime.heartbeatSequence || 0) + 1;
  const body = {
    candidate_id: runtime.candidateId,
    extension_version: manifest.version,
    policy_version: Number(policyOverride?.policyVersion || runtime.policyVersion || 0),
    sequence: nextSequence,
    fullscreen,
    enforcement_active: Boolean(runtime.enforcementActive),
    active_url: activeUrl,
    active_origin: activeOrigin,
    open_tab_count: openTabCount,
  };

  try {
    const response = await fetchWithTimeout(endpointUrl(runtime.apiBase, HEARTBEAT_PATH), {
      method: "POST",
      headers: candidateHeaders(runtime.candidateToken, runtime.appOrigin, true),
      body: JSON.stringify(body),
    });
    await readJsonResponse(response, "heartbeat_failed");
    const latest = await readRuntime();
    if (latest.candidateId !== runtime.candidateId) return latest;
    return writeRuntime({
      ...latest,
      lastHeartbeatAt: new Date().toISOString(),
      heartbeatSequence: nextSequence,
      lastError: latest.mode === "fail_closed" ? latest.lastError : null,
    });
  } catch (error) {
    const latest = await readRuntime();
    if (latest.candidateId !== runtime.candidateId) return latest;
    return writeRuntime({
      ...latest,
      lastError: errorDetails(error, "heartbeat_failed"),
    });
  }
}

async function authenticatedRelease(runtime, policy) {
  // This function is only called with policy returned by fetchPolicy(). No page,
  // popup, or blocked-page message has a code path to remove DNR rules.
  await sendHeartbeat(runtime, "backend_release", policy).catch(() => undefined);
  await removeNavigationRules();

  if (Number.isInteger(runtime.examWindowId)) {
    await chrome.windows.update(runtime.examWindowId, { state: "normal" }).catch(() => undefined);
  }

  return writeRuntime({
    ...runtime,
    mode: "released",
    backendState: policy.state,
    enforcementActive: false,
    candidateToken: null,
    sessionId: policy.sessionId,
    policyVersion: policy.policyVersion,
    allowedOrigins: [],
    policyIssuedAt: policy.issuedAt,
    policyExpiresAt: policy.expiresAt,
    lastPolicyAt: new Date().toISOString(),
    lastError: null,
    releasedAt: new Date().toISOString(),
    examTabId: null,
    examWindowId: null,
  });
}

async function applyMonitoringPolicy(runtime, policy) {
  // A non-enforcing policy is still authenticated backend authority. It is the
  // only non-terminal path, besides authenticatedRelease(), permitted to remove
  // navigation rules. Keep the credential so later policy versions can enforce.
  await removeNavigationRules();

  if (Number.isInteger(runtime.examWindowId)) {
    await chrome.windows.update(runtime.examWindowId, { state: "normal" }).catch(() => undefined);
  }

  const apiOrigin = normalizeOrigin(runtime.apiBase);
  const examOrigin = policy.examUrl ? normalizeOrigin(policy.examUrl) : runtime.appOrigin;
  const allowedOrigins = normalizeOriginList([
    runtime.appOrigin,
    apiOrigin,
    examOrigin,
    ...policy.appOrigins,
    ...policy.allowedOrigins,
  ]);

  const next = await writeRuntime({
    ...runtime,
    mode: "monitoring",
    backendState: policy.state,
    enforcementActive: false,
    sessionId: policy.sessionId,
    policyVersion: policy.policyVersion,
    examUrl: policy.examUrl || runtime.examUrl,
    allowedOrigins,
    policyIssuedAt: policy.issuedAt,
    policyExpiresAt: policy.expiresAt,
    lastPolicyAt: new Date().toISOString(),
    lastError: null,
    releasedAt: null,
  });
  void sendHeartbeat(next, "monitoring_policy");
  return next;
}

async function applyPolicy(runtime, policy) {
  if (RELEASE_POLICY_STATES.includes(policy.state)) {
    return authenticatedRelease(runtime, policy);
  }
  if (!policy.enforcement) {
    return applyMonitoringPolicy(runtime, policy);
  }
  assert(
    ENFORCED_POLICY_STATES.includes(policy.state),
    "invalid_policy_state",
    "Policy state is neither enforced nor released"
  );

  const apiOrigin = normalizeOrigin(runtime.apiBase);
  const examOrigin = normalizeOrigin(policy.examUrl);
  const allowedOrigins = normalizeOriginList([
    runtime.appOrigin,
    apiOrigin,
    examOrigin,
    ...policy.appOrigins,
    ...policy.allowedOrigins,
  ]);

  // DNR updates are atomic. If this call fails, an existing rule set remains in
  // place and policy failure handling leaves the extension fail-closed.
  await installNavigationRules(allowedOrigins);

  const next = await writeRuntime({
    ...runtime,
    mode: policy.state === "locked" ? "locked" : "enforced",
    backendState: policy.state,
    enforcementActive: true,
    sessionId: policy.sessionId,
    policyVersion: policy.policyVersion,
    examUrl: policy.examUrl,
    allowedOrigins,
    policyIssuedAt: policy.issuedAt,
    policyExpiresAt: policy.expiresAt,
    lastPolicyAt: new Date().toISOString(),
    lastError: null,
    releasedAt: null,
  });

  await enforceExistingTabs(next);
  // Periodic policy refreshes must not keep grabbing the window; only take
  // focus when enforcement starts or resumes after a failure.
  if (!runtime.enforcementActive || runtime.mode === "fail_closed") {
    await focusExamWindow(next);
  }
  return next;
}

async function recordPolicyFailure(runtime, error, { initial = false } = {}) {
  if (runtime.enforcementActive) {
    const failed = await writeRuntime({
      ...runtime,
      mode: "fail_closed",
      enforcementActive: true,
      lastError: errorDetails(error, "policy_refresh_failed"),
    });
    await enforceExistingTabs(failed);
    return failed;
  }

  if (runtime.mode === "monitoring" && runtime.candidateToken) {
    return writeRuntime({
      ...runtime,
      enforcementActive: false,
      lastError: errorDetails(error, "policy_refresh_failed"),
    });
  }

  const failed = await writeRuntime({
    ...runtime,
    mode: "error",
    enforcementActive: false,
    candidateToken: initial ? null : runtime.candidateToken,
    lastError: errorDetails(error, "policy_fetch_failed"),
  });
  return failed;
}

async function refreshPolicy({ initial = false } = {}) {
  const runtime = await readRuntime();
  try {
    const policy = await fetchPolicy(runtime);
    return await applyPolicy(runtime, policy);
  } catch (error) {
    await recordPolicyFailure(runtime, error, { initial });
    throw error;
  }
}

async function finalizeArm({
  candidateId,
  candidateToken,
  apiBase,
  appOrigin,
  armedExamUrl,
  examTabId,
  examWindowId,
  managed,
}) {
  const arming = await writeRuntime({
    ...defaultRuntime(),
    mode: "arming",
    candidateId,
    candidateToken,
    apiBase,
    appOrigin,
    armedExamUrl,
    examUrl: armedExamUrl,
    examTabId,
    examWindowId,
    managed,
    armedAt: new Date().toISOString(),
    lastError: null,
  });

  const next = await refreshPolicy({ initial: !arming.enforcementActive });
  void sendHeartbeat(next, "armed");
  return next;
}

async function armFromPage(payload, sender) {
  const actualOrigin = senderOrigin(sender);
  const requestedAppOrigin = normalizeOrigin(payload?.appOrigin || actualOrigin);
  assert(
    requestedAppOrigin === actualOrigin,
    "app_origin_mismatch",
    "ARM appOrigin must match the page that sent the request"
  );

  const candidateId = validateCandidateId(payload?.candidateId);
  const candidateToken = validateCandidateToken(payload?.candidateToken);
  const apiBase = normalizeApiBase(payload?.apiBase, requestedAppOrigin);
  const trust = await validateBootstrapTrust(requestedAppOrigin, apiBase);
  const current = await readRuntime();
  const senderUrl = new URL(sender.url || sender.tab.url);
  senderUrl.hash = "";
  const armedExamUrl = senderUrl.toString();

  if (current.candidateToken && current.candidateId) {
    assert(
      current.candidateId === candidateId && current.appOrigin === requestedAppOrigin,
      "attempt_already_active",
      "A different AccessGuard attempt is already enforced"
    );
    assert(
      current.apiBase === apiBase,
      "api_origin_change_denied",
      "An active attempt cannot switch to a different API base"
    );

    // Do not overwrite the last working credential until the replacement has
    // authenticated successfully. A compromised page can therefore request a
    // refresh but cannot strand an active attempt with a bogus token.
    const proposed = {
      ...current,
      candidateToken,
      armedExamUrl,
      examUrl: armedExamUrl,
      examTabId: sender.tab.id,
      examWindowId: sender.tab.windowId,
      managed: trust.managed,
    };
    try {
      const policy = await fetchPolicy(proposed);
      const next = await applyPolicy(proposed, policy);
      void sendHeartbeat(next, "rearmed");
      return next;
    } catch (error) {
      await recordPolicyFailure(current, error);
      throw error;
    }
  }

  return finalizeArm({
    candidateId,
    candidateToken,
    apiBase,
    appOrigin: requestedAppOrigin,
    armedExamUrl,
    examTabId: sender.tab.id,
    examWindowId: sender.tab.windowId,
    managed: trust.managed,
  });
}

async function requestAccess(attemptedUrl, sender) {
  assert(
    isOwnExtensionSender(sender, "blocked.html"),
    "invalid_sender",
    "Access requests are accepted only from the AccessGuard blocked page"
  );
  const runtime = await readRuntime();
  assert(runtime.enforcementActive, "not_enforced", "Lockdown is not currently enforced");
  assert(runtime.candidateToken && runtime.sessionId, "not_armed", "Candidate policy is unavailable");

  const sanitizedUrl = sanitizeAttemptedUrl(attemptedUrl);
  assert(
    !isAllowedHttpNavigation(sanitizedUrl, runtime.allowedOrigins),
    "already_allowed",
    "This origin is already allowed by the current invigilator policy"
  );

  const body = {
    candidate_id: runtime.candidateId,
    url: sanitizedUrl,
    reason: "Student requested access from the AccessGuard blocked navigation page",
  };
  const response = await fetchWithTimeout(endpointUrl(runtime.apiBase, ACCESS_REQUEST_PATH), {
    method: "POST",
    headers: candidateHeaders(runtime.candidateToken, runtime.appOrigin, true),
    body: JSON.stringify(body),
  });
  const data = await readJsonResponse(response, "access_request_failed");
  return {
    submitted: true,
    requestId: data?.request_id || data?.id || data?.access_request?.id || null,
    status: data?.status || data?.access_request?.status || "pending",
    message: data?.message || "Request sent to the invigilator.",
  };
}

async function checkRequestedAccess(attemptedUrl, sender) {
  assert(
    isOwnExtensionSender(sender, "blocked.html"),
    "invalid_sender",
    "Access checks are accepted only from the AccessGuard blocked page"
  );
  const sanitizedUrl = sanitizeAttemptedUrl(attemptedUrl);
  const before = await readRuntime();
  if (before.candidateToken) {
    try {
      await refreshPolicy();
    } catch {
      // refreshPolicy already records fail-closed status.
    }
  }
  const current = await readRuntime();
  return {
    allowed: !current.enforcementActive || isAllowedHttpNavigation(sanitizedUrl, current.allowedOrigins),
    status: publicStatus(current),
  };
}

async function returnToExam(sender) {
  assert(
    isOwnExtensionSender(sender, "blocked.html"),
    "invalid_sender",
    "Return-to-exam is accepted only from the AccessGuard blocked page"
  );
  const runtime = await readRuntime();
  const returnUrl = runtime.armedExamUrl || runtime.examUrl;
  assert(returnUrl, "exam_url_missing", "Exam URL is unavailable");
  assert(
    !runtime.enforcementActive || isAllowedNavigation(returnUrl, runtime),
    "exam_url_not_allowed",
    "The authenticated policy does not allow the exam URL"
  );
  await chrome.tabs.update(sender.tab.id, { url: returnUrl, active: true });
  return { navigated: true };
}

async function handleBridgeMessage(message, sender) {
  const action = message?.action;
  const runtime = await readRuntime();

  if (action === "DISCOVER") {
    const full = isAuthorizedAppSender(sender, runtime);
    return publicStatus(runtime, { minimal: !full });
  }

  if (action === "ARM") {
    return publicStatus(await armFromPage(message.payload || {}, sender));
  }

  assert(
    isAuthorizedAppSender(sender, runtime),
    "unauthorized_page",
    "Only the armed AccessGuard application origin may read or refresh policy status"
  );

  if (action === "STATUS") return publicStatus(runtime);
  if (action === "REFRESH_POLICY") {
    return publicStatus(await refreshPolicy());
  }

  throw new LockdownError("unsupported_action", `Unsupported bridge action: ${action || "missing"}`);
}

async function handleBlockedMessage(message, sender) {
  if (message?.action === "GET_STATUS") return publicStatus(await readRuntime());
  if (message?.action === "REQUEST_ACCESS") return requestAccess(message.url, sender);
  if (message?.action === "CHECK_ACCESS") return checkRequestedAccess(message.url, sender);
  if (message?.action === "RETURN_TO_EXAM") return returnToExam(sender);
  throw new LockdownError("unsupported_action", "Unsupported blocked-page action");
}

async function handlePopupMessage(message, sender) {
  assert(
    isOwnExtensionSender(sender, "popup.html"),
    "invalid_sender",
    "Popup diagnostics are available only to the extension popup"
  );
  if (message?.action === "GET_STATUS") return publicStatus(await readRuntime());
  if (message?.action === "REFRESH_POLICY") {
    const runtime = await readRuntime();
    assert(runtime.candidateToken, "not_armed", "No authenticated candidate policy is active");
    return publicStatus(await refreshPolicy());
  }
  if (message?.action === "GET_DEPLOYMENT") return getOrDetectDeployment();
  if (message?.action === "CONFIGURE_DEPLOYMENT") return configureDeployment(message.appUrl);
  if (message?.action === "GET_CONTROL_STATUS") return getControlStatus();
  if (message?.action === "INVIGILATOR_LOGIN") return invigilatorLogin(message);
  if (message?.action === "INVIGILATOR_LOGOUT") return invigilatorLogout();
  if (message?.action === "CREATE_QUICK_SESSION") return createQuickSession(message);
  if (message?.action === "END_QUICK_SESSION") return endQuickSession();
  if (message?.action === "EXTENSION_JOIN") return publicStatus(await joinFromExtension(message));
  throw new LockdownError("unsupported_action", "Unsupported popup action");
}

async function dispatchMessage(message, sender) {
  if (message?.scope === BRIDGE_SCOPE) return handleBridgeMessage(message, sender);
  if (message?.scope === BLOCKED_SCOPE) return handleBlockedMessage(message, sender);
  if (message?.scope === POPUP_SCOPE) return handlePopupMessage(message, sender);
  throw new LockdownError("invalid_message", "Unrecognized AccessGuard extension message");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  serialize(() => dispatchMessage(message, sender))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({
      ok: false,
      error: errorDetails(error),
    }));
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.pendingUrl || tab.url || "";
  if (!url || url === "about:blank") return;
  void serialize(async () => {
    const runtime = await readRuntime();
    if (runtime.enforcementActive && !isAllowedNavigation(url, runtime)) {
      await redirectBlockedTab(tabId, url, "tab_navigation_not_allowed");
    }
  });
});

chrome.tabs.onCreated.addListener((tab) => {
  const url = tab.pendingUrl || tab.url || "";
  if (!url || url === "about:blank") return;
  void serialize(async () => {
    const runtime = await readRuntime();
    if (runtime.enforcementActive && !isAllowedNavigation(url, runtime)) {
      await redirectBlockedTab(tab.id, url, "new_tab_not_allowed");
    }
  });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void serialize(async () => {
    const runtime = await readRuntime();
    if (!runtime.enforcementActive) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const url = tab?.pendingUrl || tab?.url || "";
    if (url && !isAllowedNavigation(url, runtime)) {
      await redirectBlockedTab(tabId, url, "activated_tab_not_allowed");
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void serialize(async () => {
    const runtime = await readRuntime();
    const restoreUrl = runtime.armedExamUrl || runtime.examUrl;
    if (!runtime.enforcementActive || runtime.examTabId !== tabId || !restoreUrl) return;
    const replacement = await chrome.tabs.create({ url: restoreUrl, active: true });
    const next = await writeRuntime({
      ...runtime,
      examTabId: replacement.id,
      examWindowId: replacement.windowId,
      lastError: errorDetails(
        new LockdownError("exam_tab_closed", "The exam tab was closed and has been restored"),
        "exam_tab_closed"
      ),
    });
    await focusExamWindow(next);
  });
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0 || !details.url) return;
  void serialize(async () => {
    const runtime = await readRuntime();
    if (runtime.enforcementActive && !isAllowedNavigation(details.url, runtime)) {
      await redirectBlockedTab(details.tabId, details.url, "web_navigation_not_allowed");
    }
  });
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) return;
  void serialize(async () => {
    const runtime = await readRuntime();
    if (!runtime.enforcementActive) return;
    await focusExamWindow(runtime);
    void sendHeartbeat(runtime, "browser_focus_lost");
  });
});

chrome.idle.onStateChanged.addListener((state) => {
  void serialize(async () => {
    const runtime = await readRuntime();
    if (runtime.enforcementActive) void sendHeartbeat(runtime, `browser_${state}`);
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== POLICY_ALARM) return;
  void serialize(async () => {
    let runtime = await readRuntime();
    if (!runtime.candidateToken) return;
    try {
      runtime = await refreshPolicy();
    } catch {
      runtime = await readRuntime();
    }
    if (runtime.candidateToken) await sendHeartbeat(runtime, "periodic");
  });
});

async function ensurePolicyAlarm() {
  await chrome.alarms.create(POLICY_ALARM, {
    delayInMinutes: POLICY_REFRESH_MINUTES,
    periodInMinutes: POLICY_REFRESH_MINUTES,
  });
}

async function restoreEnforcement() {
  await configureStorageAccess();
  await ensurePolicyAlarm();
  let runtime = await readRuntime();
  const ruleIds = await ownedRuleIds().catch(() => []);

  if (runtime.enforcementActive) {
    try {
      await installNavigationRules(runtime.allowedOrigins);
      await enforceExistingTabs(runtime);
      if (runtime.candidateToken) {
        try {
          runtime = await refreshPolicy();
        } catch {
          runtime = await readRuntime();
        }
      } else {
        runtime = await writeRuntime({
          ...runtime,
          mode: "fail_closed",
          lastError: errorDetails(new LockdownError(
            "candidate_token_missing",
            "Lockdown rules remain active, but backend authentication is unavailable"
          )),
        });
      }
      await focusExamWindow(runtime);
    } catch (error) {
      await recordPolicyFailure(runtime, error);
    }
    return;
  }

  if (runtime.candidateToken) {
    try {
      runtime = await refreshPolicy();
      if (runtime.candidateToken) await sendHeartbeat(runtime, "worker_restored");
    } catch {
      runtime = await readRuntime();
      if (ruleIds.length && !runtime.enforcementActive) {
        await writeRuntime({
          ...runtime,
          mode: "fail_closed",
          enforcementActive: true,
          lastError: errorDetails(new LockdownError(
            "policy_recovery_failed",
            "Persistent lockdown rules remain active until authenticated policy recovery succeeds"
          )),
        });
      }
    }
    return;
  }

  if (ruleIds.length && runtime.mode !== "released") {
    // Storage corruption or manual data clearing must not silently unlock an
    // active exam. The popup explains that backend/admin recovery is required.
    await writeRuntime({
      ...runtime,
      mode: "fail_closed",
      enforcementActive: true,
      lastError: errorDetails(new LockdownError(
        "orphaned_lockdown_rules",
        "Persistent lockdown rules exist without a recoverable candidate policy"
      )),
    });
  } else if (runtime.mode === "released" && ruleIds.length) {
    await removeNavigationRules();
  } else {
    await updateBadge(runtime);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void serialize(restoreEnforcement);
});

chrome.runtime.onStartup.addListener(() => {
  void serialize(restoreEnforcement);
});

// Service workers may start for an event other than onStartup. Reconcile state
// on every worker lifetime without waiting for the next alarm.
void serialize(restoreEnforcement);

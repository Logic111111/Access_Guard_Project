const PAGE_SOURCE = "accessguard-web";
const EXTENSION_SOURCE = "accessguard-extension";
const REQUEST_TYPE = "AG_LOCKDOWN_REQUEST";
const RESPONSE_TYPE = "AG_LOCKDOWN_RESPONSE";
const EVENT_TYPE = "AG_LOCKDOWN_EVENT";
const DEFAULT_TIMEOUT_MS = 2500;

function makeRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `ag-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function requestLockdownExtension(action, payload = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Lockdown extension bridge is only available in a browser."));
  }

  return new Promise((resolve, reject) => {
    const requestId = makeRequestId();
    let timer;

    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      if (timer) window.clearTimeout(timer);
    };

    const onMessage = (event) => {
      if (event.source !== window) return;
      const message = event.data;
      if (
        !message ||
        message.source !== EXTENSION_SOURCE ||
        message.type !== RESPONSE_TYPE ||
        message.requestId !== requestId
      ) return;

      cleanup();
      if (message.ok) {
        resolve(message.data || {});
      } else {
        const error = new Error(message.error?.message || message.error || "Lockdown extension request failed.");
        if (message.error?.code) error.code = message.error.code;
        reject(error);
      }
    };

    window.addEventListener("message", onMessage);
    timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("AccessGuard extension was not detected."));
    }, timeoutMs);

    window.postMessage({
      source: PAGE_SOURCE,
      type: REQUEST_TYPE,
      requestId,
      action,
      payload,
    }, window.location.origin);
  });
}

export function subscribeToLockdownStatus(handler) {
  if (typeof window === "undefined") return () => {};
  const onMessage = (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (
      message?.source === EXTENSION_SOURCE &&
      message?.type === EVENT_TYPE &&
      message?.event === "STATUS"
    ) handler(message.data || {});
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

export async function discoverLockdownExtension() {
  return requestLockdownExtension("DISCOVER");
}

export async function armLockdownExtension({ candidateId, candidateToken, apiBase }) {
  return requestLockdownExtension("ARM", {
    candidateId,
    candidateToken,
    apiBase,
    appOrigin: window.location.origin,
  }, 8000);
}

export async function readLockdownStatus() {
  return requestLockdownExtension("STATUS");
}

export async function refreshLockdownPolicy() {
  return requestLockdownExtension("REFRESH_POLICY", {}, 8000);
}

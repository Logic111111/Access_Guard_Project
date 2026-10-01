(() => {
  "use strict";

  const WEB_SOURCE = "accessguard-web";
  const EXTENSION_SOURCE = "accessguard-extension";
  const REQUEST_TYPE = "AG_LOCKDOWN_REQUEST";
  const RESPONSE_TYPE = "AG_LOCKDOWN_RESPONSE";
  const EVENT_TYPE = "AG_LOCKDOWN_EVENT";
  const BRIDGE_SCOPE = "accessguard-content-bridge";
  const INTERNAL_SCOPE = "accessguard-internal";
  const ACTIONS = new Set(["DISCOVER", "ARM", "STATUS", "REFRESH_POLICY"]);
  let subscribed = false;

  function postToPage(message) {
    window.postMessage(message, window.location.origin);
  }

  function extensionError(error) {
    return {
      code: error?.code || "extension_unavailable",
      message: error?.message || String(error || "AccessGuard extension is unavailable"),
    };
  }

  function sendToWorker(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const request = event.data;
    if (
      !request ||
      request.source !== WEB_SOURCE ||
      request.type !== REQUEST_TYPE ||
      !ACTIONS.has(request.action)
    ) {
      return;
    }

    const requestId = typeof request.requestId === "string"
      ? request.requestId.slice(0, 160)
      : "";
    if (!requestId) return;

    subscribed = true;
    try {
      const result = await sendToWorker({
        scope: BRIDGE_SCOPE,
        action: request.action,
        payload: request.payload && typeof request.payload === "object" ? request.payload : {},
      });
      postToPage({
        source: EXTENSION_SOURCE,
        type: RESPONSE_TYPE,
        requestId,
        ok: Boolean(result?.ok),
        data: result?.data || null,
        error: result?.ok ? null : (result?.error || extensionError()),
      });
    } catch (error) {
      postToPage({
        source: EXTENSION_SOURCE,
        type: RESPONSE_TYPE,
        requestId,
        ok: false,
        data: null,
        error: extensionError(error),
      });
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!subscribed || message?.scope !== INTERNAL_SCOPE || message?.action !== "STATUS_PUSH") {
      return;
    }
    postToPage({
      source: EXTENSION_SOURCE,
      type: EVENT_TYPE,
      event: "STATUS",
      data: message.data || null,
    });
  });
})();

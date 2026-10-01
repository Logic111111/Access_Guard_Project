"use strict";

const params = new URLSearchParams(window.location.search);
const attemptedUrl = params.get("url") || "";
const attemptedEl = document.getElementById("attempted-url");
const requestButton = document.getElementById("request-access");
const returnButton = document.getElementById("return-exam");
const notice = document.getElementById("notice");
const statusPill = document.getElementById("lockdown-status");
let pollTimer = null;
let pollCount = 0;
let checkingApproval = false;

attemptedEl.textContent = attemptedUrl || "Unknown destination";

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ scope: "accessguard-blocked", ...message }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      if (!response?.ok) {
        const error = new Error(response?.error?.message || "Extension request failed");
        error.code = response?.error?.code;
        reject(error);
        return;
      }
      resolve(response.data);
    });
  });
}

function setNotice(message, kind = "") {
  notice.textContent = message || "";
  notice.className = `notice ${kind}`.trim();
}

function renderStatus(status) {
  const mode = status?.mode || "unknown";
  statusPill.textContent = `Lockdown ${mode.replaceAll("_", " ")}`;
  statusPill.classList.toggle("danger", mode === "locked" || mode === "fail_closed");
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function checkApproval() {
  if (!attemptedUrl || checkingApproval) return;
  checkingApproval = true;
  pollCount += 1;
  try {
    const result = await send({ action: "CHECK_ACCESS", url: attemptedUrl });
    renderStatus(result.status);
    if (result.allowed) {
      stopPolling();
      setNotice("The invigilator policy now allows this destination. Opening it…", "success");
      window.location.replace(attemptedUrl);
    } else if (pollCount >= 60) {
      stopPolling();
      setNotice("Approval is still pending. You can request access again or return to the exam.");
      requestButton.disabled = false;
    }
  } catch (error) {
    setNotice(error.message, "error");
  } finally {
    checkingApproval = false;
  }
}

function startPolling() {
  stopPolling();
  pollCount = 0;
  pollTimer = setInterval(checkApproval, 5_000);
  void checkApproval();
}

requestButton.addEventListener("click", async () => {
  requestButton.disabled = true;
  setNotice("Sending request to the invigilator…");
  try {
    const result = await send({ action: "REQUEST_ACCESS", url: attemptedUrl });
    setNotice(result.message || "Request sent. Waiting for an invigilator decision.", "success");
    startPolling();
  } catch (error) {
    requestButton.disabled = false;
    setNotice(error.message, "error");
  }
});

returnButton.addEventListener("click", async () => {
  returnButton.disabled = true;
  try {
    await send({ action: "RETURN_TO_EXAM" });
  } catch (error) {
    returnButton.disabled = false;
    setNotice(error.message, "error");
  }
});

window.addEventListener("beforeunload", stopPolling);

void send({ action: "GET_STATUS" })
  .then(renderStatus)
  .catch((error) => setNotice(error.message, "error"));

if (!attemptedUrl) {
  requestButton.disabled = true;
  setNotice("The attempted address was unavailable. Return to the exam.", "error");
}

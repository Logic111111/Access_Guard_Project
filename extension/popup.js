"use strict";

const el = (id) => document.getElementById(id);

function send(action, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ scope: "accessguard-popup", action, ...extra }, (response) => {
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

function timeLabel(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleTimeString();
}

function getRole() {
  try {
    return localStorage.getItem("accessguardPopupRole") || "student";
  } catch {
    return "student";
  }
}

function setRole(role) {
  try {
    localStorage.setItem("accessguardPopupRole", role);
  } catch {
    // Best-effort; the role tab still renders for this popup lifetime.
  }
}

function renderCandidateStatus(status) {
  el("popup-status").textContent = String(status?.mode || "unknown").replaceAll("_", " ");
  el("popup-status").classList.toggle("danger", status?.mode === "locked" || status?.mode === "fail_closed");
  el("backend-state").textContent = status?.backendState || "—";
  el("policy-version").textContent = status?.policyVersion || "—";
  el("session-id").textContent = status?.sessionId || "—";
  el("allowed-count").textContent = String(status?.allowedOrigins?.length || 0);
  el("policy-checked").textContent = timeLabel(status?.lastPolicyAt);
  el("heartbeat-at").textContent = timeLabel(status?.lastHeartbeatAt);
  el("managed-trust").textContent = status?.managed ? "Yes" : "No";
}

let pollTimer = null;
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function renderInvigilatorPanel() {
  el("invigilator-notice").textContent = "";
  const control = await send("GET_CONTROL_STATUS");

  el("invigilator-session-bar").hidden = !control.invigilator.signedIn;
  el("invigilator-name").textContent = control.invigilator.signedIn
    ? `Signed in as ${control.invigilator.name || control.invigilator.invId}`
    : "";
  el("invigilator-login-view").hidden = control.invigilator.signedIn;
  el("quick-create-view").hidden = !control.invigilator.signedIn || control.quickSession.active;
  el("quick-active-view").hidden = !control.invigilator.signedIn || !control.quickSession.active;

  if (control.quickSession.active) {
    el("quick-active-code").textContent = control.quickSession.sessionCode || "—";
    el("quick-active-count").textContent = String(control.quickSession.candidateCount || 0);
    stopPolling();
    pollTimer = setInterval(async () => {
      try {
        const refreshed = await send("GET_CONTROL_STATUS");
        el("quick-active-count").textContent = String(refreshed.quickSession.candidateCount || 0);
        if (!refreshed.quickSession.active) await renderInvigilatorPanel();
      } catch {
        // A transient poll failure is not worth surfacing; the next tick retries.
      }
    }, 5000);
  } else {
    stopPolling();
  }

  return control;
}

async function renderStudentPanel() {
  el("student-notice").textContent = "";
  const status = await send("GET_STATUS");
  const armed = Boolean(status?.mode) && status.mode !== "inactive" && status.mode !== "available";
  el("student-join-view").hidden = armed;
  el("student-armed-view").hidden = !armed;
  if (armed) renderCandidateStatus(status);
}

async function renderRoleView() {
  const role = getRole();
  el("role-tab-invigilator").classList.toggle("active", role === "invigilator");
  el("role-tab-student").classList.toggle("active", role === "student");
  el("invigilator-panel").hidden = role !== "invigilator";
  el("student-panel").hidden = role !== "student";
  stopPolling();
  if (role === "invigilator") {
    await renderInvigilatorPanel();
  } else {
    await renderStudentPanel();
  }
}

async function init() {
  const deployment = await send("GET_DEPLOYMENT");
  el("setup-view").hidden = Boolean(deployment);
  el("role-view").hidden = !deployment;
  if (deployment) await renderRoleView();
}

el("setup-connect-btn").addEventListener("click", async () => {
  el("setup-notice").textContent = "Connecting…";
  el("setup-notice").className = "notice";
  try {
    await send("CONFIGURE_DEPLOYMENT", { appUrl: el("setup-app-url").value });
    await init();
  } catch (error) {
    el("setup-notice").textContent = error.message;
    el("setup-notice").className = "notice error";
  }
});

el("role-tab-invigilator").addEventListener("click", () => { setRole("invigilator"); void renderRoleView(); });
el("role-tab-student").addEventListener("click", () => { setRole("student"); void renderRoleView(); });

el("inv-login-btn").addEventListener("click", async () => {
  el("invigilator-notice").textContent = "Signing in…";
  el("invigilator-notice").className = "notice";
  try {
    await send("INVIGILATOR_LOGIN", {
      invId: el("inv-id-input").value,
      password: el("inv-password-input").value,
    });
    await renderInvigilatorPanel();
  } catch (error) {
    el("invigilator-notice").textContent = error.message;
    el("invigilator-notice").className = "notice error";
  }
});

el("inv-signout-btn").addEventListener("click", async () => {
  await send("INVIGILATOR_LOGOUT");
  await renderInvigilatorPanel();
});

el("quick-start-btn").addEventListener("click", async () => {
  el("invigilator-notice").textContent = "Starting quick session…";
  el("invigilator-notice").className = "notice";
  try {
    await send("CREATE_QUICK_SESSION", {
      examName: el("quick-exam-name").value,
      durationMinutes: el("quick-duration").value,
      questionText: el("quick-question").value,
      modelAnswer: el("quick-model-answer").value,
      whitelistedUrls: el("quick-urls").value.split("\n").map((line) => line.trim()).filter(Boolean),
    });
    el("invigilator-notice").textContent = "";
    await renderInvigilatorPanel();
  } catch (error) {
    el("invigilator-notice").textContent = error.message;
    el("invigilator-notice").className = "notice error";
  }
});

el("quick-end-btn").addEventListener("click", async () => {
  try {
    await send("END_QUICK_SESSION");
    await renderInvigilatorPanel();
  } catch (error) {
    el("invigilator-notice").textContent = error.message;
    el("invigilator-notice").className = "notice error";
  }
});

el("quick-dashboard-btn").addEventListener("click", async () => {
  const [deployment, control] = await Promise.all([send("GET_DEPLOYMENT"), send("GET_CONTROL_STATUS")]);
  if (deployment?.appOrigin && control?.quickSession?.sessionId) {
    chrome.tabs.create({ url: `${deployment.appOrigin}/sessions/${control.quickSession.sessionId}/dashboard` });
  }
});

el("join-btn").addEventListener("click", async () => {
  el("student-notice").textContent = "Joining…";
  el("student-notice").className = "notice";
  try {
    await send("EXTENSION_JOIN", {
      sessionCode: el("join-code-input").value,
      studentId: el("join-student-id-input").value,
      fullName: el("join-name-input").value,
    });
    await renderStudentPanel();
  } catch (error) {
    el("student-notice").textContent = error.message;
    el("student-notice").className = "notice error";
  }
});

el("refresh-policy").addEventListener("click", async () => {
  el("refresh-policy").disabled = true;
  try {
    renderCandidateStatus(await send("REFRESH_POLICY"));
  } catch (error) {
    el("student-notice").textContent = error.message;
    el("student-notice").className = "notice error";
  } finally {
    el("refresh-policy").disabled = false;
  }
});

void init();

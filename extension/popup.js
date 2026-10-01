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

function getInvigilatorSubtab() {
  try {
    return localStorage.getItem("accessguardPopupInvSubtab") || "quick";
  } catch {
    return "quick";
  }
}

function setInvigilatorSubtab(tab) {
  try {
    localStorage.setItem("accessguardPopupInvSubtab", tab);
  } catch {
    // Best-effort; the sub-tab still renders for this popup lifetime.
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function dateTimeLabel(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString();
}

async function renderModulesView() {
  el("student-history-container").hidden = true;
  el("module-roster-container").hidden = true;
  el("modules-list-container").hidden = false;

  const modules = await send("LIST_MODULES");
  const list = el("modules-list");
  list.innerHTML = "";
  for (const module of modules) {
    const item = document.createElement("li");
    item.className = "module-row";
    item.innerHTML = `<strong>${escapeHtml(module.code)}</strong> — ${escapeHtml(module.name)}<br><span class="mono">Enroll code: ${escapeHtml(module.enroll_code)}</span>`;
    const rosterBtn = document.createElement("button");
    rosterBtn.type = "button";
    rosterBtn.className = "secondary";
    rosterBtn.textContent = "View roster";
    rosterBtn.addEventListener("click", () => void renderRoster(module));
    item.appendChild(rosterBtn);
    list.appendChild(item);
  }
}

async function renderRoster(module) {
  el("modules-list-container").hidden = true;
  el("student-history-container").hidden = true;
  el("module-roster-container").hidden = false;
  el("roster-module-title").textContent = `${module.code} roster`;

  const list = el("roster-list");
  list.innerHTML = "<li class=\"module-row\">Loading…</li>";
  try {
    const roster = await send("LIST_MODULE_STUDENTS", { moduleId: module.id });
    list.innerHTML = "";
    if (!roster.length) {
      list.innerHTML = "<li class=\"module-row\">No students enrolled yet.</li>";
      return;
    }
    for (const student of roster) {
      const item = document.createElement("li");
      item.className = "module-row";
      item.innerHTML = `<strong>${escapeHtml(student.student_id)}</strong> — ${escapeHtml(student.full_name)}<br><span class="mono">Enrolled ${escapeHtml(dateTimeLabel(student.enrolled_at))}</span>`;
      const historyBtn = document.createElement("button");
      historyBtn.type = "button";
      historyBtn.textContent = "View history";
      historyBtn.addEventListener("click", () => void renderStudentHistory(module, student));
      item.appendChild(historyBtn);
      list.appendChild(item);
    }
  } catch (error) {
    list.innerHTML = `<li class="module-row">${escapeHtml(error.message)}</li>`;
  }
}

async function renderStudentHistory(module, student) {
  el("module-roster-container").hidden = true;
  el("student-history-container").hidden = false;
  el("history-student-title").textContent = `${student.full_name} (${student.student_id})`;

  const list = el("history-list");
  list.innerHTML = "<li class=\"module-row\">Loading…</li>";
  try {
    const rows = await send("GET_STUDENT_HISTORY", { moduleId: module.id, studentId: student.student_id });
    list.innerHTML = "";
    if (!rows.length) {
      list.innerHTML = "<li class=\"module-row\">No exam attempts under this module yet.</li>";
      return;
    }
    for (const row of rows) {
      const item = document.createElement("li");
      item.className = "module-row";
      const scoreLine = row.grade
        ? `<span class="status-pill">${row.grade.total} / ${row.grade.max_total}</span>`
        : `<span class="mono">Not graded</span>`;
      item.innerHTML = `<strong>${escapeHtml(row.exam_name)}</strong> — ${escapeHtml(row.status)}<br>${scoreLine}<br><span class="mono">Submitted ${escapeHtml(dateTimeLabel(row.submitted_at))}</span>`;

      const details = document.createElement("div");
      details.hidden = true;
      details.style.marginTop = "8px";
      for (const q of row.questions || []) {
        const qBlock = document.createElement("div");
        qBlock.style.marginTop = "6px";
        const answer = row.answers?.[q.id] || "(no answer)";
        const perQ = row.grade?.per_question?.[q.id];
        const feedback = perQ ? ` — ${escapeHtml(String(perQ.score))}/${escapeHtml(String(perQ.max))}: ${escapeHtml(perQ.feedback || "")}` : "";
        qBlock.innerHTML = `<span class="mono">${escapeHtml(q.text)}</span><br>${escapeHtml(answer)}${feedback}`;
        details.appendChild(qBlock);
      }

      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "secondary";
      toggleBtn.textContent = "Details";
      toggleBtn.addEventListener("click", () => { details.hidden = !details.hidden; });

      item.appendChild(toggleBtn);
      item.appendChild(details);
      list.appendChild(item);
    }
  } catch (error) {
    list.innerHTML = `<li class="module-row">${escapeHtml(error.message)}</li>`;
  }
}

async function populateQuickModuleSelect() {
  const select = el("quick-module-select");
  const previous = select.value;
  const modules = await send("LIST_MODULES");
  select.innerHTML = '<option value="">None — ad hoc session, not tied to a module</option>';
  for (const module of modules) {
    const option = document.createElement("option");
    option.value = module.code;
    option.textContent = `${module.code} — ${module.name}`;
    select.appendChild(option);
  }
  if (modules.some((m) => m.code === previous)) select.value = previous;
}

async function renderInvigilatorPanel() {
  el("invigilator-notice").textContent = "";
  const control = await send("GET_CONTROL_STATUS");

  el("invigilator-session-bar").hidden = !control.invigilator.signedIn;
  el("invigilator-signed-in-view").hidden = !control.invigilator.signedIn;
  el("invigilator-name").textContent = control.invigilator.signedIn
    ? `Signed in as ${control.invigilator.name || control.invigilator.invId}`
    : "";
  el("invigilator-login-view").hidden = control.invigilator.signedIn;

  const subtab = getInvigilatorSubtab();
  el("inv-subtab-quick").classList.toggle("active", subtab === "quick");
  el("inv-subtab-modules").classList.toggle("active", subtab === "modules");
  el("modules-view").hidden = !control.invigilator.signedIn || subtab !== "modules";
  el("quick-create-view").hidden = !control.invigilator.signedIn || subtab !== "quick" || control.quickSession.active;
  el("quick-active-view").hidden = !control.invigilator.signedIn || subtab !== "quick" || !control.quickSession.active;

  if (control.invigilator.signedIn && subtab === "modules") {
    await renderModulesView().catch((error) => {
      el("invigilator-notice").textContent = error.message;
      el("invigilator-notice").className = "notice error";
    });
  }

  if (control.invigilator.signedIn && subtab === "quick" && !control.quickSession.active) {
    await populateQuickModuleSelect().catch((error) => {
      el("invigilator-notice").textContent = error.message;
      el("invigilator-notice").className = "notice error";
    });
  }

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

function getStudentSubtab() {
  try {
    return localStorage.getItem("accessguardPopupStudentSubtab") || "join";
  } catch {
    return "join";
  }
}

function setStudentSubtab(tab) {
  try {
    localStorage.setItem("accessguardPopupStudentSubtab", tab);
  } catch {
    // Best-effort; the sub-tab still renders for this popup lifetime.
  }
}

function renderModuleQuizList(moduleStatus) {
  const list = el("module-quiz-list");
  list.innerHTML = "";
  for (const module of moduleStatus.modules) {
    const item = document.createElement("li");
    item.className = "module-row";
    const quiz = module.latestQuiz;
    const quizLine = quiz
      ? `<span class="status-pill">Quiz ready</span> ${escapeHtml(quiz.quiz_prompt_title || quiz.exam_name)}`
      : `<span class="mono">No published quiz</span>`;
    item.innerHTML = `<strong>${escapeHtml(module.code)}</strong> — ${escapeHtml(module.name)}<br>${quizLine}`;
    if (quiz) {
      const joinBtn = document.createElement("button");
      joinBtn.type = "button";
      joinBtn.textContent = "Join Quiz";
      joinBtn.addEventListener("click", async () => {
        try {
          await send("OPEN_MODULE_QUIZ", { moduleCode: module.code });
        } catch (error) {
          el("module-notice").textContent = error.message;
          el("module-notice").className = "notice error";
        }
      });
      item.appendChild(joinBtn);
    }
    list.appendChild(item);
  }
}

async function renderModulePanel() {
  el("module-notice").textContent = "";
  const status = await send("GET_MODULE_STATUS");
  el("module-enroll-view").hidden = status.signedIn;
  el("module-list-view").hidden = !status.signedIn;
  if (status.signedIn) {
    el("module-student-name").textContent = `${status.fullName || status.studentId}`;
    renderModuleQuizList(status);
    stopPolling();
    pollTimer = setInterval(async () => {
      try {
        renderModuleQuizList(await send("GET_MODULE_STATUS"));
      } catch {
        // A transient poll failure is not worth surfacing; the next tick retries.
      }
    }, 15000);
  } else {
    stopPolling();
  }
}

async function renderStudentPanel() {
  el("student-notice").textContent = "";
  const subtab = getStudentSubtab();
  el("student-subtab-join").classList.toggle("active", subtab === "join");
  el("student-subtab-modules").classList.toggle("active", subtab === "modules");
  el("student-join-view").hidden = subtab !== "join";
  el("student-armed-view").hidden = true;
  el("module-panel").hidden = subtab !== "modules";

  if (subtab === "modules") {
    await renderModulePanel();
    return;
  }
  stopPolling();

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
      moduleCode: el("quick-module-select").value,
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

el("inv-subtab-quick").addEventListener("click", () => { setInvigilatorSubtab("quick"); void renderInvigilatorPanel(); });
el("inv-subtab-modules").addEventListener("click", () => { setInvigilatorSubtab("modules"); void renderInvigilatorPanel(); });

el("module-create-btn").addEventListener("click", async () => {
  el("invigilator-notice").textContent = "Creating module…";
  el("invigilator-notice").className = "notice";
  try {
    await send("CREATE_MODULE", {
      code: el("module-code-input").value,
      name: el("module-name-input").value,
    });
    el("module-code-input").value = "";
    el("module-name-input").value = "";
    el("invigilator-notice").textContent = "";
    await renderModulesView();
  } catch (error) {
    el("invigilator-notice").textContent = error.message;
    el("invigilator-notice").className = "notice error";
  }
});

el("roster-back-btn").addEventListener("click", () => { void renderModulesView(); });
el("history-back-btn").addEventListener("click", () => {
  el("student-history-container").hidden = true;
  el("module-roster-container").hidden = false;
});

el("student-subtab-join").addEventListener("click", () => { setStudentSubtab("join"); void renderStudentPanel(); });
el("student-subtab-modules").addEventListener("click", () => { setStudentSubtab("modules"); void renderStudentPanel(); });

el("module-enroll-btn").addEventListener("click", async () => {
  el("module-notice").textContent = "Enrolling…";
  el("module-notice").className = "notice";
  try {
    await send("MODULE_ENROLL", {
      enrollCode: el("module-enroll-code-input").value,
      studentId: el("module-student-id-input").value,
      fullName: el("module-full-name-input").value,
      password: el("module-password-input").value,
    });
    await renderModulePanel();
  } catch (error) {
    el("module-notice").textContent = error.message;
    el("module-notice").className = "notice error";
  }
});

el("module-signin-btn").addEventListener("click", async () => {
  el("module-notice").textContent = "Signing in…";
  el("module-notice").className = "notice";
  try {
    await send("MODULE_LOGIN", {
      studentId: el("module-student-id-input").value,
      password: el("module-password-input").value,
    });
    await renderModulePanel();
  } catch (error) {
    el("module-notice").textContent = error.message;
    el("module-notice").className = "notice error";
  }
});

el("module-signout-btn").addEventListener("click", async () => {
  await send("MODULE_LOGOUT");
  await renderModulePanel();
});

void init();

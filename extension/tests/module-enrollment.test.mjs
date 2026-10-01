import test from "node:test";
import assert from "node:assert/strict";
import { createChromeMock, importFreshServiceWorker, popupSender, makeSend } from "./popup-control.test.mjs";

function baseFetchHandlers({ moduleCode = "EE5206", quizzes = [], roster = [], history = [] } = {}) {
  return async (url, options = {}) => {
    const href = String(url);
    if (href.endsWith("/auth/login")) {
      return { ok: true, status: 200, json: async () => ({ token: "inv-token-1", inv_id: "INV0001", name: "Ada" }) };
    }
    if (href.endsWith("/modules") && options.method === "POST") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: "module-1", code: moduleCode, name: "Power Electronics",
          owner_inv_id: "INV0001", enroll_code: "AB12CD34", created_at: new Date().toISOString(),
        }),
      };
    }
    if (href.endsWith("/modules") && (!options.method || options.method === "GET")) {
      return {
        ok: true, status: 200,
        json: async () => ([{ id: "module-1", code: moduleCode, name: "Power Electronics", enroll_code: "AB12CD34" }]),
      };
    }
    if (href.endsWith("/student/auth/join")) {
      return { ok: true, status: 200, json: async () => ({ token: "student-token-1", student_id: "S-1", full_name: "Jane" }) };
    }
    if (href.endsWith("/student/auth/login")) {
      return { ok: true, status: 200, json: async () => ({ token: "student-token-1", student_id: "S-1", full_name: "Jane" }) };
    }
    if (href.endsWith("/student/me")) {
      return {
        ok: true, status: 200,
        json: async () => ({ student_id: "S-1", full_name: "Jane", modules: [{ id: "module-1", code: moduleCode, name: "Power Electronics" }] }),
      };
    }
    if (href.includes(`/student/modules/${moduleCode}/quizzes`)) {
      return { ok: true, status: 200, json: async () => quizzes };
    }
    if (href.endsWith("/modules/module-1/students")) {
      return { ok: true, status: 200, json: async () => roster };
    }
    if (href.includes("/modules/module-1/students/history")) {
      return { ok: true, status: 200, json: async () => history };
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };
}

test("invigilator can create a module and list it", async () => {
  const { chrome, listeners } = createChromeMock();
  globalThis.chrome = chrome;
  globalThis.fetch = baseFetchHandlers();
  await importFreshServiceWorker();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const send = makeSend(listeners);

  await send({ scope: "accessguard-popup", action: "CONFIGURE_DEPLOYMENT", appUrl: "https://exam.example.edu" });
  await send({ scope: "accessguard-popup", action: "INVIGILATOR_LOGIN", invId: "INV0001", password: "Password123!" });

  const created = await send({ scope: "accessguard-popup", action: "CREATE_MODULE", code: "ee5206", name: "Power Electronics" });
  assert.equal(created.ok, true);
  assert.equal(created.data.code, "EE5206");
  assert.equal(created.data.enroll_code, "AB12CD34");

  const listed = await send({ scope: "accessguard-popup", action: "LIST_MODULES" });
  assert.equal(listed.ok, true);
  assert.equal(listed.data.length, 1);
  assert.equal(listed.data[0].code, "EE5206");
});

test("invigilator can list a module's roster and a student's history", async () => {
  const roster = [{ student_id: "S-1", full_name: "Jane", enrolled_at: "2026-09-30T00:00:00Z" }];
  const history = [{
    session_id: "session-9", exam_name: "History Quiz", exam_code: "HQ1", module_code: "EE5206",
    quiz_mode: true, status: "finished", submitted_at: "2026-09-30T00:10:00Z",
    questions: [{ id: "q1", text: "2+2?", marks: 10 }],
    answers: { q1: "4" },
    grade: { total: 10, max_total: 10, per_question: { q1: { score: 10, max: 10, feedback: "Correct." } } },
  }];
  const { chrome, listeners } = createChromeMock();
  globalThis.chrome = chrome;
  globalThis.fetch = baseFetchHandlers({ roster, history });
  await importFreshServiceWorker();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const send = makeSend(listeners);

  await send({ scope: "accessguard-popup", action: "CONFIGURE_DEPLOYMENT", appUrl: "https://exam.example.edu" });
  await send({ scope: "accessguard-popup", action: "INVIGILATOR_LOGIN", invId: "INV0001", password: "Password123!" });

  const rosterResult = await send({ scope: "accessguard-popup", action: "LIST_MODULE_STUDENTS", moduleId: "module-1" });
  assert.equal(rosterResult.ok, true);
  assert.equal(rosterResult.data.length, 1);
  assert.equal(rosterResult.data[0].student_id, "S-1");

  const historyResult = await send({
    scope: "accessguard-popup", action: "GET_STUDENT_HISTORY", moduleId: "module-1", studentId: "S-1",
  });
  assert.equal(historyResult.ok, true);
  assert.equal(historyResult.data.length, 1);
  assert.equal(historyResult.data[0].exam_name, "History Quiz");
  assert.equal(historyResult.data[0].grade.total, 10);
});

test("a student can enroll in a module and the profile is cached", async () => {
  const { chrome, listeners, storage } = createChromeMock();
  globalThis.chrome = chrome;
  globalThis.fetch = baseFetchHandlers();
  await importFreshServiceWorker();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const send = makeSend(listeners);

  await send({ scope: "accessguard-popup", action: "CONFIGURE_DEPLOYMENT", appUrl: "https://exam.example.edu" });
  const enrolled = await send({
    scope: "accessguard-popup",
    action: "MODULE_ENROLL",
    enrollCode: "ab12cd34",
    studentId: "S-1",
    fullName: "Jane",
    password: "Pass1234!",
  });
  assert.equal(enrolled.ok, true);
  assert.equal(storage.accessguardModuleAuth.token, "student-token-1");

  const status = await send({ scope: "accessguard-popup", action: "GET_MODULE_STATUS" });
  assert.equal(status.ok, true);
  assert.equal(status.data.signedIn, true);
  assert.equal(status.data.studentId, "S-1");
  assert.equal(status.data.modules.length, 1);
  assert.equal(status.data.modules[0].code, "EE5206");
});

test("GET_MODULE_STATUS reflects a freshly published quiz immediately, without waiting for the background alarm", async () => {
  const quiz = {
    id: "session-9", session_code: "QUIK-1234-ABCD", exam_name: "Pop Quiz",
    quiz_prompt_title: "Quick quiz available now", duration_minutes: 15,
  };
  const { chrome, listeners } = createChromeMock();
  globalThis.chrome = chrome;
  globalThis.fetch = baseFetchHandlers({ quizzes: [quiz] });

  await importFreshServiceWorker();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const send = makeSend(listeners);

  await send({ scope: "accessguard-popup", action: "CONFIGURE_DEPLOYMENT", appUrl: "https://exam.example.edu" });
  await send({ scope: "accessguard-popup", action: "MODULE_LOGIN", studentId: "S-1", password: "Pass1234!" });

  // No alarm tick fired here — GET_MODULE_STATUS itself must catch this up.
  const status = await send({ scope: "accessguard-popup", action: "GET_MODULE_STATUS" });
  assert.equal(status.data.modules[0].latestQuiz.session_code, "QUIK-1234-ABCD");
});

test("a returning student can sign in with student ID and password", async () => {
  const { chrome, listeners, storage } = createChromeMock();
  globalThis.chrome = chrome;
  globalThis.fetch = baseFetchHandlers();
  await importFreshServiceWorker();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const send = makeSend(listeners);

  await send({ scope: "accessguard-popup", action: "CONFIGURE_DEPLOYMENT", appUrl: "https://exam.example.edu" });
  const login = await send({ scope: "accessguard-popup", action: "MODULE_LOGIN", studentId: "S-1", password: "Pass1234!" });
  assert.equal(login.ok, true);
  assert.equal(storage.accessguardModuleAuth.studentId, "S-1");
});

test("MODULE_LOGOUT clears the stored module auth", async () => {
  const { chrome, listeners, storage } = createChromeMock();
  globalThis.chrome = chrome;
  globalThis.fetch = baseFetchHandlers();
  await importFreshServiceWorker();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const send = makeSend(listeners);

  await send({ scope: "accessguard-popup", action: "CONFIGURE_DEPLOYMENT", appUrl: "https://exam.example.edu" });
  await send({ scope: "accessguard-popup", action: "MODULE_LOGIN", studentId: "S-1", password: "Pass1234!" });
  assert.ok(storage.accessguardModuleAuth);

  const out = await send({ scope: "accessguard-popup", action: "MODULE_LOGOUT" });
  assert.equal(out.ok, true);
  assert.equal(storage.accessguardModuleAuth, null);
});

test("polling prunes a module once it 403s (no longer enrolled, e.g. the module was removed)", async () => {
  const { chrome, listeners, storage } = createChromeMock();
  globalThis.chrome = chrome;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.endsWith("/auth/login") || href.endsWith("/student/auth/login")) {
      return { ok: true, status: 200, json: async () => ({ token: "student-token-1", student_id: "S-1", full_name: "Jane" }) };
    }
    if (href.endsWith("/student/me")) {
      return {
        ok: true, status: 200,
        json: async () => ({
          student_id: "S-1", full_name: "Jane",
          modules: [
            { id: "module-1", code: "STALE01", name: "Stale Module" },
            { id: "module-2", code: "LIVE01", name: "Live Module" },
          ],
        }),
      };
    }
    if (href.includes("/student/modules/STALE01/quizzes")) {
      return { ok: false, status: 403, json: async () => ({ detail: "Not enrolled in this module" }) };
    }
    if (href.includes("/student/modules/LIVE01/quizzes")) {
      return { ok: true, status: 200, json: async () => [] };
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  await importFreshServiceWorker();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const send = makeSend(listeners);

  await send({ scope: "accessguard-popup", action: "CONFIGURE_DEPLOYMENT", appUrl: "https://exam.example.edu" });
  await send({ scope: "accessguard-popup", action: "MODULE_LOGIN", studentId: "S-1", password: "Pass1234!" });

  listeners["alarms.onAlarm"]({ name: "accessguard-quiz-poll" });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const codes = storage.accessguardModuleAuth.modules.map((m) => m.code);
  assert.deepEqual(codes, ["LIVE01"]);
});

test("polling a new published quiz fires exactly one notification, keyed by module code", async () => {
  const quiz = {
    id: "session-9", session_code: "QUIK-1234-ABCD", exam_name: "Pop Quiz",
    quiz_prompt_title: "Quick quiz available now", duration_minutes: 15,
  };
  const { chrome, listeners, storage } = createChromeMock();
  globalThis.chrome = chrome;
  globalThis.fetch = baseFetchHandlers({ quizzes: [quiz] });
  const notifyCalls = [];
  chrome.notifications.create = async (id, options) => { notifyCalls.push({ id, options }); return id; };

  await importFreshServiceWorker();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const send = makeSend(listeners);

  await send({ scope: "accessguard-popup", action: "CONFIGURE_DEPLOYMENT", appUrl: "https://exam.example.edu" });
  await send({ scope: "accessguard-popup", action: "MODULE_LOGIN", studentId: "S-1", password: "Pass1234!" });

  listeners["alarms.onAlarm"]({ name: "accessguard-quiz-poll" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(notifyCalls.length, 1);
  assert.equal(notifyCalls[0].id, "module-quiz-EE5206");
  assert.match(notifyCalls[0].options.message, /Pop Quiz|Quick quiz available now/);

  // A second poll tick with the same quiz must not notify again.
  listeners["alarms.onAlarm"]({ name: "accessguard-quiz-poll" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(notifyCalls.length, 1);

  const status = await send({ scope: "accessguard-popup", action: "GET_MODULE_STATUS" });
  assert.equal(status.data.modules[0].latestQuiz.session_code, "QUIK-1234-ABCD");
});

test("OPEN_MODULE_QUIZ opens the web app's real quiz-prompt route, not a guessed one", async () => {
  const { chrome, listeners } = createChromeMock();
  globalThis.chrome = chrome;
  globalThis.fetch = baseFetchHandlers();
  const createdTabs = [];
  chrome.tabs.create = async ({ url }) => { createdTabs.push(url); return { id: 44, windowId: 9, url }; };

  await importFreshServiceWorker();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const send = makeSend(listeners);

  await send({ scope: "accessguard-popup", action: "CONFIGURE_DEPLOYMENT", appUrl: "https://exam.example.edu" });
  await send({ scope: "accessguard-popup", action: "MODULE_LOGIN", studentId: "S-1", password: "Pass1234!" });

  const opened = await send({ scope: "accessguard-popup", action: "OPEN_MODULE_QUIZ", moduleCode: "EE5206" });
  assert.equal(opened.ok, true);
  assert.equal(createdTabs.length, 1);
  const url = new URL(createdTabs[0]);
  assert.equal(url.origin + url.pathname, "https://exam.example.edu/quiz/prompt");
  assert.equal(url.searchParams.get("module"), "EE5206");
  assert.equal(url.searchParams.get("student_id"), "S-1");
});

test("CREATE_QUICK_SESSION with a moduleCode publishes it as a quiz for that module", async () => {
  const { chrome, listeners } = createChromeMock();
  globalThis.chrome = chrome;
  const fetchCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    const href = String(url);
    if (href.endsWith("/auth/login")) {
      return { ok: true, status: 200, json: async () => ({ token: "inv-token-1", inv_id: "INV0001", name: "Ada" }) };
    }
    if (href.endsWith("/sessions") && options.method === "POST") {
      return { ok: true, status: 200, json: async () => ({ id: "session-1", session_code: "QUIK-ABCD-EFGH" }) };
    }
    if (href.endsWith("/sessions/session-1/start")) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  await importFreshServiceWorker();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const send = makeSend(listeners);

  await send({ scope: "accessguard-popup", action: "CONFIGURE_DEPLOYMENT", appUrl: "https://exam.example.edu" });
  await send({ scope: "accessguard-popup", action: "INVIGILATOR_LOGIN", invId: "INV0001", password: "Password123!" });
  await send({
    scope: "accessguard-popup",
    action: "CREATE_QUICK_SESSION",
    durationMinutes: 20,
    questionText: "What is Ohm's law?",
    modelAnswer: "V = IR",
    moduleCode: "EE5206",
  });

  const createCall = fetchCalls.find((c) => c.url.endsWith("/sessions") && c.options.method === "POST");
  const body = JSON.parse(createCall.options.body);
  assert.equal(body.quiz_mode, true);
  assert.equal(body.published, true);
  assert.equal(body.module_code, "EE5206");
});

test("polling does not notify when no student is signed in", async () => {
  const { chrome, listeners } = createChromeMock();
  globalThis.chrome = chrome;
  globalThis.fetch = async () => { throw new Error("no network expected when signed out"); };
  const notifyCalls = [];
  chrome.notifications.create = async (id, options) => { notifyCalls.push({ id, options }); return id; };

  await importFreshServiceWorker();
  await new Promise((resolve) => setTimeout(resolve, 10));

  listeners["alarms.onAlarm"]({ name: "accessguard-quiz-poll" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(notifyCalls.length, 0);
});

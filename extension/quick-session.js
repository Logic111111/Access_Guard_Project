const EXAM_CODE_PREFIX = "QUICK";

function slugifyExamCode(examName) {
  const slug = String(examName || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 12);
  return slug || "SESSION";
}

export function generateExamCode(examName, now = Date.now()) {
  return `${EXAM_CODE_PREFIX}-${slugifyExamCode(examName)}-${now.toString(36).toUpperCase()}`;
}

export function defaultQuickExamName(now = Date.now()) {
  const stamp = new Date(now).toISOString().slice(0, 16).replace("T", " ");
  return `Quick Lockdown — ${stamp}`;
}

export function buildQuickSessionPayload(form = {}, now = Date.now()) {
  const durationMinutes = Number(form.durationMinutes);
  if (!Number.isFinite(durationMinutes) || durationMinutes < 5 || durationMinutes > 480) {
    throw new TypeError("Duration must be between 5 and 480 minutes");
  }
  const questionText = String(form.questionText || "").trim();
  if (!questionText) {
    throw new TypeError("A question is required");
  }
  const examName = String(form.examName || "").trim() || defaultQuickExamName(now);
  const modelAnswer = String(form.modelAnswer || "").trim();
  const whitelistedUrls = Array.isArray(form.whitelistedUrls)
    ? form.whitelistedUrls.map((url) => String(url).trim()).filter(Boolean)
    : [];
  const moduleCode = String(form.moduleCode || "").trim().toUpperCase();

  return {
    exam_name: examName,
    exam_code: generateExamCode(examName, now),
    duration_minutes: Math.round(durationMinutes),
    max_students: 100,
    heartbeat_interval_sec: 10,
    allow_pause: true,
    auto_record_webcam: false,
    save_screen_share: false,
    whitelisted_urls: whitelistedUrls,
    whitelisted_apps: [],
    questions: [{ id: "q1", type: "text", text: questionText, marks: 10, options: [] }],
    model_answers: { q1: modelAnswer },
    quiz_mode: Boolean(moduleCode),
    published: Boolean(moduleCode),
    module_code: moduleCode,
    quiz_prompt_title: moduleCode ? "Quick quiz available now" : "",
    quiz_prompt_body: moduleCode ? "A quick assessment is available for this module." : "",
    lockdown_mode: "extension_required",
    require_manual_approval: false,
    require_identity_verification: false,
    require_fullscreen: true,
    extension_min_version: "1.0.0",
  };
}

export function validateJoinForm(form = {}) {
  const sessionCode = String(form.sessionCode || "").trim().toUpperCase();
  const studentId = String(form.studentId || "").trim();
  const fullName = String(form.fullName || "").trim();
  if (!sessionCode) throw new TypeError("Session code is required");
  if (!studentId) throw new TypeError("Student ID is required");
  if (!fullName) throw new TypeError("Full name is required");
  return { sessionCode, studentId, fullName };
}

export function validateLoginForm(form = {}) {
  const invId = String(form.invId || "").trim();
  const password = String(form.password || "");
  if (!invId) throw new TypeError("Invigilator ID is required");
  if (!password) throw new TypeError("Password is required");
  return { invId, password };
}

export function validateModuleCreateForm(form = {}) {
  const code = String(form.code || "").trim().toUpperCase();
  const name = String(form.name || "").trim();
  if (!code) throw new TypeError("Module code is required");
  if (!name) throw new TypeError("Module name is required");
  return { code, name };
}

export function validateModuleEnrollForm(form = {}) {
  const enrollCode = String(form.enrollCode || "").trim().toUpperCase();
  const studentId = String(form.studentId || "").trim();
  const fullName = String(form.fullName || "").trim();
  const password = String(form.password || "");
  if (!enrollCode) throw new TypeError("Enrollment code is required");
  if (!studentId) throw new TypeError("Student ID is required");
  if (!fullName) throw new TypeError("Full name is required");
  if (!password) throw new TypeError("Password is required");
  return { enrollCode, studentId, fullName, password };
}

export function validateStudentLoginForm(form = {}) {
  const studentId = String(form.studentId || "").trim();
  const password = String(form.password || "");
  if (!studentId) throw new TypeError("Student ID is required");
  if (!password) throw new TypeError("Password is required");
  return { studentId, password };
}

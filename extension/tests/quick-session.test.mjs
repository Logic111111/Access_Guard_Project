import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQuickSessionPayload,
  defaultQuickExamName,
  generateExamCode,
  validateJoinForm,
  validateLoginForm,
} from "../quick-session.js";

test("generateExamCode is deterministic and URL-safe for a given timestamp", () => {
  const code = generateExamCode("Networks 101", 1_700_000_000_000);
  assert.equal(code, generateExamCode("Networks 101", 1_700_000_000_000));
  assert.match(code, /^QUICK-[A-Z0-9-]+$/);
});

test("buildQuickSessionPayload fills defaults and always disables verification/approval", () => {
  const payload = buildQuickSessionPayload({
    durationMinutes: 45,
    questionText: "Summarize the reading.",
    modelAnswer: "Any reasonable summary.",
    whitelistedUrls: ["docs.python.org", "  ", "developer.mozilla.org"],
  }, 1_700_000_000_000);

  assert.equal(payload.duration_minutes, 45);
  assert.equal(payload.require_identity_verification, false);
  assert.equal(payload.require_manual_approval, false);
  assert.equal(payload.auto_record_webcam, false);
  assert.deepEqual(payload.whitelisted_urls, ["docs.python.org", "developer.mozilla.org"]);
  assert.deepEqual(payload.questions, [{ id: "q1", type: "text", text: "Summarize the reading.", marks: 10, options: [] }]);
  assert.equal(payload.model_answers.q1, "Any reasonable summary.");
  assert.equal(payload.exam_name, defaultQuickExamName(1_700_000_000_000));
});

test("buildQuickSessionPayload rejects a missing question or an out-of-range duration", () => {
  assert.throws(() => buildQuickSessionPayload({ durationMinutes: 30, questionText: "" }), TypeError);
  assert.throws(() => buildQuickSessionPayload({ durationMinutes: 1, questionText: "Q?" }), TypeError);
  assert.throws(() => buildQuickSessionPayload({ durationMinutes: 1000, questionText: "Q?" }), TypeError);
});

test("validateJoinForm normalizes the session code and requires every field", () => {
  const normalized = validateJoinForm({ sessionCode: " quik-abcd-efgh ", studentId: " S-1 ", fullName: " Asha " });
  assert.deepEqual(normalized, { sessionCode: "QUIK-ABCD-EFGH", studentId: "S-1", fullName: "Asha" });

  assert.throws(() => validateJoinForm({ studentId: "S-1", fullName: "Asha" }), TypeError);
  assert.throws(() => validateJoinForm({ sessionCode: "ABCD", fullName: "Asha" }), TypeError);
  assert.throws(() => validateJoinForm({ sessionCode: "ABCD", studentId: "S-1" }), TypeError);
});

test("validateLoginForm requires both an invigilator ID and a password", () => {
  assert.deepEqual(validateLoginForm({ invId: " EG/STAFF/0001 ", password: "secret" }), {
    invId: "EG/STAFF/0001",
    password: "secret",
  });
  assert.throws(() => validateLoginForm({ password: "secret" }), TypeError);
  assert.throws(() => validateLoginForm({ invId: "EG/STAFF/0001" }), TypeError);
});

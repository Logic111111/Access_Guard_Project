import test from "node:test";
import assert from "node:assert/strict";

import {
  BLOCK_RULE_ID,
  compileNavigationRules,
  isAllowedHttpNavigation,
  isOwnedRuleId,
  normalizeApiBase,
  normalizeExamUrl,
  normalizeOrigin,
  normalizePolicy,
  sanitizeAttemptedUrl,
} from "../rule-helpers.js";

test("normalizes exact HTTP(S) origins and rejects credentials", () => {
  assert.equal(normalizeOrigin("https://Exam.Example.edu/path?q=1"), "https://exam.example.edu");
  assert.equal(normalizeOrigin("http://localhost:3000/student/exam"), "http://localhost:3000");
  assert.throws(() => normalizeOrigin("file:///tmp/exam"), /HTTP\(S\)/);
  assert.throws(() => normalizeOrigin("https://user:pass@example.edu"), /credentials/);
});

test("normalizes relative, origin-only, and explicit API bases", () => {
  assert.equal(normalizeApiBase("/api", "https://exam.example.edu"), "https://exam.example.edu/api");
  assert.equal(normalizeApiBase("https://api.example.edu", "https://exam.example.edu"), "https://api.example.edu/api");
  assert.equal(normalizeApiBase("https://api.example.edu/v1/api/", "https://exam.example.edu"), "https://api.example.edu/v1/api");
});

test("compiles a default-deny main-frame rule with higher priority exact-origin allows", () => {
  const rules = compileNavigationRules([
    "https://exam.example.edu",
    "https://docs.example.edu",
    "https://exam.example.edu/path-is-ignored",
  ]);

  assert.equal(rules[0].id, BLOCK_RULE_ID);
  assert.equal(rules[0].action.type, "block");
  assert.deepEqual(rules[0].condition.resourceTypes, ["main_frame"]);
  assert.equal(rules.length, 3, "duplicate origins should collapse");

  const examAllow = rules.find((rule) =>
    rule.action.type === "allow" &&
    new RegExp(rule.condition.regexFilter).test("https://exam.example.edu/student/exam")
  );
  assert.ok(examAllow);
  assert.equal(examAllow.action.type, "allow");
  assert.ok(examAllow.priority > rules[0].priority);
  assert.equal(new RegExp(examAllow.condition.regexFilter).test("https://evil.exam.example.edu/student/exam"), false);
});

test("checks allowed navigation by exact origin rather than suffix", () => {
  const origins = ["https://example.edu"];
  assert.equal(isAllowedHttpNavigation("https://example.edu/exam", origins), true);
  assert.equal(isAllowedHttpNavigation("https://sub.example.edu/exam", origins), false);
  assert.equal(isAllowedHttpNavigation("https://example.edu.evil.test/exam", origins), false);
  assert.equal(isAllowedHttpNavigation("chrome://extensions", origins), false);
});

test("sanitizes attempted URLs before access requests", () => {
  assert.equal(
    sanitizeAttemptedUrl("https://docs.example.edu/guide?q=exam#answers"),
    "https://docs.example.edu/guide?q=exam"
  );
  assert.throws(() => sanitizeAttemptedUrl("chrome://settings"), /HTTP\(S\)/);
  assert.throws(() => sanitizeAttemptedUrl("https://user:secret@example.edu"), /credentials/);
});

test("pins a policy exam URL to the exact armed app origin while preserving its route", () => {
  assert.equal(
    normalizeExamUrl(
      "http://localhost:3000/student/exam?source=policy#discarded",
      "http://127.0.0.1:3000"
    ),
    "http://127.0.0.1:3000/student/exam?source=policy"
  );
  assert.equal(
    normalizeExamUrl("/quiz/secure?code=ABC", "https://student.example.edu"),
    "https://student.example.edu/quiz/secure?code=ABC"
  );
  assert.equal(
    normalizeExamUrl(
      "http://localhost:3000/",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:3000/student/exam?attempt=abc#question-2"
    ),
    "http://127.0.0.1:3000/student/exam?attempt=abc"
  );
  assert.throws(
    () => normalizeExamUrl("https://user:secret@example.edu/exam", "https://student.example.edu"),
    /credentials/
  );
});

test("policy normalization cannot replace the armed sender origin", () => {
  const policy = normalizePolicy({
    candidate_id: "candidate_123",
    session_id: "session_456",
    state: "armed",
    policy_version: 9,
    exam_url: "http://localhost:3000/student/exam?from=backend",
    app_origins: ["http://localhost:3000"],
    allowed_origins: [],
  }, {
    candidateId: "candidate_123",
    appOrigin: "http://127.0.0.1:3000",
    examUrl: "http://127.0.0.1:3000/student/exam?attempt=abc",
  });

  assert.equal(
    policy.examUrl,
    "http://127.0.0.1:3000/student/exam?from=backend"
  );
});

test("an origin-only policy URL preserves the exact armed exam route", () => {
  const policy = normalizePolicy({
    candidate_id: "candidate_123",
    session_id: "session_456",
    state: "armed",
    policy_version: 10,
    exam_url: "http://localhost:3000/",
    app_origins: ["http://localhost:3000"],
    allowed_origins: [],
  }, {
    candidateId: "candidate_123",
    appOrigin: "http://127.0.0.1:3000",
    examUrl: "http://127.0.0.1:3000/student/exam?attempt=abc#question-2",
  });

  assert.equal(
    policy.examUrl,
    "http://127.0.0.1:3000/student/exam?attempt=abc"
  );
});

test("normalizes the backend policy shape and treats armed as enforced by default", () => {
  const now = Date.parse("2026-08-03T08:00:00.000Z");
  const policy = normalizePolicy({
    candidate_id: "candidate_123",
    session_id: "session_456",
    state: "armed",
    policy_version: 7,
    exam_url: "https://exam.example.edu/student/exam",
    app_origins: ["https://exam.example.edu"],
    allowed_origins: ["https://docs.example.edu/path"],
    timestamps: { generated_at: "2026-08-03T07:59:55.000Z" },
  }, {
    candidateId: "candidate_123",
    appOrigin: "https://exam.example.edu",
  }, now);

  assert.equal(policy.enforcement, true);
  assert.equal(policy.policyVersion, "7");
  assert.deepEqual(policy.allowedOrigins, ["https://docs.example.edu"]);
  assert.equal(policy.issuedAt, "2026-08-03T07:59:55.000Z");
  assert.equal(policy.expiresAt, null);
});

test("honors an authenticated non-enforcing monitor policy", () => {
  const policy = normalizePolicy({
    candidate_id: "candidate_123",
    session_id: "session_456",
    state: "armed",
    enforcement: false,
    policy_version: 8,
    exam_url: "https://exam.example.edu/student/exam",
    app_origins: ["https://exam.example.edu"],
    allowed_origins: [],
    timestamps: { generated_at: "2026-08-03T07:59:55.000Z" },
  }, {
    candidateId: "candidate_123",
    appOrigin: "https://exam.example.edu",
  }, Date.parse("2026-08-03T08:00:00.000Z"));

  assert.equal(policy.state, "armed");
  assert.equal(policy.enforcement, false);
});

test("accepts authenticated terminal policy states and rejects mismatched candidates", () => {
  const base = {
    candidate_id: "candidate_123",
    session_id: "session_456",
    state: "finished",
    policy_version: 8,
    exam_url: "https://exam.example.edu/student/exam",
    app_origins: [],
    allowed_origins: [],
    timestamps: { generated_at: "2026-08-03T07:59:55.000Z" },
  };
  const expected = { candidateId: "candidate_123", appOrigin: "https://exam.example.edu" };
  const policy = normalizePolicy(base, expected, Date.parse("2026-08-03T08:00:00.000Z"));

  assert.equal(policy.enforcement, false);
  assert.throws(
    () => normalizePolicy({ ...base, candidate_id: "someone_else" }, expected),
    /does not match/
  );
});

test("recognizes only the extension-owned DNR rule range", () => {
  assert.equal(isOwnedRuleId(740000), true);
  assert.equal(isOwnedRuleId(749999), true);
  assert.equal(isOwnedRuleId(739999), false);
  assert.equal(isOwnedRuleId(750000), false);
});

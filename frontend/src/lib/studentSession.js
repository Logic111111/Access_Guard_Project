const STUDENT_KEYS = {
  candidateId: "ag_candidate_id",
  candidateToken: "ag_candidate_token",
  joinSession: "ag_join_session",
  joinStudent: "ag_join_student",
  faceMatch: "ag_face_match",
};

function getStorage(name) {
  try {
    if (typeof window === "undefined") return null;
    return window[name] || null;
  } catch {
    return null;
  }
}

function readFrom(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeTo(storage, key, value) {
  try {
    storage?.setItem(key, value);
  } catch {
    // Storage can be disabled by browser policy. The other store may still work.
  }
}

function removeFrom(storage, key) {
  try {
    storage?.removeItem(key);
  } catch {
    // Best-effort cleanup when a browser has disabled a storage area.
  }
}

/**
 * Student attempt data is mirrored in localStorage so a replacement tab in the
 * same dedicated Chrome profile can recover it. sessionStorage remains the
 * primary store and is repopulated whenever recovery is needed.
 */
export function readStudentValue(key) {
  const session = getStorage("sessionStorage");
  const local = getStorage("localStorage");
  const sessionValue = readFrom(session, key);
  if (sessionValue !== null) {
    if (readFrom(local, key) === null) writeTo(local, key, sessionValue);
    return sessionValue;
  }

  const localValue = readFrom(local, key);
  if (localValue !== null) writeTo(session, key, localValue);
  return localValue;
}

export function writeStudentValue(key, value) {
  if (value === undefined || value === null || value === "") {
    removeStudentValue(key);
    return;
  }
  const serialized = String(value);
  writeTo(getStorage("sessionStorage"), key, serialized);
  writeTo(getStorage("localStorage"), key, serialized);
}

export function removeStudentValue(key) {
  removeFrom(getStorage("sessionStorage"), key);
  removeFrom(getStorage("localStorage"), key);
}

function readJson(key) {
  try {
    return JSON.parse(readStudentValue(key) || "null");
  } catch {
    removeStudentValue(key);
    return null;
  }
}

function writeJson(key, value) {
  if (!value || typeof value !== "object") {
    removeStudentValue(key);
    return;
  }
  writeStudentValue(key, JSON.stringify(value));
}

export function getStoredCandidateId() {
  return readStudentValue(STUDENT_KEYS.candidateId) || "";
}

export function getStoredCandidateToken() {
  return readStudentValue(STUDENT_KEYS.candidateToken) || "";
}

export function getStoredJoinSession() {
  return readJson(STUDENT_KEYS.joinSession) || {};
}

export function getStoredJoinStudent() {
  return readJson(STUDENT_KEYS.joinStudent) || {};
}

export function saveStudentJoinContext(session, student) {
  writeJson(STUDENT_KEYS.joinSession, session);
  writeJson(STUDENT_KEYS.joinStudent, student);
}

export function saveStoredJoinSession(session) {
  writeJson(STUDENT_KEYS.joinSession, session);
}

export function saveCandidateAttempt({ candidateId, candidateToken, faceMatch } = {}) {
  if (candidateId) writeStudentValue(STUDENT_KEYS.candidateId, candidateId);
  if (candidateToken) writeStudentValue(STUDENT_KEYS.candidateToken, candidateToken);
  if (faceMatch !== undefined && faceMatch !== null) {
    writeStudentValue(STUDENT_KEYS.faceMatch, faceMatch);
  }
}

export function getStoredStudentAttempt() {
  return {
    candidateId: getStoredCandidateId(),
    candidateToken: getStoredCandidateToken(),
    session: getStoredJoinSession(),
    student: getStoredJoinStudent(),
  };
}

function answerKey(candidateId) {
  return candidateId ? `ag_answers_${candidateId}` : "";
}

export function getStoredAnswers(candidateId) {
  const key = answerKey(candidateId);
  if (!key) return {};
  return readJson(key) || {};
}

export function saveStoredAnswers(candidateId, answers) {
  const key = answerKey(candidateId);
  if (key) writeJson(key, answers || {});
}

export function clearStoredAnswers(candidateId) {
  const key = answerKey(candidateId);
  if (key) removeStudentValue(key);
}

function breachKey(candidateId) {
  return candidateId ? `ag_breaches_${candidateId}` : "";
}

// Counts confirmed lockdown breaches (leaving fullscreen/focus) in browser-only
// mode. Persisted per candidate so reloading the page cannot reset it and
// silently dodge the escalation to a real server-side lock.
export function getStoredBreachCount(candidateId) {
  const key = breachKey(candidateId);
  if (!key) return 0;
  const value = Number(readStudentValue(key));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function saveStoredBreachCount(candidateId, count) {
  const key = breachKey(candidateId);
  if (key) writeStudentValue(key, String(count));
}

export function clearStoredBreachCount(candidateId) {
  const key = breachKey(candidateId);
  if (key) removeStudentValue(key);
}

export function clearStudentAttempt() {
  const candidateId = getStoredCandidateId();
  clearStoredAnswers(candidateId);
  clearStoredBreachCount(candidateId);
  Object.values(STUDENT_KEYS).forEach(removeStudentValue);
}


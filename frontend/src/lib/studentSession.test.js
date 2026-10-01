import {
  clearStudentAttempt,
  getStoredAnswers,
  getStoredBreachCount,
  getStoredCandidateId,
  getStoredCandidateToken,
  getStoredJoinSession,
  getStoredJoinStudent,
  saveCandidateAttempt,
  saveStoredAnswers,
  saveStoredBreachCount,
  saveStudentJoinContext,
} from "./studentSession";

describe("student attempt recovery storage", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  test("recovers an authenticated attempt when a new tab has empty session storage", () => {
    saveStudentJoinContext(
      { session_code: "EXAM-123", exam_name: "Networks" },
      { student_id: "S-42", full_name: "Asha Perera" }
    );
    saveCandidateAttempt({
      candidateId: "candidate-1",
      candidateToken: "signed-token",
      faceMatch: 0.91,
    });
    saveStoredAnswers("candidate-1", { q1: "B" });

    sessionStorage.clear();

    expect(getStoredCandidateId()).toBe("candidate-1");
    expect(getStoredCandidateToken()).toBe("signed-token");
    expect(getStoredJoinSession()).toMatchObject({ session_code: "EXAM-123" });
    expect(getStoredJoinStudent()).toEqual({ student_id: "S-42", full_name: "Asha Perera" });
    expect(getStoredAnswers("candidate-1")).toEqual({ q1: "B" });
    expect(sessionStorage.getItem("ag_candidate_token")).toBe("signed-token");
  });

  test("terminal cleanup removes credentials, context, and the candidate draft", () => {
    saveStudentJoinContext(
      { session_code: "EXAM-123" },
      { student_id: "S-42", full_name: "Asha Perera" }
    );
    saveCandidateAttempt({ candidateId: "candidate-1", candidateToken: "signed-token" });
    saveStoredAnswers("candidate-1", { q1: "answer" });

    clearStudentAttempt();

    for (const storage of [sessionStorage, localStorage]) {
      expect(storage.getItem("ag_candidate_id")).toBeNull();
      expect(storage.getItem("ag_candidate_token")).toBeNull();
      expect(storage.getItem("ag_join_session")).toBeNull();
      expect(storage.getItem("ag_join_student")).toBeNull();
      expect(storage.getItem("ag_answers_candidate-1")).toBeNull();
    }
  });

  test("lockdown breach count survives a reload and clears on terminal cleanup", () => {
    saveStoredBreachCount("candidate-1", 2);
    sessionStorage.clear();

    expect(getStoredBreachCount("candidate-1")).toBe(2);

    saveCandidateAttempt({ candidateId: "candidate-1", candidateToken: "signed-token" });
    clearStudentAttempt();

    expect(getStoredBreachCount("candidate-1")).toBe(0);
  });
});


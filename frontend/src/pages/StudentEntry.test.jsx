import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import StudentEntry from "./StudentEntry";
import { api, candidateAuthConfig } from "../lib/api";
import {
  getStoredCandidateId,
  getStoredCandidateToken,
  saveCandidateAttempt,
  saveStudentJoinContext,
} from "../lib/studentSession";

jest.mock("../lib/api", () => ({
  api: { get: jest.fn(), post: jest.fn() },
  candidateAuthConfig: jest.fn(() => ({ headers: { "X-Candidate-Token": "signed-token" } })),
}));

jest.mock("sonner", () => ({
  toast: { error: jest.fn(), info: jest.fn() },
}));

function renderEntry() {
  return render(
    <MemoryRouter initialEntries={["/student"]}>
      <Routes>
        <Route path="/student" element={<StudentEntry />} />
        <Route path="/student/verify" element={<div>Verify route</div>} />
        <Route path="/student/exam" element={<div>Recovered exam route</div>} />
        <Route path="/student/receipt" element={<div>Recovered receipt route</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("StudentEntry attempt recovery", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    jest.clearAllMocks();
    candidateAuthConfig.mockReturnValue({ headers: { "X-Candidate-Token": "signed-token" } });
    saveStudentJoinContext(
      { session_code: "EXAM-123", exam_name: "Networks" },
      { student_id: "S-42", full_name: "Asha Perera" }
    );
    saveCandidateAttempt({ candidateId: "candidate-1", candidateToken: "signed-token" });
  });

  test("validates and resumes the existing attempt without joining again", async () => {
    api.get.mockResolvedValueOnce({
      data: {
        id: "candidate-1",
        status: "approved",
        session_code: "EXAM-123",
        student_id: "S-42",
        full_name: "Asha Perera",
      },
    });
    renderEntry();

    expect(screen.getByTestId("saved-attempt-panel")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("resume-attempt-btn"));

    expect(await screen.findByText("Recovered exam route")).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith(
      "/public/candidates/candidate-1",
      expect.objectContaining({ headers: expect.any(Object) })
    );
  });

  test("clears a stale terminal attempt so the duplicate join cannot recur", async () => {
    api.get.mockResolvedValueOnce({
      data: { id: "candidate-1", status: "kicked", session_code: "EXAM-123" },
    });
    renderEntry();

    await userEvent.click(screen.getByTestId("resume-attempt-btn"));

    await waitFor(() => expect(screen.queryByTestId("saved-attempt-panel")).not.toBeInTheDocument());
    expect(getStoredCandidateId()).toBe("");
    expect(getStoredCandidateToken()).toBe("");
  });
});

describe("StudentEntry quick-join (no identity verification)", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    jest.clearAllMocks();
  });

  test("joins directly and skips /student/verify when the session waives identity verification", async () => {
    api.get.mockResolvedValueOnce({
      data: {
        session_code: "QUIK-ABCD-EFGH",
        exam_name: "Quick Lockdown",
        require_identity_verification: false,
      },
    });
    api.post.mockResolvedValueOnce({
      data: { id: "candidate-9", candidate_token: "candidate-token-long-enough" },
    });

    renderEntry();

    await userEvent.type(screen.getByTestId("code-input"), "QUIK-ABCD-EFGH");
    await userEvent.type(screen.getByTestId("student-id-input"), "S-42");
    await userEvent.type(screen.getByTestId("full-name-input"), "Asha Perera");
    await userEvent.click(screen.getByTestId("continue-btn"));

    expect(await screen.findByText("Recovered exam route")).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith("/public/candidates/join", {
      session_code: "QUIK-ABCD-EFGH",
      student_id: "S-42",
      full_name: "Asha Perera",
    });
    expect(getStoredCandidateId()).toBe("candidate-9");
  });

  test("joining a different quiz than a stale saved attempt does not silently resume the old one", async () => {
    // Simulates a browser that still has an old exam attempt cached (e.g. from
    // an earlier quiz) when the student clicks a notification/link for a
    // brand-new one — the old attempt must not intercept the new join.
    saveStudentJoinContext(
      { session_code: "OLD-EXAM-1", exam_name: "Old Exam" },
      { student_id: "S-OLD", full_name: "Old Student" }
    );
    saveCandidateAttempt({ candidateId: "old-candidate-1", candidateToken: "old-token-long-enough" });

    api.get.mockResolvedValueOnce({
      data: {
        session_code: "NEW-QUIZ-9",
        exam_name: "New Quiz",
        require_identity_verification: false,
      },
    });
    api.post.mockResolvedValueOnce({
      data: { id: "new-candidate-9", candidate_token: "new-candidate-token-long-enough" },
    });

    render(
      <MemoryRouter initialEntries={["/student?code=NEW-QUIZ-9&student_id=S-NEW&name=New+Student"]}>
        <Routes>
          <Route path="/student" element={<StudentEntry />} />
          <Route path="/student/exam" element={<div>Recovered exam route</div>} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText("Recovered exam route")).toBeInTheDocument();
    // The old candidate was never re-validated — this must be a fresh join.
    expect(api.get).toHaveBeenCalledWith("/public/sessions/by-code/NEW-QUIZ-9");
    expect(api.post).toHaveBeenCalledWith("/public/candidates/join", {
      session_code: "NEW-QUIZ-9",
      student_id: "S-NEW",
      full_name: "New Student",
    });
    expect(getStoredCandidateId()).toBe("new-candidate-9");
  });

  test("still requires verification when the session does not waive it", async () => {
    api.get.mockResolvedValueOnce({
      data: { session_code: "EXAM-1", exam_name: "Full Exam" },
    });

    renderEntry();

    await userEvent.type(screen.getByTestId("code-input"), "EXAM-1");
    await userEvent.type(screen.getByTestId("student-id-input"), "S-1");
    await userEvent.type(screen.getByTestId("full-name-input"), "Someone");
    await userEvent.click(screen.getByTestId("continue-btn"));

    expect(await screen.findByText("Verify route")).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });
});

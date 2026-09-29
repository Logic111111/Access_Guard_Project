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

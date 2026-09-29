import React, { useState, useEffect, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Logo } from "../components/Logo";
import { api, candidateAuthConfig } from "../lib/api";
import { ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { buildQuizPromptUrl } from "../lib/moduleQuiz";
import {
  clearStudentAttempt,
  getStoredStudentAttempt,
  saveCandidateAttempt,
  saveStudentJoinContext,
} from "../lib/studentSession";

const TERMINAL_ATTEMPT_STATES = new Set(["kicked", "rejected", "exited"]);

export default function StudentEntry() {
  const nav = useNavigate();
  const location = useLocation();
  const [code, setCode] = useState("");
  const [studentId, setStudentId] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [recovery, setRecovery] = useState(() => {
    const attempt = getStoredStudentAttempt();
    return attempt.candidateId && attempt.candidateToken ? attempt : null;
  });
  const autoAdvanceRef = useRef(false);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const queryCode = params.get("code") || params.get("session_code") || "";
    const queryStudentId = params.get("student_id") || params.get("studentId") || "";
    const queryName = params.get("name") || params.get("full_name") || "";
    const hasContext = Boolean(queryCode || queryStudentId || queryName);

    if (hasContext) {
      setCode(queryCode.toUpperCase());
      setStudentId(queryStudentId);
      setName(queryName);
      if (!autoAdvanceRef.current && queryCode && queryStudentId && queryName) {
        autoAdvanceRef.current = true;
        void continueWithDetails({
          sessionCode: queryCode,
          enteredStudentId: queryStudentId,
          enteredName: queryName,
        });
      }
    }
    // Query parameters are an explicit one-time join instruction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const module = params.get("module") || "";
    if (module) {
      const promptUrl = buildQuizPromptUrl({ module, studentId: studentId || params.get("student_id") || "", name: name || params.get("name") || "", quiz: { session_code: code || params.get("code") || "" } });
      window.history.replaceState({}, "", promptUrl);
    }
  }, [location.search, code, studentId, name]);

  const resumeExistingAttempt = async () => {
    if (!recovery?.candidateId || !recovery?.candidateToken) return "cleared";
    setResuming(true);
    try {
      const { data: candidate } = await api.get(
        `/public/candidates/${recovery.candidateId}`,
        candidateAuthConfig()
      );
      const status = String(candidate?.status || "").toLowerCase();
      const currentSession = recovery.session || {};
      const currentStudent = recovery.student || {};
      saveStudentJoinContext(
        {
          ...currentSession,
          session_code: candidate?.session_code || currentSession.session_code,
        },
        {
          ...currentStudent,
          student_id: candidate?.student_id || currentStudent.student_id,
          full_name: candidate?.full_name || currentStudent.full_name,
        }
      );

      if (status === "finished") {
        nav("/student/receipt");
        return "resumed";
      }
      if (TERMINAL_ATTEMPT_STATES.has(status)) {
        clearStudentAttempt();
        setRecovery(null);
        toast.info("The saved attempt is no longer active. You can join a new exam now.");
        return "cleared";
      }

      nav("/student/exam");
      return "resumed";
    } catch (error) {
      const status = error?.response?.status;
      if ([401, 403, 404].includes(status)) {
        clearStudentAttempt();
        setRecovery(null);
        toast.info("The saved exam login expired. Please verify your details again.");
        return "cleared";
      }
      toast.error("Could not validate the saved exam attempt. Check the connection and retry.");
      return "blocked";
    } finally {
      setResuming(false);
    }
  };

  const continueWithDetails = async ({ sessionCode, enteredStudentId, enteredName }) => {
    const normalizedCode = String(sessionCode || "").trim().toUpperCase();
    if (!normalizedCode) return;
    setLoading(true);
    if (recovery) {
      const recoveryResult = await resumeExistingAttempt();
      if (recoveryResult !== "cleared") {
        setLoading(false);
        return;
      }
    }

    try {
      const { data } = await api.get(`/public/sessions/by-code/${normalizedCode}`);
      const student = {
        student_id: String(enteredStudentId || "").trim(),
        full_name: String(enteredName || "").trim(),
      };
      saveStudentJoinContext(data, student);

      if (data.require_identity_verification === false) {
        const { data: candidate } = await api.post("/public/candidates/join", {
          session_code: data.session_code,
          student_id: student.student_id,
          full_name: student.full_name,
        });
        saveCandidateAttempt({ candidateId: candidate.id, candidateToken: candidate.candidate_token });
        nav("/student/exam");
        return;
      }

      nav("/student/verify");
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Invalid code");
    } finally {
      setLoading(false);
    }
  };

  const next = async (e) => {
    e?.preventDefault?.();
    await continueWithDetails({
      sessionCode: code,
      enteredStudentId: studentId,
      enteredName: name,
    });
  };

  return (
    <div className="min-h-screen hud-bg hex-bg flex items-center justify-center p-6">
      <form onSubmit={next} className="glass rounded-2xl w-full max-w-md p-8" data-testid="student-entry-form">
        <div className="flex flex-col items-center gap-2 mb-6">
          <Logo size={48} showText={false} />
          <h1 className="font-display text-3xl mt-2">Join Exam</h1>
          <p className="text-violet text-sm">Enter your details to begin verification</p>
        </div>
        <div className="space-y-4">
          {recovery && (
            <div className="rounded-xl border border-cyan/40 bg-cyan/5 p-4" data-testid="saved-attempt-panel">
              <div className="label-mono text-cyan">SAVED EXAM ATTEMPT</div>
              <p className="text-sm text-white/70 mt-1">
                {recovery.student?.full_name || "This student"}
                {recovery.session?.session_code ? ` · ${recovery.session.session_code}` : ""}
              </p>
              <p className="text-xs text-white/50 mt-1">
                Validate this login with the server and return to the existing attempt instead of joining twice.
              </p>
              <button
                type="button"
                data-testid="resume-attempt-btn"
                onClick={() => void resumeExistingAttempt()}
                disabled={resuming || loading}
                className="btn-ghost-cyan w-full rounded-lg py-2 mt-3 flex items-center justify-center gap-2"
              >
                {resuming ? "Validating..." : "Return to Exam"} <ChevronRight size={16} />
              </button>
            </div>
          )}
          <div>
            <label className="label-mono">Session Code</label>
            <input data-testid="code-input" className="input-hud mt-1 tracking-widest text-center"
              value={code} onChange={e=>setCode(e.target.value.toUpperCase())}
              placeholder="XXXX-XXXX-XXXX" required />
          </div>
          <div>
            <label className="label-mono">Student ID</label>
            <input data-testid="student-id-input" className="input-hud mt-1"
              value={studentId} onChange={e=>setStudentId(e.target.value)}
              placeholder="234567890" required />
          </div>
          <div>
            <label className="label-mono">Full Name</label>
            <input data-testid="full-name-input" className="input-hud mt-1"
              value={name} onChange={e=>setName(e.target.value)}
              placeholder="Maria Rodriguez" required />
          </div>
          <button data-testid="continue-btn" type="submit" disabled={loading}
            className="btn-cyan w-full rounded-lg py-3 flex items-center justify-center gap-2 mt-2">
            {loading ? "Checking..." : "Continue"} <ChevronRight size={18} />
          </button>
          <div className="text-center text-xs text-white/50 mt-4">
            Are you an invigilator? <a href="/login" className="text-cyan underline">Sign in</a>
          </div>
        </div>
      </form>
    </div>
  );
}

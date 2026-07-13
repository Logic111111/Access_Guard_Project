import React, { useState, useEffect, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Logo } from "../components/Logo";
import { api } from "../lib/api";
import { ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { buildQuizPromptUrl } from "../lib/moduleQuiz";

export default function StudentEntry() {
  const nav = useNavigate();
  const location = useLocation();
  const [code, setCode] = useState("");
  const [studentId, setStudentId] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
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
        void next({ preventDefault() {} });
      }
    }
  }, [location.search]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const module = params.get("module") || "";
    if (module) {
      const promptUrl = buildQuizPromptUrl({ module, studentId: studentId || params.get("student_id") || "", name: name || params.get("name") || "", quiz: { session_code: code || params.get("code") || "" } });
      window.history.replaceState({}, "", promptUrl);
    }
  }, [location.search, code, studentId, name]);

  const next = async (e) => {
    e?.preventDefault?.();
    if (!code.trim()) return;
    setLoading(true);
    try {
      const { data } = await api.get(`/public/sessions/by-code/${code.trim().toUpperCase()}`);
      sessionStorage.setItem("ag_join_session", JSON.stringify(data));
      sessionStorage.setItem("ag_join_student", JSON.stringify({ student_id: studentId, full_name: name }));
      nav("/student/verify");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Invalid code");
    } finally { setLoading(false); }
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

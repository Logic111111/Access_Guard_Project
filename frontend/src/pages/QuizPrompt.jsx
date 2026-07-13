import React, { useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Logo } from "../components/Logo";
import { api } from "../lib/api";
import { ArrowRight, BookOpen, Sparkles, BellRing } from "lucide-react";
import { toast } from "sonner";
import { buildQuizPromptUrl } from "../lib/moduleQuiz";

export default function QuizPrompt() {
  const nav = useNavigate();
  const location = useLocation();
  const [loading, setLoading] = useState(true);
  const [quiz, setQuiz] = useState(null);
  const [moduleCode, setModuleCode] = useState("");
  const [studentId, setStudentId] = useState("");
  const [name, setName] = useState("");
  const [notice, setNotice] = useState("");
  const lastNotifiedQuizRef = useRef(null);

  const loadQuiz = async (showLoading = true) => {
    const params = new URLSearchParams(location.search);
    const rawModule = params.get("module") || params.get("module_code") || params.get("module_name") || params.get("course") || "";
    const module = rawModule.trim().toUpperCase();
    const student = params.get("student_id") || params.get("studentId") || params.get("user_id") || "";
    const fullName = params.get("name") || params.get("full_name") || params.get("student_name") || params.get("fullName") || "";
    setModuleCode(module);
    setStudentId(student);
    setName(fullName);

    if (!module) {
      setQuiz(null);
      if (showLoading) setLoading(false);
      return;
    }

    if (showLoading) setLoading(true);
    try {
      const { data } = await api.get(`/public/quizzes/module/${encodeURIComponent(module)}`);
      const match = Array.isArray(data) && data.length ? data[0] : null;
      setQuiz(match);
      if (match && match.id && match.id !== lastNotifiedQuizRef.current) {
        lastNotifiedQuizRef.current = match.id;
        const message = `New quiz available for ${module}: ${match.quiz_prompt_title || match.exam_name}`;
        setNotice(message);
        toast.success(message);
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("accessguard:quiz-available", { detail: { module, quiz: match, studentId: student, name: fullName } }));
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({ type: "accessguard:quiz-available", module, quiz: match, studentId: student, name: fullName }, "*");
          }
          if ("Notification" in window) {
            if (Notification.permission === "granted") {
              new Notification("New quiz available", { body: message });
            } else if (Notification.permission !== "denied") {
              Notification.requestPermission().catch(() => {});
            }
          }
        }
      }
      if (!match) {
        lastNotifiedQuizRef.current = null;
      }
    } catch (e) {
      setQuiz(null);
      lastNotifiedQuizRef.current = null;
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  useEffect(() => {
    lastNotifiedQuizRef.current = null;
    void loadQuiz(true);
    const timer = setInterval(() => { void loadQuiz(false); }, 8000);
    return () => clearInterval(timer);
  }, [location.search]);

  const continueToJoin = () => {
    const query = new URLSearchParams({
      code: quiz?.session_code || "",
      student_id: studentId,
      name,
      module: moduleCode,
    });
    nav(`/student?${query.toString()}`);
  };

  useEffect(() => {
    const handleModuleAnnouncement = (event) => {
      const detail = event?.detail || {};
      if (!detail.module && !detail.quiz) return;
      const message = `Quiz ready in ${detail.module || "your module"}: ${detail.quiz?.quiz_prompt_title || detail.quiz?.exam_name || "Quick assessment"}`;
      setNotice(message);
      toast.success(message);
    };

    window.addEventListener("accessguard:quiz-available", handleModuleAnnouncement);
    window.addEventListener("message", (event) => {
      const data = event?.data;
      if (data?.type !== "accessguard:quiz-available") return;
      const message = `Quiz ready in ${data.module || "your module"}: ${data.quiz?.quiz_prompt_title || data.quiz?.exam_name || "Quick assessment"}`;
      setNotice(message);
      toast.success(message);
    });

    return () => {
      window.removeEventListener("accessguard:quiz-available", handleModuleAnnouncement);
    };
  }, []);

  return (
    <div className="min-h-screen hud-bg hex-bg flex items-center justify-center p-6">
      <div className="glass rounded-2xl w-full max-w-lg p-8">
        <div className="flex items-center gap-3 mb-6">
          <Logo size={44} showText={false} />
          <div>
            <div className="font-display text-2xl">Quick Quiz Ready</div>
            <div className="text-sm text-white/60">ELMS module {moduleCode || "—"}</div>
          </div>
        </div>

        {notice && (
          <div className="mb-4 rounded-xl border border-cyan/30 bg-cyan/10 p-3 text-sm text-cyan flex items-start gap-2">
            <BellRing size={16} className="mt-0.5" />
            <span>{notice}</span>
          </div>
        )}

        {loading ? (
          <div className="text-white/60">Checking available quizzes…</div>
        ) : !quiz ? (
          <div className="rounded-xl border border-violet/20 bg-elevated/20 p-4 text-sm text-white/70">
            No published quiz is currently available for this module.
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-xl border border-cyan/20 bg-cyan/10 p-4">
              <div className="flex items-center gap-2 text-cyan mb-2">
                <BookOpen size={16} />
                <span className="font-mono text-xs uppercase">{quiz.quiz_prompt_title || "Quick assessment"}</span>
              </div>
              <div className="font-display text-xl">{quiz.exam_name}</div>
              <div className="text-sm text-white/70 mt-2">{quiz.quiz_prompt_body || "A quick assessment is available for this module."}</div>
            </div>
            <div className="rounded-xl border border-violet/20 bg-elevated/20 p-4 text-sm text-white/70">
              <div className="flex items-center gap-2 text-violet mb-2">
                <Sparkles size={16} />
                <span className="font-mono text-xs uppercase">Session</span>
              </div>
              <div className="font-mono text-cyan">{quiz.session_code}</div>
              <div className="mt-2">Duration: {quiz.duration_minutes} minutes</div>
              <div className="mt-2 text-xs text-white/55">This prompt is intended for students already signed into the module page such as Machine Learning or Power Electronics.</div>
            </div>
            <button onClick={continueToJoin} className="btn-cyan w-full rounded-lg py-3 flex items-center justify-center gap-2">
              Join Quiz <ArrowRight size={18} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

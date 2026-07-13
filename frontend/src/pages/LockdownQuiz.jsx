import React, { useEffect, useState, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { api } from "../lib/api";
import { Lock, ShieldCheck, Send, AlertTriangle, Clock } from "lucide-react";
import { toast } from "sonner";

export default function LockdownQuiz() {
  const nav = useNavigate();
  const location = useLocation();
  const [session, setSession] = useState(null);
  const [answers, setAnswers] = useState({});
  const [timeLeft, setTimeLeft] = useState(0);
  const [locked, setLocked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const candidateId = sessionStorage.getItem("ag_candidate_id");
  const candidateToken = sessionStorage.getItem("ag_candidate_token");
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const code = params.get("code") || "";
    if (!code) {
      nav("/student");
      return;
    }

    const load = async () => {
      try {
        const { data } = await api.get(`/public/sessions/by-code/${encodeURIComponent(code.toUpperCase())}`);
        setSession(data);
        setTimeLeft((data.duration_minutes || 30) * 60);
      } catch (e) {
        toast.error("Quiz could not be loaded");
      }
    };
    load();
  }, [location.search, nav]);

  useEffect(() => {
    if (!candidateId || !session || locked) return;
    const t = setInterval(() => setTimeLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [candidateId, session, locked]);

  useEffect(() => {
    if (!candidateId || !candidateToken || !session) return;
    navigator.mediaDevices?.getUserMedia?.({ video: { facingMode: "user" }, audio: false })
      .then((stream) => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      }).catch(() => {});
    const sendFrame = () => {
      const v = videoRef.current;
      const c = canvasRef.current;
      if (!v || !c) return;
      c.width = 320; c.height = 240;
      c.getContext("2d").drawImage(v, 0, 0, 320, 240);
      const image = c.toDataURL("image/jpeg", 0.5);
      api.post("/public/frames", { candidate_id: candidateId, candidate_token: candidateToken, image_b64: image }).catch(() => {});
    };
    sendFrame();
    const timer = setInterval(sendFrame, 3000);
    return () => clearInterval(timer);
  }, [candidateId, candidateToken, session]);

  const submit = async () => {
    if (!candidateId) return;
    setSubmitting(true);
    try {
      await api.post("/public/answers", { candidate_id: candidateId, answers });
      toast.success("Quiz submitted");
      nav("/student/receipt");
    } catch (e) {
      toast.error("Failed to submit quiz");
    } finally { setSubmitting(false); }
  };

  const lockNow = async () => {
    if (!candidateId) return;
    await api.post("/public/violations", { candidate_id: candidateId, kind: "prohibited_url", detail: "Quiz lockdown triggered" });
    setLocked(true);
  };

  const fmt = (s) => `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  if (locked) return <div className="min-h-screen hud-bg flex items-center justify-center p-6"><div className="glass neon-red rounded-2xl p-8 text-center max-w-md"><Lock size={40} className="mx-auto mb-3 text-violation" /><h1 className="font-display text-2xl">Quiz Locked</h1><p className="text-white/70 mt-2">The assessment is now locked due to a monitoring event.</p></div></div>;

  if (!session) return <div className="min-h-screen hud-bg flex items-center justify-center p-6"><div className="glass rounded-2xl p-8 text-white/60">Loading secure quiz…</div></div>;

  return (
    <div className="min-h-screen hud-bg p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="glass rounded-2xl p-5 flex items-center justify-between flex-wrap gap-4">
          <div>
            <div className="label-mono text-cyan">SECURE QUIZ</div>
            <h1 className="font-display text-2xl">{session.exam_name}</h1>
            <div className="text-sm text-white/60">Module {session.module_code || "—"}</div>
          </div>
          <div className="flex items-center gap-3">
            <div className="glass rounded-lg px-3 py-2 flex items-center gap-2 font-mono"><Clock size={14} className="text-cyan" /> {fmt(timeLeft)}</div>
            <div className="glass rounded-lg px-3 py-2 flex items-center gap-2 font-mono text-violation"><AlertTriangle size={14} /> Lockdown</div>
          </div>
        </div>

        <div className="glass rounded-2xl p-5 flex items-start gap-4">
          <div className="flex-1">
            <div className="label-mono text-violet">Monitoring</div>
            <div className="text-sm text-white/70 mt-2">Your activity is monitored during this quiz. Keep the page active and answer only within this secure assessment window.</div>
          </div>
          <div className="w-32 h-24 rounded-lg overflow-hidden border border-cyan/40 bg-elevated/40 flex items-center justify-center">
            <video ref={videoRef} muted playsInline className="w-full h-full object-cover" />
            <canvas ref={canvasRef} className="hidden" />
          </div>
        </div>

        {(session.questions || []).map((q, idx) => (
          <div key={q.id} className="glass rounded-2xl p-5">
            <div className="flex items-center justify-between">
              <div className="label-mono text-cyan">QUESTION {idx + 1}</div>
              <div className="text-xs text-white/50">{q.marks || 10} marks</div>
            </div>
            <div className="font-display text-lg mt-2">{q.text}</div>
            {q.type === "mcq" ? (
              <div className="mt-4 space-y-3">
                {(["A", "B", "C", "D"]).map((letter, optIdx) => {
                  const optVal = (q.options || [])[optIdx] || "";
                  if (!optVal) return null;
                  return (
                    <label key={optIdx} className="flex items-center gap-3 cursor-pointer p-3 rounded-lg border border-violet/10 hover:bg-cyan/5 transition-colors">
                      <input type="radio" name={`question-${q.id}`} value={letter} checked={answers[q.id] === letter} onChange={() => setAnswers((a) => ({ ...a, [q.id]: letter }))} className="accent-cyan w-4 h-4" />
                      <span className="font-mono text-cyan font-bold">{letter}.</span>
                      <span className="text-sm">{optVal}</span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <textarea className="input-hud mt-4 min-h-[140px]" value={answers[q.id] || ""} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} placeholder="Type your answer here..." />
            )}
          </div>
        ))}

        <div className="flex justify-between gap-3">
          <button onClick={lockNow} className="btn-ghost-violet rounded-full px-5 py-2.5 flex items-center gap-2 text-xs"><ShieldCheck size={14}/> Simulate Lockdown</button>
          <button onClick={submit} disabled={submitting} className="btn-cyan rounded-full px-6 py-2.5 flex items-center gap-2"><Send size={16}/> {submitting ? "Submitting..." : "Submit Quiz"}</button>
        </div>
      </div>
    </div>
  );
}

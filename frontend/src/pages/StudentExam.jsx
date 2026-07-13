import React, { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Logo } from "../components/Logo";
import { api } from "../lib/api";
import { Lock, Send, AlertTriangle, Clock } from "lucide-react";
import { toast } from "sonner";

export default function StudentExam() {
  const nav = useNavigate();
  const [candidateId] = useState(() => sessionStorage.getItem("ag_candidate_id"));
  const [session] = useState(() => JSON.parse(sessionStorage.getItem("ag_join_session") || "{}"));
  const [status, setStatus] = useState("pending");
  const [answers, setAnswers] = useState({});
  const [timeLeft, setTimeLeft] = useState((session.duration_minutes || 60) * 60);
  const [violations, setViolations] = useState(0);
  const [locked, setLocked] = useState(false);
  const [kicked, setKicked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const startedRef = useRef(false);
  const videoRef = useRef(null);
  const frameCanvasRef = useRef(null);
  const [streaming, setStreaming] = useState(false);

  // Start camera on mount for live monitoring
  useEffect(() => {
    if (!candidateId) return;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: false });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setStreaming(true);
      } catch (e) { /* camera denied — heartbeats will still flow */ }
    })();
    return () => {
      const v = videoRef.current;
      if (v?.srcObject) v.srcObject.getTracks().forEach(t => t.stop());
    };
  }, [candidateId]);

  // Stream a webcam frame every 3 seconds while approved
  useEffect(() => {
    if (!candidateId || status !== "approved" || !streaming) return;
    const send = () => {
      const v = videoRef.current; const c = frameCanvasRef.current;
      if (!v?.videoWidth || !c) return;
      c.width = 320; c.height = 240;
      c.getContext("2d").drawImage(v, 0, 0, 320, 240);
      const data = c.toDataURL("image/jpeg", 0.5);
      const tok = sessionStorage.getItem("ag_candidate_token") || "";
      api.post("/public/frames", { candidate_id: candidateId, candidate_token: tok, image_b64: data }).catch(()=>{});
    };
    send();
    const t = setInterval(send, 3000);
    return () => clearInterval(t);
  }, [candidateId, status, streaming]);

  // Poll candidate status
  useEffect(() => {
    if (!candidateId) { nav("/student"); return; }
    const t = setInterval(async () => {
      try {
        const { data } = await api.get(`/public/candidates/${candidateId}`);
        setStatus(data.status);
        if (data.status === "locked") setLocked(true);
        if (data.status === "kicked") setKicked(true);
        if (data.status === "approved" && !startedRef.current) startedRef.current = true;
      } catch {}
    }, 3000);
    return () => clearInterval(t);
  }, [candidateId, nav]);

  // Heartbeat every 10s
  useEffect(() => {
    if (!candidateId || status !== "approved") return;
    const send = () => api.post("/public/heartbeats", {
      candidate_id: candidateId,
      latency_ms: 20 + Math.floor(Math.random()*30),
      bandwidth: "good",
      face_visible: !document.hidden,
      tab_active: !document.hidden,
    }).catch(()=>{});
    send();
    const t = setInterval(send, 10000);
    return () => clearInterval(t);
  }, [candidateId, status]);

  // Tab-visibility violation detection
  useEffect(() => {
    if (!candidateId) return;
    const onBlur = () => {
      api.post("/public/violations", {
        candidate_id: candidateId,
        kind: "tab_switch",
        detail: "Window lost focus",
      }).then(()=>setViolations(v=>v+1)).catch(()=>{});
    };
    const onCopy = (e) => {
      e.preventDefault();
      api.post("/public/violations", {
        candidate_id: candidateId, kind: "copy_attempt", detail: "Copy blocked",
      }).then(()=>setViolations(v=>v+1)).catch(()=>{});
    };
    window.addEventListener("blur", onBlur);
    document.addEventListener("copy", onCopy);
    document.addEventListener("contextmenu", (e) => e.preventDefault());
    return () => { window.removeEventListener("blur", onBlur); document.removeEventListener("copy", onCopy); };
  }, [candidateId]);

  // Timer
  useEffect(() => {
    if (status !== "approved" || locked) return;
    const t = setInterval(() => setTimeLeft(s => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [status, locked]);

  // Auto-submit on time end
  useEffect(() => { if (timeLeft === 0 && status === "approved") submit(); /* eslint-disable-next-line */ }, [timeLeft]);

  const submit = async () => {
    setSubmitting(true);
    try {
      await api.post("/public/answers", { candidate_id: candidateId, answers });
      toast.success("Submitted!");
      nav("/student/receipt");
    } catch (e) {
      toast.error("Submit failed");
    } finally { setSubmitting(false); }
  };

  const lockNow = async () => {
    if (!candidateId) return;
    await api.post("/public/violations", {
      candidate_id: candidateId, kind: "prohibited_url", detail: "Test prohibited site",
    });
    setLocked(true);
  };

  const fmt = (s) => `${String(Math.floor(s/3600)).padStart(2,"0")}:${String(Math.floor((s%3600)/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;

  if (locked) {
    return (
      <div className="min-h-screen hud-bg flex items-center justify-center p-6">
        <div className="glass neon-red rounded-2xl p-10 text-center max-w-md" data-testid="locked-screen">
          <Lock size={48} className="text-violation mx-auto mb-4" />
          <h1 className="font-display text-3xl text-violation">EXAM LOCKED</h1>
          <p className="text-white/70 mt-3">A serious violation was detected. Your session has been suspended. Please contact your invigilator.</p>
        </div>
      </div>
    );
  }

  if (kicked) {
    return (
      <div className="min-h-screen hud-bg flex items-center justify-center p-6">
        <div className="glass neon-red rounded-2xl p-10 text-center max-w-md" data-testid="kicked-screen">
          <AlertTriangle size={48} className="text-violation mx-auto mb-4" />
          <h1 className="font-display text-3xl text-violation">SESSION TERMINATED</h1>
          <p className="text-white/70 mt-3">You have been removed from the session by the invigilator.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen hud-bg p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <Logo />
          <div className="flex items-center gap-3">
            <div className="glass rounded-lg px-4 py-2 flex items-center gap-2 font-mono" data-testid="exam-timer">
              <Clock size={14} className="text-cyan"/> {fmt(timeLeft)}
            </div>
            <div className="glass rounded-lg px-3 py-2 font-mono text-xs">
              <span className="text-violation">⚠ {violations}</span>
            </div>
          </div>
        </div>

        {status === "pending" && (
          <div className="glass rounded-2xl p-10 text-center" data-testid="awaiting-approval">
            <div className="font-display text-2xl text-cyan">Awaiting invigilator approval...</div>
            <p className="text-white/60 mt-2">Your face match and ID are being reviewed. Stay on this page.</p>
            <div className="mt-6 inline-block dot-pulse text-online font-mono text-sm">CONNECTED</div>
          </div>
        )}

        {status === "rejected" && (
          <div className="glass neon-red rounded-2xl p-10 text-center">
            <div className="font-display text-2xl text-violation">Access Denied</div>
            <p className="text-white/60 mt-2">Your join request was rejected by the invigilator.</p>
          </div>
        )}

        {(status === "approved" || status === "active" || status === "finished") && (
          <div className="space-y-6">
            <div className="glass rounded-xl p-5 flex items-start gap-4">
              <div className="flex-1">
                <div className="label-mono">EXAM</div>
                <h1 className="font-display text-2xl">{session.exam_name}</h1>
              </div>
              <div className="relative w-32 h-24 rounded-lg overflow-hidden border border-cyan/40 neon-cyan flex-shrink-0" data-testid="webcam-preview">
                <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
                <canvas ref={frameCanvasRef} className="hidden" />
                <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-void/80 text-[9px] font-mono text-online dot-pulse">REC</div>
              </div>
            </div>

            {(session.questions || []).map((q, i) => (
              <div key={q.id} className="glass rounded-xl p-5" data-testid={`question-${q.id}`}>
                <div className="flex items-center justify-between">
                  <div className="label-mono">QUESTION {i+1} • {q.marks || 10} MARKS</div>
                </div>
                <div className="font-display text-lg mt-2">{q.text}</div>
                {q.type === "mcq" ? (
                  <div className="mt-4 space-y-3">
                    {["A", "B", "C", "D"].map((letter, optIdx) => {
                      const optVal = (q.options || [])[optIdx] || "";
                      if (!optVal) return null;
                      return (
                        <label key={optIdx} className="flex items-center gap-3 cursor-pointer p-3 rounded-lg border border-violet/10 hover:bg-cyan/5 transition-colors">
                          <input
                            type="radio"
                            name={`question-${q.id}`}
                            value={letter}
                            checked={answers[q.id] === letter}
                            onChange={() => setAnswers(a => ({ ...a, [q.id]: letter }))}
                            className="accent-cyan w-4 h-4"
                            data-testid={`option-${q.id}-${letter}`}
                          />
                          <span className="font-mono text-cyan font-bold">{letter}.</span>
                          <span className="text-sm">{optVal}</span>
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <textarea
                    data-testid={`answer-${q.id}`}
                    className="input-hud mt-4 min-h-[140px] font-sans"
                    placeholder="Type your answer here..."
                    value={answers[q.id] || ""}
                    onChange={e => setAnswers(a => ({ ...a, [q.id]: e.target.value }))}
                  />
                )}
              </div>
            ))}

            <div className="flex gap-3 justify-between">
              <button onClick={lockNow} data-testid="test-lock-btn"
                className="btn-ghost-violet rounded-full px-5 py-2.5 flex items-center gap-2 text-xs">
                <AlertTriangle size={14}/> Simulate Prohibited URL (Demo)
              </button>
              <button onClick={submit} disabled={submitting} data-testid="submit-exam-btn"
                className="btn-cyan rounded-full px-6 py-2.5 flex items-center gap-2">
                <Send size={16}/> {submitting ? "Submitting..." : "Submit Exam"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

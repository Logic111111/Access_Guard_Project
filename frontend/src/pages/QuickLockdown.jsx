import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import AppShell from "../components/AppShell";
import { api } from "../lib/api";
import { Zap, ArrowRight, Plus, X } from "lucide-react";
import { toast } from "sonner";

function defaultExamName() {
  return `Quick Lockdown — ${new Date().toLocaleString()}`;
}

export default function QuickLockdown() {
  const nav = useNavigate();
  const [examName, setExamName] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [questionText, setQuestionText] = useState("");
  const [modelAnswer, setModelAnswer] = useState("");
  const [urls, setUrls] = useState([]);
  const [urlInput, setUrlInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState(null);

  const addUrl = () => {
    if (!urlInput.trim()) return;
    setUrls((u) => [...u, urlInput.trim()]);
    setUrlInput("");
  };

  const removeUrl = (idx) => setUrls((u) => u.filter((_, i) => i !== idx));

  const launch = async () => {
    if (!questionText.trim()) {
      toast.error("Add a question before launching.");
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        exam_name: examName.trim() || defaultExamName(),
        exam_code: `QUICK-${Date.now().toString(36).toUpperCase()}`,
        duration_minutes: Number(durationMinutes) || 60,
        max_students: 100,
        whitelisted_urls: urls,
        questions: [{ id: "q1", type: "text", text: questionText.trim(), marks: 10, options: [] }],
        model_answers: { q1: modelAnswer.trim() },
        lockdown_mode: "extension_required",
        require_manual_approval: false,
        require_identity_verification: false,
        auto_record_webcam: false,
        save_screen_share: false,
      };
      const { data } = await api.post("/sessions", payload);
      await api.post(`/sessions/${data.id}/start`);
      setCreated(data);
      toast.success("Quick lockdown started. Share the code with students.");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to start quick lockdown");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppShell title="Quick Lockdown" breadcrumb="Home / Sessions / Quick Lockdown">
      <div className="max-w-2xl mx-auto glass rounded-2xl p-8 space-y-5" data-testid="quick-lockdown-card">
        {!created ? (
          <>
            <div className="flex items-center gap-2 text-cyan">
              <Zap size={18} />
              <h2 className="font-display text-2xl">Start a quick lockdown</h2>
            </div>
            <p className="text-white/60 text-sm">
              No identity verification and no manual approval — students join with just a name
              and ID and the browser locks down immediately.
            </p>
            <div>
              <label className="label-mono">Exam Name (optional)</label>
              <input data-testid="quick-name-input" className="input-hud mt-1"
                value={examName} onChange={(e) => setExamName(e.target.value)}
                placeholder={defaultExamName()} />
            </div>
            <div>
              <label className="label-mono">Duration (minutes)</label>
              <input data-testid="quick-duration-input" type="number" min={5} max={480}
                className="input-hud mt-1" value={durationMinutes}
                onChange={(e) => setDurationMinutes(e.target.value)} />
            </div>
            <div>
              <label className="label-mono">Question</label>
              <textarea data-testid="quick-question-input" className="input-hud mt-1 min-h-[80px]"
                value={questionText} onChange={(e) => setQuestionText(e.target.value)}
                placeholder="What should students answer?" />
            </div>
            <div>
              <label className="label-mono">Model Answer (for auto-grading)</label>
              <textarea data-testid="quick-model-answer-input" className="input-hud mt-1 min-h-[60px]"
                value={modelAnswer} onChange={(e) => setModelAnswer(e.target.value)}
                placeholder="Key points expected in the answer..." />
            </div>
            <div>
              <label className="label-mono">Allowed URLs (optional)</label>
              <div className="flex gap-2 mt-1">
                <input data-testid="quick-url-input" className="input-hud" value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)} placeholder="docs.python.org" />
                <button data-testid="quick-url-add-btn" onClick={addUrl}
                  className="btn-ghost-cyan rounded-md px-3"><Plus size={16} /></button>
              </div>
              <div className="flex flex-wrap gap-2 mt-3">
                {urls.map((u, i) => (
                  <span key={i} className="glass rounded-full pl-3 pr-2 py-1 text-xs flex items-center gap-2 font-mono">
                    {u}
                    <button onClick={() => removeUrl(i)} data-testid={`quick-url-remove-${i}`}
                      className="text-violation hover:scale-110"><X size={12} /></button>
                  </span>
                ))}
              </div>
            </div>
            <button data-testid="quick-launch-btn" onClick={launch} disabled={submitting}
              className="btn-cyan w-full rounded-full px-6 py-3 flex items-center justify-center gap-2">
              <Zap size={16} /> {submitting ? "Starting..." : "Start Quick Lockdown"}
            </button>
          </>
        ) : (
          <div className="glass glass-violet rounded-lg p-5 text-center" data-testid="quick-session-launched">
            <div className="label-mono text-online">QUICK LOCKDOWN LIVE</div>
            <div className="font-display text-3xl text-cyan mt-2 tracking-widest" data-testid="quick-session-code-display">
              {created.session_code}
            </div>
            <div className="text-xs text-white/60 mt-2">Share this code with students. No verification required.</div>
            <button data-testid="quick-goto-dashboard-btn" onClick={() => nav(`/sessions/${created.id}/dashboard`)}
              className="btn-cyan rounded-lg px-5 py-2.5 mt-4 inline-flex items-center gap-2">
              Open Live Dashboard <ArrowRight size={16} />
            </button>
          </div>
        )}
      </div>
    </AppShell>
  );
}

import React, { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import AppShell from "../components/AppShell";
import { api } from "../lib/api";
import { Check, ArrowLeft, ArrowRight, Plus, X, Rocket } from "lucide-react";
import { toast } from "sonner";

const STEPS = ["Identify", "Configure", "Questions", "Whitelist", "Launch"];

export default function CreateSession() {
  const nav = useNavigate();
  const location = useLocation();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    exam_name: "",
    exam_code: "",
    duration_minutes: 180,
    max_students: 50,
    heartbeat_interval_sec: 10,
    allow_pause: true,
    auto_record_webcam: true,
    save_screen_share: true,
    whitelisted_urls: ["docs.python.org"],
    whitelisted_apps: ["Calculator"],
    questions: [
      { id: "q1", type: "text", text: "Define modular software design and its benefits.", marks: 10, options: [] },
      { id: "q2", type: "text", text: "Compare REST and GraphQL APIs.", marks: 10, options: [] },
    ],
    model_answers: {
      q1: "Modular software design breaks a system into discrete, loosely coupled modules each with a clear responsibility. Benefits: reusability, testability, parallel development, easier maintenance.",
      q2: "REST exposes resources via fixed HTTP endpoints; GraphQL exposes a single endpoint with a typed query language allowing clients to request exactly the fields they need; trade-offs include caching, learning curve, over/under-fetching.",
    },
    scheduled_for: new Date().toISOString().slice(0, 10),
    quiz_mode: false,
    module_code: "",
    quiz_prompt_title: "",
    quiz_prompt_body: "",
    published: false,
  });
  const [created, setCreated] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const upd = (k, v) => setForm(f => ({ ...f, [k]: v }));

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("mode") === "quiz") {
      upd("quiz_mode", true);
      upd("published", true);
      upd("quiz_prompt_title", "Quick quiz available now");
      upd("quiz_prompt_body", "Students in this module can join this assessment from the course page.");
    }
  }, [location.search]);

  const next = () => setStep(s => Math.min(4, s + 1));
  const back = () => setStep(s => Math.max(0, s - 1));

  const addQuestion = () => {
    const id = "q" + Date.now();
    setForm(f => ({
      ...f,
      questions: [...f.questions, { id, type: "text", text: "", marks: 10, options: [] }],
      model_answers: { ...f.model_answers, [id]: "" }
    }));
  };

  const removeQuestion = (id) => {
    setForm(f => {
      const newAnswers = { ...f.model_answers };
      delete newAnswers[id];
      return {
        ...f,
        questions: f.questions.filter(q => q.id !== id),
        model_answers: newAnswers
      };
    });
  };

  const updateQuestion = (id, key, val) => {
    setForm(f => ({
      ...f,
      questions: f.questions.map(q => q.id === id ? { ...q, [key]: val } : q)
    }));
  };

  const updateModelAnswer = (id, val) => {
    setForm(f => ({
      ...f,
      model_answers: { ...f.model_answers, [id]: val }
    }));
  };

  const launch = async () => {
    setSubmitting(true);
    try {
      const payload = {
        ...form,
        quiz_mode: Boolean(form.quiz_mode),
        published: Boolean(form.quiz_mode && form.published),
        module_code: form.quiz_mode ? form.module_code.trim().toUpperCase() : "",
        quiz_prompt_title: form.quiz_mode ? form.quiz_prompt_title.trim() : "",
        quiz_prompt_body: form.quiz_mode ? form.quiz_prompt_body.trim() : "",
      };
      const { data } = await api.post("/sessions", payload);
      setCreated(data);
      toast.success(form.quiz_mode ? "Quick quiz created and published for the selected module." : "Session created. Share the code with candidates.");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to create session");
    } finally { setSubmitting(false); }
  };

  return (
    <AppShell title="Create Exam Session" breadcrumb="Sessions / New">
      {/* Stepper */}
      <div className="flex items-center justify-between max-w-3xl mx-auto mb-10" data-testid="wizard-stepper">
        {STEPS.map((label, i) => (
          <React.Fragment key={label}>
            <div className="flex flex-col items-center">
              <div className={`w-12 h-12 rounded-full flex items-center justify-center transition-all ${
                i < step ? "bg-cyan text-void neon-cyan" :
                i === step ? "border-2 border-cyan text-cyan animate-pulse-glow" :
                "border-2 border-violet/40 text-violet/60"
              }`}>
                {i < step ? <Check size={18} /> : <span className="font-mono text-sm">{i + 1}</span>}
              </div>
              <div className="mt-2 text-xs label-mono">{label}</div>
            </div>
            {i < STEPS.length - 1 && (
              <div className={`flex-1 h-0.5 mx-3 ${i < step ? "bg-cyan" : "bg-violet/30"}`} />
            )}
          </React.Fragment>
        ))}
      </div>

      <div className="max-w-3xl mx-auto glass rounded-2xl p-8" data-testid="wizard-card">
        {step === 0 && (
          <div className="space-y-5">
            <h2 className="font-display text-2xl">Step 1 — Identify</h2>
            <div className="glass rounded-xl p-4 border border-cyan/20">
              <label className="flex items-center gap-3 cursor-pointer text-sm">
                <input data-testid="quiz-mode-toggle" type="checkbox" checked={form.quiz_mode} onChange={e => upd("quiz_mode", e.target.checked)} className="accent-cyan w-4 h-4" />
                <span className="font-medium">Create this as a quick module quiz / in-class assessment</span>
              </label>
              <p className="text-xs text-white/55 mt-2">When enabled, the quiz can be discovered by a module-aware join prompt and launched without the full exam wizard.</p>
            </div>
            <div>
              <label className="label-mono">Exam Name</label>
              <input data-testid="exam-name-input" className="input-hud mt-1"
                value={form.exam_name} onChange={e => upd("exam_name", e.target.value)}
                placeholder="EE5206 — Software Project Final" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label-mono">Exam Code</label>
                <input data-testid="exam-code-input" className="input-hud mt-1"
                  value={form.exam_code} onChange={e => upd("exam_code", e.target.value.toUpperCase())}
                  placeholder="EE5206-2026-FIN" />
              </div>
              <div>
                <label className="label-mono">Date</label>
                <input data-testid="exam-date-input" type="date" className="input-hud mt-1"
                  value={form.scheduled_for} onChange={e => upd("scheduled_for", e.target.value)} />
              </div>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-5">
            <h2 className="font-display text-2xl">Step 2 — Configure</h2>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label-mono">Duration (minutes)</label>
                <input data-testid="duration-input" type="number" min={15} max={480}
                  className="input-hud mt-1" value={form.duration_minutes}
                  onChange={e => upd("duration_minutes", Number(e.target.value))} />
              </div>
              <div>
                <label className="label-mono">Maximum Students</label>
                <input data-testid="max-students-input" type="number" min={1} max={500}
                  className="input-hud mt-1" value={form.max_students}
                  onChange={e => upd("max_students", Number(e.target.value))} />
              </div>
              <div>
                <label className="label-mono">Heartbeat Interval (sec)</label>
                <input data-testid="heartbeat-input" type="number" min={5} max={60}
                  className="input-hud mt-1" value={form.heartbeat_interval_sec}
                  onChange={e => upd("heartbeat_interval_sec", Number(e.target.value))} />
              </div>
            </div>
            <div className="flex flex-wrap gap-6 pt-2">
              {[
                ["allow_pause", "Allow Pause"],
                ["auto_record_webcam", "Auto-record Webcam"],
                ["save_screen_share", "Save Screen-Share"],
              ].map(([k, lbl]) => (
                <label key={k} className="flex items-center gap-2 cursor-pointer">
                  <input data-testid={`toggle-${k}`} type="checkbox" checked={form[k]}
                    onChange={e => upd(k, e.target.checked)}
                    className="accent-cyan w-4 h-4" />
                  <span className="text-sm">{lbl}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <h2 className="font-display text-2xl">Step 3 — Questions</h2>
            <p className="text-white/60 text-sm">Add questions and model answers for auto-grading.</p>
            {form.questions.map((q, idx) => (
              <div key={q.id} className="glass rounded-xl p-5 relative">
                <button onClick={() => removeQuestion(q.id)} className="absolute top-4 right-4 text-white/40 hover:text-violation transition-colors">
                  <X size={16} />
                </button>
                 <div className="flex gap-4 flex-wrap">
                  <div className="flex-1 min-w-[250px]">
                    <label className="label-mono text-cyan">Question {idx + 1}</label>
                    <textarea className="input-hud mt-1 min-h-[80px]" value={q.text} onChange={e => updateQuestion(q.id, "text", e.target.value)} placeholder="Enter question..." />
                  </div>
                  <div className="w-36">
                    <label className="label-mono">Type</label>
                    <select
                      className="input-hud mt-1"
                      value={q.type || "text"}
                      onChange={e => {
                        updateQuestion(q.id, "type", e.target.value);
                        updateQuestion(q.id, "options", e.target.value === "mcq" ? ["", "", "", ""] : []);
                        updateModelAnswer(q.id, "");
                      }}
                    >
                      <option value="text">Written Answer</option>
                      <option value="mcq">Multiple Choice</option>
                    </select>
                  </div>
                  <div className="w-24">
                    <label className="label-mono">Marks</label>
                    <input type="number" min={1} className="input-hud mt-1" value={q.marks} onChange={e => updateQuestion(q.id, "marks", Number(e.target.value))} />
                  </div>
                </div>

                {q.type === "mcq" && (
                  <div className="mt-4 space-y-2 bg-elevated/20 p-3 rounded-lg border border-violet/15">
                    <label className="label-mono text-xs">Multiple Choice Options</label>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {[0, 1, 2, 3].map((optIdx) => {
                        const letters = ["A", "B", "C", "D"];
                        const optVal = (q.options || [])[optIdx] || "";
                        return (
                          <div key={optIdx} className="flex items-center gap-2">
                            <span className="font-mono text-cyan font-bold">{letters[optIdx]}</span>
                            <input
                              type="text"
                              className="input-hud"
                              placeholder={`Option ${letters[optIdx]}`}
                              value={optVal}
                              onChange={e => {
                                const newOpts = [...(q.options || ["", "", "", ""])];
                                newOpts[optIdx] = e.target.value;
                                updateQuestion(q.id, "options", newOpts);
                              }}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="mt-4">
                  <label className="label-mono">
                    {q.type === "mcq" ? "Select Correct Option (Model Answer)" : "Model Answer (For Auto-Grading)"}
                  </label>
                  {q.type === "mcq" ? (
                    <select
                      className="input-hud mt-1"
                      value={form.model_answers[q.id] || ""}
                      onChange={e => updateModelAnswer(q.id, e.target.value)}
                    >
                      <option value="">-- Choose Correct Option --</option>
                      <option value="A">Option A</option>
                      <option value="B">Option B</option>
                      <option value="C">Option C</option>
                      <option value="D">Option D</option>
                    </select>
                  ) : (
                    <textarea className="input-hud mt-1 min-h-[60px]" value={form.model_answers[q.id] || ""} onChange={e => updateModelAnswer(q.id, e.target.value)} placeholder="Provide the key points expected in the answer..." />
                  )}
                </div>
              </div>
            ))}
            <button onClick={addQuestion} className="btn-ghost-cyan rounded-xl w-full py-4 border-dashed border-2 flex items-center justify-center gap-2 mt-4 hover:bg-cyan/10">
              <Plus size={18} /> Add Question
            </button>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-5">
            <h2 className="font-display text-2xl">Step 4 — Whitelist</h2>
            <ListEditor label="Allowed URLs" items={form.whitelisted_urls}
              onChange={v => upd("whitelisted_urls", v)}
              placeholder="docs.python.org" testid="urls" />
            <ListEditor label="Allowed Applications" items={form.whitelisted_apps}
              onChange={v => upd("whitelisted_apps", v)}
              placeholder="Calculator" testid="apps" />
            <div className="text-xs text-white/50 font-mono pt-2">
              Anything outside this whitelist will instantly lock the candidate's exam.
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-5">
            <h2 className="font-display text-2xl">Step 5 — Launch</h2>
            <p className="text-white/60 text-sm">
              Review and launch. A unique session code (hashed) will be generated for candidates.
            </p>
            {form.quiz_mode && (
              <div className="glass rounded-lg p-4 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="label-mono">Module Code</label>
                    <input className="input-hud mt-1" value={form.module_code} onChange={e => upd("module_code", e.target.value.toUpperCase())} placeholder="EE5206" />
                  </div>
                  <div>
                    <label className="label-mono">Publish Prompt</label>
                    <label className="flex items-center gap-2 text-sm mt-1">
                      <input type="checkbox" checked={form.published} onChange={e => upd("published", e.target.checked)} className="accent-cyan w-4 h-4" />
                      Make this quiz available for module join prompts
                    </label>
                  </div>
                </div>
                <div>
                  <label className="label-mono">Prompt Title</label>
                  <input className="input-hud mt-1" value={form.quiz_prompt_title} onChange={e => upd("quiz_prompt_title", e.target.value)} placeholder="Short quiz available now" />
                </div>
                <div>
                  <label className="label-mono">Prompt Body</label>
                  <textarea className="input-hud mt-1 min-h-[70px]" value={form.quiz_prompt_body} onChange={e => upd("quiz_prompt_body", e.target.value)} placeholder="Students in this module can join the quick assessment." />
                </div>
              </div>
            )}
            <div className="glass rounded-lg p-4 grid grid-cols-2 gap-3 font-mono text-sm">
              <div><span className="label-mono">EXAM</span><div>{form.exam_name}</div></div>
              <div><span className="label-mono">CODE</span><div>{form.exam_code}</div></div>
              <div><span className="label-mono">DURATION</span><div>{form.duration_minutes}m</div></div>
              <div><span className="label-mono">QUESTIONS</span><div>{form.questions.length}</div></div>
              <div><span className="label-mono">URLS</span><div>{form.whitelisted_urls.length}</div></div>
              <div><span className="label-mono">APPS</span><div>{form.whitelisted_apps.length}</div></div>
            </div>
            {created && (
              <div className="glass glass-violet rounded-lg p-5 text-center" data-testid="session-launched">
                <div className="label-mono text-online">SESSION LAUNCHED</div>
                <div className="font-display text-3xl text-cyan mt-2 tracking-widest" data-testid="session-code-display">
                  {created.session_code}
                </div>
                <div className="text-xs text-white/60 mt-2">Share this code with candidates to join.</div>
                <button data-testid="goto-dashboard-btn" onClick={() => nav(`/sessions/${created.id}/dashboard`)}
                  className="btn-cyan rounded-lg px-5 py-2.5 mt-4 inline-flex items-center gap-2">
                  Open Live Dashboard <ArrowRight size={16} />
                </button>
              </div>
            )}
          </div>
        )}

        {!created && (
          <div className="flex justify-between mt-8">
            <button data-testid="wizard-back-btn" onClick={back} disabled={step === 0}
              className="btn-ghost-violet rounded-full px-5 py-2 flex items-center gap-2 disabled:opacity-30">
              <ArrowLeft size={16} /> Back
            </button>
            {step < 4 ? (
              <button data-testid="wizard-next-btn" onClick={next}
                disabled={step === 0 && (!form.exam_name || !form.exam_code)}
                className="btn-cyan rounded-full px-6 py-2 flex items-center gap-2 disabled:opacity-50">
                Next Step <ArrowRight size={16} />
              </button>
            ) : (
              <button data-testid="wizard-launch-btn" onClick={launch} disabled={submitting}
                className="btn-cyan rounded-full px-6 py-2 flex items-center gap-2">
                <Rocket size={16} /> {submitting ? "Launching..." : "Launch Session"}
              </button>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}

function ListEditor({ label, items, onChange, placeholder, testid }) {
  const [val, setVal] = useState("");
  return (
    <div>
      <label className="label-mono">{label}</label>
      <div className="flex gap-2 mt-1">
        <input data-testid={`${testid}-input`} className="input-hud" placeholder={placeholder}
          value={val} onChange={e => setVal(e.target.value)} />
        <button data-testid={`${testid}-add-btn`} onClick={() => { if (val) { onChange([...items, val]); setVal(""); } }}
          className="btn-ghost-cyan rounded-md px-3"><Plus size={16} /></button>
      </div>
      <div className="flex flex-wrap gap-2 mt-3">
        {items.map((it, i) => (
          <span key={i} className="glass rounded-full pl-3 pr-2 py-1 text-xs flex items-center gap-2 font-mono">
            {it}
            <button onClick={() => onChange(items.filter((_, j) => j !== i))}
              data-testid={`${testid}-remove-${i}`} className="text-violation hover:scale-110">
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

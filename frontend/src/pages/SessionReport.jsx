import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import AppShell from "../components/AppShell";
import { api } from "../lib/api";
import { Brain, Download, AlertTriangle, Trophy } from "lucide-react";
import { toast } from "sonner";

export default function SessionReport() {
  const { sid } = useParams();
  const [report, setReport] = useState(null);
  const [grading, setGrading] = useState(false);

  // Override / Final Evaluation state
  const [editingGrade, setEditingGrade] = useState(null);
  const [overrideScore, setOverrideScore] = useState(0);
  const [overrideComment, setOverrideComment] = useState("");
  const [submittingOverride, setSubmittingOverride] = useState(false);
  
  // View submission state
  const [viewingAnswers, setViewingAnswers] = useState(null);

  const load = async () => {
    const { data } = await api.get(`/sessions/${sid}/report`);
    setReport(data);
  };
  useEffect(() => { load(); }, [sid]);

  const grade = async () => {
    setGrading(true);
    try {
      const { data } = await api.post(`/sessions/${sid}/grade`);
      toast.success(`Graded ${data.graded} submissions`);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Grading failed");
    } finally { setGrading(false); }
  };

  const submitOverride = async () => {
    if (!editingGrade) return;
    setSubmittingOverride(true);
    try {
      await api.put(`/sessions/${sid}/grade/${editingGrade.candidate_id}`, {
        total: overrideScore,
        invigilator_comment: overrideComment
      });
      toast.success("Final evaluation saved");
      setEditingGrade(null);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Override failed");
    } finally {
      setSubmittingOverride(false);
    }
  };

  const downloadCsv = () => {
    if (!report) return;
    const rows = [["student_id","name","status","violations","total","max"]];
    report.rows.forEach(r => rows.push([
      r.student_id, r.full_name, r.status, r.violations,
      r.grade?.total ?? "", r.grade?.max_total ?? "",
    ]));
    const csv = rows.map(r => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `${report.session.exam_code}-report.csv`; a.click();
  };

  if (!report) return <AppShell title="Report"><div className="text-white/60">Loading…</div></AppShell>;

  return (
    <AppShell title={`Report — ${report.session.exam_name}`} breadcrumb={`Sessions / Reports`}>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Stat label="Candidates" value={report.totals.candidates} color="#00E5FF" />
        <Stat label="Finished" value={report.totals.finished} color="#39FF88" />
        <Stat label="Violations" value={report.totals.violations} color="#FF3D71" />
      </div>

      <div className="flex gap-3 mb-6">
        <button data-testid="run-grading-btn" onClick={grade} disabled={grading}
          className="btn-cyan rounded-full px-5 py-2.5 flex items-center gap-2">
          <Brain size={16}/> {grading ? "Grading with Claude..." : "Run AI Grading"}
        </button>
        <button data-testid="download-csv-btn" onClick={downloadCsv}
          className="btn-ghost-cyan rounded-full px-5 py-2.5 flex items-center gap-2">
          <Download size={16}/> Export CSV
        </button>
      </div>

      <div className="glass rounded-xl overflow-hidden" data-testid="report-table">
        <table className="w-full text-sm">
          <thead className="bg-elevated/60">
            <tr className="text-left label-mono">
              <th className="p-3">Student</th>
              <th className="p-3">Status</th>
              <th className="p-3">Violations</th>
              <th className="p-3">Score</th>
              <th className="p-3">Submission</th>
              <th className="p-3">Feedback</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map(r => (
              <tr key={r.candidate_id} className="border-t border-cyan/10" data-testid={`row-${r.candidate_id}`}>
                <td className="p-3">
                  <div>{r.full_name}</div>
                  <div className="font-mono text-xs text-white/50">{r.student_id}</div>
                </td>
                <td className="p-3 font-mono text-xs">{r.status.toUpperCase()}</td>
                <td className="p-3">
                  {r.violations > 0 ? (
                    <span className="text-violation flex items-center gap-1"><AlertTriangle size={12}/> {r.violations}</span>
                  ) : <span className="text-online">0</span>}
                </td>
                <td className="p-3 font-mono text-xs">
                  {r.grade ? (
                    <div>
                      <span className="text-cyan flex items-center gap-1 font-semibold">
                        <Trophy size={12}/> {r.grade.total}/{r.grade.max_total}
                      </span>
                      {r.grade.is_override && (
                        <span className="text-[10px] text-violet font-semibold tracking-wider block mt-0.5">OVERRIDDEN</span>
                      )}
                      <button
                        onClick={() => {
                          setEditingGrade(r);
                          setOverrideScore(r.grade.total);
                          setOverrideComment(r.grade.invigilator_comment || "");
                        }}
                        className="text-white/40 hover:text-cyan transition-colors underline block mt-1"
                        data-testid={`edit-grade-${r.candidate_id}`}
                      >
                        Override
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        setEditingGrade(r);
                        setOverrideScore(0);
                        setOverrideComment("");
                      }}
                      className="text-white/40 hover:text-cyan transition-colors underline"
                      data-testid={`edit-grade-${r.candidate_id}`}
                    >
                      Assign Score
                    </button>
                  )}
                </td>
                <td className="p-3">
                  <button
                    onClick={() => setViewingAnswers(r)}
                    className="btn-ghost-cyan rounded px-3 py-1 text-xs"
                    data-testid={`view-answers-${r.candidate_id}`}
                  >
                    View
                  </button>
                </td>
                <td className="p-3 text-xs text-white/70 max-w-md">
                  {r.grade?.invigilator_comment && (
                    <div className="mb-2 p-2 bg-violet/15 border border-violet/20 rounded text-violet-300">
                      <strong className="text-violet">Invigilator Evaluation:</strong> {r.grade.invigilator_comment}
                    </div>
                  )}
                  {r.grade?.per_question && Object.entries(r.grade.per_question).map(([q, v]) => (
                    <div key={q}><span className="font-mono text-cyan">{q}:</span> {v.feedback}</div>
                  ))}
                </td>
              </tr>
            ))}
            {report.rows.length === 0 && (
              <tr><td colSpan="6" className="p-6 text-center text-white/40">No candidates yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {editingGrade && (
        <div className="fixed inset-0 bg-void/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="glass glass-violet rounded-2xl max-w-md w-full p-6 space-y-4">
            <h3 className="font-display text-xl text-white">Final Evaluation</h3>
            <p className="text-sm text-white/70">
              Manually evaluate and override the final grade for <strong className="text-cyan">{editingGrade.full_name}</strong>.
            </p>
            <div className="space-y-1">
              <label className="label-mono text-xs">Original / AI Grade</label>
              <div className="text-sm font-mono text-white/50 bg-void/30 px-3 py-1.5 rounded border border-white/5">
                {editingGrade.grade ? `${editingGrade.grade.total} / ${editingGrade.grade.max_total}` : "Not Graded"}
              </div>
            </div>
            <div className="space-y-1">
              <label className="label-mono text-xs">Override Score (Max {editingGrade.grade?.max_total ?? 20})</label>
              <input
                type="number"
                min={0}
                max={editingGrade.grade?.max_total ?? 20}
                step={0.5}
                className="input-hud"
                value={overrideScore}
                onChange={e => setOverrideScore(Number(e.target.value))}
                data-testid="override-score-input"
              />
            </div>
            <div className="space-y-1">
              <label className="label-mono text-xs">Invigilator Comments / Feedback</label>
              <textarea
                className="input-hud min-h-[100px]"
                placeholder="Enter final evaluation comment..."
                value={overrideComment}
                onChange={e => setOverrideComment(e.target.value)}
                data-testid="override-comment-input"
              />
            </div>
            <div className="flex gap-3 justify-end pt-2">
              <button
                onClick={() => setEditingGrade(null)}
                className="btn-ghost-violet rounded-lg px-4 py-2 text-sm"
                data-testid="cancel-override-btn"
              >
                Cancel
              </button>
              <button
                onClick={submitOverride}
                disabled={submittingOverride}
                className="btn-cyan rounded-lg px-4 py-2 text-sm"
                data-testid="submit-override-btn"
              >
                {submittingOverride ? "Saving..." : "Save Override"}
              </button>
            </div>
          </div>
        </div>
      )}

      {viewingAnswers && (
        <div className="fixed inset-0 bg-void/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="glass rounded-2xl max-w-2xl w-full p-6 max-h-[80vh] flex flex-col">
            <h3 className="font-display text-xl text-white mb-2">Submission: {viewingAnswers.full_name}</h3>
            <div className="overflow-y-auto flex-1 space-y-4 pr-2">
              {report.session.questions?.map((q, i) => (
                <div key={q.id} className="bg-elevated/50 rounded-lg p-4 border border-cyan/10">
                  <div className="font-mono text-xs text-cyan mb-1">Q{i+1}: {q.text}</div>
                  <div className="text-sm mt-2">
                    <span className="text-white/40 font-mono text-xs">ANSWER:</span>
                    <div className="bg-void/50 p-2 rounded mt-1 font-mono text-white/80">{viewingAnswers.answers?.[q.id] || "No answer"}</div>
                  </div>
                  {viewingAnswers.grade?.per_question?.[q.id] && (
                    <div className="text-xs mt-3 bg-violet/10 p-2 rounded border border-violet/20">
                      <span className="text-violet font-semibold">AI Feedback:</span> {viewingAnswers.grade.per_question[q.id].feedback}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="flex justify-end pt-4 mt-2 border-t border-cyan/10">
              <button
                onClick={() => setViewingAnswers(null)}
                className="btn-cyan rounded-lg px-6 py-2 text-sm"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}

const Stat = ({ label, value, color }) => (
  <div className="glass rounded-xl p-4">
    <div className="label-mono">{label}</div>
    <div className="font-mono text-3xl mt-1" style={{ color }}>{value}</div>
  </div>
);

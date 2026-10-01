import React, { useCallback, useEffect, useState, useMemo } from "react";
import { useParams } from "react-router-dom";
import AppShell from "../components/AppShell";
import { api } from "../lib/api";
import { Brain, Download, AlertTriangle, Trophy, Search, Filter, ArrowUpDown, CheckCircle, XCircle, BarChart3, TrendingUp, Users, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

const GRADING_METHOD_LABELS = {
  emergent: "AI (Anthropic via Emergent)",
  anthropic: "AI (Anthropic)",
  openai: "AI (OpenAI)",
  gemini: "AI (Gemini)",
  mcq_exact: "Exact match",
  vector_fallback: "Fallback (no LLM key configured)",
  empty_answer: "No answer",
};

const WEAK_GRADING_METHODS = new Set(["vector_fallback", "empty_answer"]);

function GradingMethodBadge({ method }) {
  if (!method) return null;
  const label = GRADING_METHOD_LABELS[method] || method;
  const weak = WEAK_GRADING_METHODS.has(method);
  return (
    <span
      className={`font-mono text-[10px] uppercase px-1.5 py-0.5 rounded ${weak ? "bg-amber-500/20 text-amber-300" : "bg-cyan/15 text-cyan"}`}
      title={weak ? "Configure an LLM key in backend/.env for real AI grading." : undefined}
    >
      {label}
    </span>
  );
}

export default function SessionReport() {
  const { sid } = useParams();
  const [report, setReport] = useState(null);
  const [grading, setGrading] = useState(false);

  // Search & Filter & Sort state
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortField, setSortField] = useState("score");
  const [sortOrder, setSortOrder] = useState("desc");

  // Override / Final Evaluation state
  const [editingGrade, setEditingGrade] = useState(null);
  const [overrideScore, setOverrideScore] = useState(0);
  const [overrideComment, setOverrideComment] = useState("");
  const [submittingOverride, setSubmittingOverride] = useState(false);
  
  // View submission state
  const [viewingAnswers, setViewingAnswers] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get(`/sessions/${sid}/report`);
      setReport(data);
    } catch (e) {
      toast.error("Failed to load session report");
    }
  }, [sid]);

  useEffect(() => { load(); }, [load]);

  const grade = async () => {
    setGrading(true);
    try {
      const { data } = await api.post(`/sessions/${sid}/grade`);
      toast.success(`AI Grading completed: ${data.graded} submissions processed`);
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
    const rows = [["student_id","name","status","violations","score","max_score","percentage","grade_letter","pass_fail","override_comment"]];
    filteredRows.forEach(r => {
      const total = r.grade?.total ?? 0;
      const max = r.grade?.max_total ?? 100;
      const pct = max > 0 ? ((total / max) * 100).toFixed(1) : "0.0";
      const passFail = Number(pct) >= 50 ? "PASS" : "FAIL";
      let gradeLetter = "N/A";
      if (r.grade) {
        if (Number(pct) >= 90) gradeLetter = "A";
        else if (Number(pct) >= 80) gradeLetter = "B";
        else if (Number(pct) >= 70) gradeLetter = "C";
        else if (Number(pct) >= 60) gradeLetter = "D";
        else gradeLetter = "F";
      }
      rows.push([
        r.student_id,
        `"${r.full_name.replace(/"/g, '""')}"`,
        r.status,
        r.violations,
        total,
        max,
        `${pct}%`,
        gradeLetter,
        passFail,
        `"${(r.grade?.invigilator_comment || "").replace(/"/g, '""')}"`
      ]);
    });
    const csv = rows.map(r => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${report.session.exam_code}-statistical-report.csv`;
    a.click();
  };

  // Filtered and Sorted Rows
  const filteredRows = useMemo(() => {
    if (!report?.rows) return [];
    return report.rows
      .filter((r) => {
        const matchesSearch =
          r.full_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          r.student_id.toLowerCase().includes(searchTerm.toLowerCase());

        if (!matchesSearch) return false;

        if (statusFilter === "passed") {
          const pct = r.grade ? (r.grade.total / (r.grade.max_total || 100)) * 100 : 0;
          return r.grade && pct >= 50;
        }
        if (statusFilter === "failed") {
          const pct = r.grade ? (r.grade.total / (r.grade.max_total || 100)) * 100 : 0;
          return r.grade && pct < 50;
        }
        if (statusFilter === "violations") {
          return r.violations > 0;
        }
        if (statusFilter === "finished") {
          return r.status === "finished";
        }
        return true;
      })
      .sort((a, b) => {
        let valA = 0;
        let valB = 0;
        if (sortField === "name") {
          return sortOrder === "asc"
            ? a.full_name.localeCompare(b.full_name)
            : b.full_name.localeCompare(a.full_name);
        }
        if (sortField === "violations") {
          valA = a.violations;
          valB = b.violations;
        } else if (sortField === "score") {
          valA = a.grade?.total ?? -1;
          valB = b.grade?.total ?? -1;
        } else if (sortField === "pct") {
          valA = a.grade ? (a.grade.total / (a.grade.max_total || 100)) * 100 : -1;
          valB = b.grade ? (b.grade.total / (b.grade.max_total || 100)) * 100 : -1;
        }
        return sortOrder === "asc" ? valA - valB : valB - valA;
      });
  }, [report, searchTerm, statusFilter, sortField, sortOrder]);

  const toggleSort = (field) => {
    if (sortField === field) {
      setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortOrder("desc");
    }
  };

  if (!report) return <AppShell title="Report"><div className="text-white/60 p-6">Loading statistical analysis…</div></AppShell>;

  const stats = report.stats || {
    total_graded: report.rows.filter(r => r.grade).length,
    mean_score: 0,
    median_score: 0,
    min_score: 0,
    max_score: 0,
    std_dev: 0,
    pass_rate: 0,
    grade_distribution: { A: 0, B: 0, C: 0, D: 0, F: 0 },
  };

  const dist = stats.grade_distribution || { A: 0, B: 0, C: 0, D: 0, F: 0 };
  const totalGraded = stats.total_graded || 1;

  return (
    <AppShell title={`Statistical Analytics — ${report.session.exam_name}`} breadcrumb={`Sessions / Statistical Report`}>
      {/* Upper Action Bar */}
      <div className="flex items-center justify-between flex-wrap gap-4 mb-6">
        <div>
          <h1 className="font-display text-2xl text-white flex items-center gap-2">
            <BarChart3 className="text-cyan" size={24} /> Invigilator Statistical Overview
          </h1>
          <p className="text-xs font-mono text-white/50 mt-1">
            Exam Code: {report.session.exam_code} • Duration: {report.session.duration_minutes}m • Candidates: {report.totals.candidates}
          </p>
        </div>
        <div className="flex gap-3">
          <button
            data-testid="run-grading-btn"
            onClick={grade}
            disabled={grading}
            className="btn-cyan rounded-full px-5 py-2.5 flex items-center gap-2 text-sm font-semibold"
          >
            <Brain size={16}/> {grading ? "Grading with AI Engine..." : "Run AI Grading"}
          </button>
          <button
            data-testid="download-csv-btn"
            onClick={downloadCsv}
            className="btn-ghost-cyan rounded-full px-5 py-2.5 flex items-center gap-2 text-sm font-semibold"
          >
            <Download size={16}/> Export Full CSV
          </button>
        </div>
      </div>

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
        <KpiCard label="Candidates" value={report.totals.candidates} sub={`${report.totals.finished} Completed`} icon={Users} color="#00E5FF" />
        <KpiCard label="Mean Score" value={stats.mean_score} sub="Average total" icon={TrendingUp} color="#39FF88" />
        <KpiCard label="Median Score" value={stats.median_score} sub="50th percentile" icon={BarChart3} color="#9D00FF" />
        <KpiCard label="Pass Rate" value={`${stats.pass_rate}%`} sub="Score >= 50%" icon={CheckCircle} color={stats.pass_rate >= 70 ? "#39FF88" : "#FF9F43"} />
        <KpiCard label="Std Deviation" value={stats.std_dev} sub="Score variance" icon={ArrowUpDown} color="#00E5FF" />
        <KpiCard label="Violations" value={report.totals.violations} sub="Security alerts" icon={ShieldAlert} color="#FF3D71" />
      </div>

      {/* Grade Distribution Breakdown Bar */}
      <div className="glass rounded-xl p-5 mb-6 border border-cyan/20">
        <div className="flex items-center justify-between mb-3">
          <div className="label-mono text-cyan flex items-center gap-2">
            <Trophy size={14} /> GRADE DISTRIBUTION HISTOGRAM
          </div>
          <div className="text-xs font-mono text-white/50">
            Total Graded: {stats.total_graded}
          </div>
        </div>
        <div className="grid grid-cols-5 gap-2 text-center">
          <GradePill grade="A" range="90-100%" count={dist.A} total={totalGraded} color="bg-emerald-500/20 text-emerald-400 border-emerald-500/40" />
          <GradePill grade="B" range="80-89%" count={dist.B} total={totalGraded} color="bg-cyan-500/20 text-cyan-300 border-cyan-500/40" />
          <GradePill grade="C" range="70-79%" count={dist.C} total={totalGraded} color="bg-violet-500/20 text-violet-300 border-violet-500/40" />
          <GradePill grade="D" range="60-69%" count={dist.D} total={totalGraded} color="bg-amber-500/20 text-amber-300 border-amber-500/40" />
          <GradePill grade="F" range="< 60%" count={dist.F} total={totalGraded} color="bg-rose-500/20 text-rose-400 border-rose-500/40" />
        </div>
      </div>

      {/* Search, Filter & Controls Bar */}
      <div className="glass rounded-xl p-4 mb-4 flex items-center justify-between flex-wrap gap-4">
        <div className="relative flex-1 min-w-[240px]">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
          <input
            type="text"
            placeholder="Search candidate name or ID..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="input-hud pl-9 py-2 text-sm"
          />
        </div>
        <div className="flex items-center gap-2">
          <Filter size={16} className="text-cyan" />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="bg-elevated border border-cyan/20 rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-cyan"
          >
            <option value="all">All Students ({report.rows.length})</option>
            <option value="finished">Finished Only</option>
            <option value="passed">{"Passed (>= 50%)"}</option>
            <option value="failed">{"Failed (< 50%)"}</option>
            <option value="violations">Has Violations</option>
          </select>
        </div>
      </div>

      {/* Main Student Marks Table */}
      <div className="glass rounded-xl overflow-hidden" data-testid="report-table">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-elevated/80 border-b border-cyan/20">
              <tr className="text-left label-mono text-xs text-cyan">
                <th className="p-3 cursor-pointer hover:text-white transition-colors" onClick={() => toggleSort("name")}>
                  <div className="flex items-center gap-1">Student <ArrowUpDown size={12}/></div>
                </th>
                <th className="p-3">Status</th>
                <th className="p-3 cursor-pointer hover:text-white transition-colors" onClick={() => toggleSort("violations")}>
                  <div className="flex items-center gap-1">Violations <ArrowUpDown size={12}/></div>
                </th>
                <th className="p-3 cursor-pointer hover:text-white transition-colors" onClick={() => toggleSort("score")}>
                  <div className="flex items-center gap-1">Score / Max <ArrowUpDown size={12}/></div>
                </th>
                <th className="p-3 cursor-pointer hover:text-white transition-colors" onClick={() => toggleSort("pct")}>
                  <div className="flex items-center gap-1">% & Grade <ArrowUpDown size={12}/></div>
                </th>
                <th className="p-3">Pass/Fail</th>
                <th className="p-3">Submission</th>
                <th className="p-3">Feedback & Notes</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r) => {
                const total = r.grade?.total ?? 0;
                const max = r.grade?.max_total ?? 100;
                const pct = max > 0 ? ((total / max) * 100).toFixed(1) : "0.0";
                const isPass = Number(pct) >= 50;
                let letter = "N/A";
                if (r.grade) {
                  if (Number(pct) >= 90) letter = "A";
                  else if (Number(pct) >= 80) letter = "B";
                  else if (Number(pct) >= 70) letter = "C";
                  else if (Number(pct) >= 60) letter = "D";
                  else letter = "F";
                }

                return (
                  <tr key={r.candidate_id} className="border-t border-cyan/10 hover:bg-cyan/5 transition-colors" data-testid={`row-${r.candidate_id}`}>
                    <td className="p-3">
                      <div className="font-semibold text-white">{r.full_name}</div>
                      <div className="font-mono text-xs text-white/50">{r.student_id}</div>
                    </td>
                    <td className="p-3 font-mono text-xs">
                      <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                        r.status === "finished" ? "bg-online/20 text-online border border-online/30" :
                        r.status === "locked" ? "bg-violation/20 text-violation border border-violation/30" :
                        "bg-white/10 text-white/70"
                      }`}>
                        {r.status.toUpperCase()}
                      </span>
                    </td>
                    <td className="p-3">
                      {r.violations > 0 ? (
                        <span className="text-violation font-mono font-bold flex items-center gap-1">
                          <AlertTriangle size={13}/> {r.violations}
                        </span>
                      ) : (
                        <span className="text-online font-mono text-xs">0</span>
                      )}
                    </td>
                    <td className="p-3 font-mono text-xs">
                      {r.grade ? (
                        <div>
                          <span className="text-cyan font-bold text-sm">
                            {r.grade.total} / {r.grade.max_total}
                          </span>
                          {r.grade.is_override && (
                            <span className="text-[10px] text-violet font-semibold block tracking-wider mt-0.5">OVERRIDDEN</span>
                          )}
                          <button
                            onClick={() => {
                              setEditingGrade(r);
                              setOverrideScore(r.grade.total);
                              setOverrideComment(r.grade.invigilator_comment || "");
                            }}
                            className="text-white/40 hover:text-cyan transition-colors underline block mt-1 text-[11px]"
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
                          className="text-white/40 hover:text-cyan transition-colors underline text-xs"
                          data-testid={`edit-grade-${r.candidate_id}`}
                        >
                          Assign Score
                        </button>
                      )}
                    </td>
                    <td className="p-3 font-mono">
                      {r.grade ? (
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold">{pct}%</span>
                          <span className="px-2 py-0.5 rounded text-xs font-bold bg-violet/30 text-cyan border border-cyan/30">
                            {letter}
                          </span>
                        </div>
                      ) : (
                        <span className="text-white/30 text-xs">—</span>
                      )}
                    </td>
                    <td className="p-3">
                      {r.grade ? (
                        isPass ? (
                          <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-400 bg-emerald-500/10 px-2 py-1 rounded border border-emerald-500/30">
                            <CheckCircle size={12} /> PASS
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs font-bold text-rose-400 bg-rose-500/10 px-2 py-1 rounded border border-rose-500/30">
                            <XCircle size={12} /> FAIL
                          </span>
                        )
                      ) : (
                        <span className="text-white/30 text-xs">Pending</span>
                      )}
                    </td>
                    <td className="p-3">
                      <button
                        onClick={() => setViewingAnswers(r)}
                        className="btn-ghost-cyan rounded px-3 py-1 text-xs font-mono"
                        data-testid={`view-answers-${r.candidate_id}`}
                      >
                        View Answers
                      </button>
                    </td>
                    <td className="p-3 text-xs text-white/70 max-w-sm">
                      {r.grade?.invigilator_comment && (
                        <div className="mb-2 p-2 bg-violet/15 border border-violet/30 rounded text-violet-200">
                          <strong className="text-violet">Invigilator Note:</strong> {r.grade.invigilator_comment}
                        </div>
                      )}
                      {r.grade?.per_question && Object.entries(r.grade.per_question).map(([q, v]) => (
                        <div key={q} className="truncate"><span className="font-mono text-cyan">{q}:</span> {v.feedback}</div>
                      ))}
                    </td>
                  </tr>
                );
              })}
              {filteredRows.length === 0 && (
                <tr>
                  <td colSpan="8" className="p-8 text-center text-white/40">
                    No student records match the search or filter criteria.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Override Grade Modal */}
      {editingGrade && (
        <div className="fixed inset-0 bg-void/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="glass glass-violet rounded-2xl max-w-md w-full p-6 space-y-4">
            <h3 className="font-display text-xl text-white">Final Evaluation Override</h3>
            <p className="text-sm text-white/70">
              Manually evaluate and override the score for <strong className="text-cyan">{editingGrade.full_name}</strong>.
            </p>
            <div className="space-y-1">
              <label className="label-mono text-xs">Original Score</label>
              <div className="text-sm font-mono text-white/50 bg-void/30 px-3 py-1.5 rounded border border-white/5">
                {editingGrade.grade ? `${editingGrade.grade.total} / ${editingGrade.grade.max_total}` : "Not Graded"}
              </div>
            </div>
            <div className="space-y-1">
              <label className="label-mono text-xs">Override Score (Max {editingGrade.grade?.max_total ?? 100})</label>
              <input
                type="number"
                min={0}
                max={editingGrade.grade?.max_total ?? 100}
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
                placeholder="Enter final evaluation note..."
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
                {submittingOverride ? "Saving..." : "Save Evaluation"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Viewing Answers Modal */}
      {viewingAnswers && (
        <div className="fixed inset-0 bg-void/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="glass rounded-2xl max-w-2xl w-full p-6 max-h-[80vh] flex flex-col">
            <h3 className="font-display text-xl text-white mb-2">Submission: {viewingAnswers.full_name}</h3>
            <div className="overflow-y-auto flex-1 space-y-4 pr-2">
              {report.session.questions?.map((q, i) => (
                <div key={q.id} className="bg-elevated/50 rounded-lg p-4 border border-cyan/10">
                  <div className="font-mono text-xs text-cyan mb-1">Q{i+1}: {q.text}</div>
                  <div className="text-sm mt-2">
                    <span className="text-white/40 font-mono text-xs">STUDENT ANSWER:</span>
                    <div className="bg-void/50 p-2 rounded mt-1 font-mono text-white/80">{viewingAnswers.answers?.[q.id] || "No response provided"}</div>
                  </div>
                  {viewingAnswers.grade?.per_question?.[q.id] && (
                    <div className="text-xs mt-3 bg-violet/10 p-2.5 rounded border border-violet/20">
                      <div className="flex items-center justify-between text-violet font-semibold mb-1">
                        <span>AI Score: {viewingAnswers.grade.per_question[q.id].score} / {viewingAnswers.grade.per_question[q.id].max}</span>
                        <GradingMethodBadge method={viewingAnswers.grade.per_question[q.id].method} />
                      </div>
                      <div className="text-white/80">{viewingAnswers.grade.per_question[q.id].feedback}</div>
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

const KpiCard = ({ label, value, sub, icon: Icon, color }) => (
  <div className="glass rounded-xl p-3.5 border border-cyan/10">
    <div className="flex items-center justify-between">
      <div className="label-mono text-[10px] text-white/60">{label}</div>
      <Icon size={16} style={{ color }} />
    </div>
    <div className="font-mono text-2xl font-bold mt-1" style={{ color }}>{value}</div>
    <div className="text-[10px] font-mono text-white/40 mt-0.5">{sub}</div>
  </div>
);

const GradePill = ({ grade, range, count, total, color }) => {
  const pct = Math.round((count / (total || 1)) * 100);
  return (
    <div className={`p-2.5 rounded-lg border ${color}`}>
      <div className="font-mono text-lg font-bold">{grade}</div>
      <div className="text-[10px] opacity-75">{range}</div>
      <div className="font-mono text-sm font-semibold mt-1">{count} ({pct}%)</div>
    </div>
  );
};

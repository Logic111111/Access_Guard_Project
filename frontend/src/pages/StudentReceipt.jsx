import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Logo } from "../components/Logo";
import { api } from "../lib/api";
import { Download, Check, Home } from "lucide-react";

export default function StudentReceipt() {
  const nav = useNavigate();
  const [receipt, setReceipt] = useState(null);
  const cid = sessionStorage.getItem("ag_candidate_id");

  useEffect(() => {
    if (!cid) { nav("/student"); return; }
    api.get(`/public/receipt/${cid}`).then(r => setReceipt(r.data));
  }, [cid, nav]);

  const download = () => {
    if (!receipt) return;
    const text = `
ACCESSGUARD — EXAM COMPLETION RECEIPT
=====================================

Student:        ${receipt.candidate.full_name}
Student ID:     ${receipt.candidate.student_id}
Candidate ID:   ${receipt.candidate.id}
Exam:           ${receipt.exam_name}
Exam Code:      ${receipt.exam_code}
Submitted:      ${receipt.submitted_at}
Answers:        ${receipt.answer_count}
Receipt ID:     ${receipt.receipt_id}

This receipt confirms that the above candidate completed the exam under
AccessGuard secure monitoring.

— AccessGuard System
`;
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `accessguard-receipt-${receipt.receipt_id}.txt`; a.click();
  };

  if (!receipt) return <div className="min-h-screen hud-bg flex items-center justify-center text-white/60">Loading…</div>;

  return (
    <div className="min-h-screen hud-bg hex-bg flex items-center justify-center p-6">
      <div className="glass rounded-2xl p-10 max-w-lg w-full text-center" data-testid="receipt-card">
        <div className="flex justify-center mb-4">
          <Logo size={48} showText={false} />
        </div>
        <div className="w-16 h-16 rounded-full bg-online/20 border-2 border-online mx-auto flex items-center justify-center neon-cyan animate-pulse-glow">
          <Check size={28} className="text-online"/>
        </div>
        <h1 className="font-display text-3xl text-cyan mt-6">Submission Complete</h1>
        <p className="text-white/60 mt-1 text-sm">Your answers have been securely recorded.</p>

        <div className="mt-6 glass rounded-lg p-5 text-left font-mono text-sm space-y-1.5">
          <Row k="STUDENT" v={receipt.candidate.full_name} />
          <Row k="ID" v={receipt.candidate.student_id} />
          <Row k="EXAM" v={receipt.exam_name} />
          <Row k="CODE" v={receipt.exam_code} />
          <Row k="ANSWERS" v={receipt.answer_count} />
          <Row k="RECEIPT" v={receipt.receipt_id?.slice(0,18)+"…"} />
          <Row k="TIME" v={new Date(receipt.submitted_at || Date.now()).toLocaleString()} />
        </div>

        <div className="flex gap-3 mt-6 justify-center">
          <button onClick={download} data-testid="download-receipt-btn"
            className="btn-cyan rounded-full px-5 py-2.5 flex items-center gap-2">
            <Download size={16}/> Download Receipt
          </button>
          <button onClick={() => nav("/student")} className="btn-ghost-cyan rounded-full px-5 py-2.5 flex items-center gap-2">
            <Home size={16}/> Home
          </button>
        </div>
      </div>
    </div>
  );
}

const Row = ({ k, v }) => (
  <div className="flex justify-between gap-6">
    <span className="text-white/50 label-mono">{k}</span>
    <span className="text-white truncate">{String(v)}</span>
  </div>
);

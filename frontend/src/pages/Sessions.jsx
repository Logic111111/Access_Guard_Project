import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import AppShell from "../components/AppShell";
import { api } from "../lib/api";
import { Plus, FolderOpen, Clock, Calendar, History, Sparkles } from "lucide-react";

export default function Sessions() {
  const nav = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get("/sessions").then(r => setRows(r.data)).finally(() => setLoading(false));
  }, []);

  const empty = !loading && rows.length === 0;
  const icons = [Clock, Calendar, History];

  return (
    <AppShell title="Sessions" breadcrumb="Home / Sessions">
      {!empty && (
        <div className="flex justify-between items-center mb-6">
          <p className="text-white/60 text-sm">Manage exam sessions and live monitoring.</p>
          <div className="flex gap-2">
            <button data-testid="quick-quiz-btn" onClick={() => nav("/sessions/new?mode=quiz")}
              className="btn-ghost-cyan rounded-full px-5 py-2.5 flex items-center gap-2">
              <Sparkles size={16} /> Distribute Quiz
            </button>
            <button data-testid="new-session-btn" onClick={() => nav("/sessions/new")}
              className="btn-cyan rounded-full px-5 py-2.5 flex items-center gap-2">
              <Plus size={16} /> Create New Session
            </button>
          </div>
        </div>
      )}

      {empty ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="relative mb-8">
            <div className="w-44 h-44 rounded-2xl glass glass-violet flex items-center justify-center neon-violet">
              <svg width="120" height="120" viewBox="0 0 120 120" fill="none">
                <rect x="30" y="20" width="60" height="20" rx="3" stroke="#B14CFF" strokeWidth="2" fill="rgba(0,229,255,0.08)"/>
                <rect x="30" y="50" width="60" height="20" rx="3" stroke="#00E5FF" strokeWidth="2" fill="rgba(177,76,255,0.05)"/>
                <rect x="30" y="80" width="60" height="20" rx="3" stroke="#B14CFF" strokeWidth="2" fill="rgba(0,229,255,0.08)"/>
                <circle cx="40" cy="30" r="2.5" fill="#00E5FF"/>
                <circle cx="40" cy="60" r="2.5" fill="#39FF88"/>
                <circle cx="40" cy="90" r="2.5" fill="#00E5FF"/>
              </svg>
            </div>
          </div>
          <h2 className="font-display text-3xl text-cyan mb-2">No Active Sessions</h2>
          <p className="text-white/60 text-sm max-w-sm">
            Start a new exam session to begin monitoring students in real-time.
          </p>
          <div className="flex gap-3 mt-6">
            <button data-testid="empty-create-btn" onClick={() => nav("/sessions/new")}
              className="btn-cyan rounded-full px-6 py-3 flex items-center gap-2">
              <Plus size={16} /> Create New Session
            </button>
            <button data-testid="empty-quiz-btn" onClick={() => nav("/sessions/new?mode=quiz")}
              className="btn-ghost-cyan rounded-full px-6 py-3 flex items-center gap-2">
              <Sparkles size={16} /> Distribute Quiz
            </button>
            <button className="btn-ghost-cyan rounded-full px-6 py-3 flex items-center gap-2" disabled>
              <FolderOpen size={16} /> Open Recent Session
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5" data-testid="sessions-grid">
          {rows.map((s, idx) => {
            const Icon = icons[idx % icons.length];
            const statusColor = s.status === "live" ? "text-online" : s.status === "ended" ? "text-white/40" : "text-cyan";
            return (
              <button key={s.id} onClick={() => nav(`/sessions/${s.id}/dashboard`)}
                data-testid={`session-card-${s.id}`}
                className="glass rounded-xl p-5 text-left hover:neon-cyan transition-all">
                <div className="flex items-center gap-2 label-mono">
                  <Icon size={12} /> {s.exam_code}
                </div>
                <div className="font-display text-lg mt-2">{s.exam_name}</div>
                <div className="font-mono text-xs text-white/60 mt-1">CODE {s.session_code}</div>
                <div className="flex items-center justify-between mt-4">
                  <span className={`label-mono ${statusColor}`}>● {s.status.toUpperCase()}</span>
                  <span className="text-xs text-white/40">{s.duration_minutes} min</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}

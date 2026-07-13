import React, { useEffect, useState, useMemo, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import AppShell from "../components/AppShell";
import Sparkline from "../components/Sparkline";
import { api, getToken, BACKEND_URL } from "../lib/api";
import { Activity, AlertTriangle, HeartPulse, ShieldCheck, Search, Check, X, Eye, FileText, Brain, StopCircle, PlayCircle, Wifi, WifiOff, UserX } from "lucide-react";
import { toast } from "sonner";

const resolveImg = (val) => {
  if (!val) return "";
  if (val.startsWith("data:") || val.startsWith("http")) return val;
  if (val.startsWith("/api/")) return `${BACKEND_URL}${val}`;
  return val;
};

const fmt = (s) => {
  if (!s) return "--:--:--";
  const d = new Date(s); return d.toLocaleTimeString();
};

export default function SessionDashboard() {
  const { sid } = useParams();
  const nav = useNavigate();
  const [session, setSession] = useState(null);
  const [cands, setCands] = useState([]);
  const [hbs, setHbs] = useState([]);
  const [vios, setVios] = useState([]);
  const [frames, setFrames] = useState({});
  const [search, setSearch] = useState("");
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef(null);

  const refresh = async () => {
    const [s, c, h, v, f] = await Promise.all([
      api.get(`/sessions/${sid}`),
      api.get(`/sessions/${sid}/candidates`),
      api.get(`/sessions/${sid}/heartbeats`),
      api.get(`/sessions/${sid}/violations`),
      api.get(`/sessions/${sid}/frames`),
    ]);
    setSession(s.data); setCands(c.data); setHbs(h.data); setVios(v.data); setFrames(f.data);
  };

  // Initial fetch + periodic safety refresh (every 30s) — WebSocket carries live deltas
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30000);
    return () => clearInterval(t);
  }, [sid]);

  // WebSocket live channel
  useEffect(() => {
    const tok = getToken();
    if (!tok) return;
    const wsUrl = BACKEND_URL.replace(/^http/, "ws") + `/api/ws/sessions/${sid}/live?token=${encodeURIComponent(tok)}`;
    let keepalive;
    const open = () => {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.onopen = () => {
        setWsConnected(true);
        keepalive = setInterval(() => { try { ws.send("ping"); } catch {} }, 25000);
      };
      ws.onmessage = (ev) => {
        let evt; try { evt = JSON.parse(ev.data); } catch { return; }
        if (evt.type === "frame") {
          setFrames(prev => ({ ...prev, [evt.candidate_id]: { image_b64: evt.image_b64, ts: evt.ts } }));
        } else if (evt.type === "candidate_joined") {
          setCands(prev => prev.find(c => c.id === evt.candidate.id) ? prev : [...prev, evt.candidate]);
        } else if (evt.type === "candidate_decision") {
          setCands(prev => prev.map(c => c.id === evt.candidate_id ? { ...c, status: evt.status } : c));
        } else if (evt.type === "violation") {
          setVios(prev => [{ id: evt.candidate_id + evt.ts, candidate_id: evt.candidate_id, kind: evt.kind, detail: evt.detail, ts: evt.ts }, ...prev]);
          if (evt.locked) {
            setCands(prev => prev.map(c => c.id === evt.candidate_id ? { ...c, status: "locked" } : c));
          }
        }
      };
      ws.onclose = () => {
        setWsConnected(false);
        clearInterval(keepalive);
        // auto-reconnect after 3s
        setTimeout(() => { if (wsRef.current === ws) open(); }, 3000);
      };
      ws.onerror = () => { try { ws.close(); } catch {} };
    };
    open();
    return () => {
      clearInterval(keepalive);
      const ws = wsRef.current;
      wsRef.current = null;
      try { ws && ws.close(); } catch {}
    };
  }, [sid]);

  const decide = async (cid, approve) => {
    try {
      await api.post(`/sessions/${sid}/candidates/decision`, { candidate_id: cid, approve });
      toast.success(approve ? "Approved" : "Rejected");
      refresh();
    } catch (e) { toast.error("Failed"); }
  };

  const kickCandidate = async (cid) => {
    if (!window.confirm("Are you sure you want to kick this student? This action cannot be undone.")) return;
    try {
      await api.post(`/sessions/${sid}/candidates/${cid}/kick`);
      toast.success("Student kicked");
      refresh();
    } catch (e) { toast.error("Failed to kick student"); }
  };

  const start = async () => { await api.post(`/sessions/${sid}/start`); toast.success("Session started"); refresh(); };
  const end = async () => { await api.post(`/sessions/${sid}/end`); toast.success("Session ended"); refresh(); };

  const filtered = useMemo(
    () => cands.filter(c =>
      !search ||
      c.full_name.toLowerCase().includes(search.toLowerCase()) ||
      c.student_id.toLowerCase().includes(search.toLowerCase())
    ),
    [cands, search]
  );

  const connected = cands.filter(c => c.status === "active" || c.status === "approved").length;
  const finishedN = cands.filter(c => c.status === "finished").length;
  const violSparkline = useMemo(() => {
    const buckets = Array(20).fill(0);
    vios.forEach((_, i) => { buckets[i % 20] += 1; });
    return buckets;
  }, [vios]);
  const hbSparkline = useMemo(() => hbs.slice(0, 20).map(h => h.latency_ms || 30).reverse(), [hbs]);

  if (!session) return <AppShell title="Loading..."><div className="text-white/60">Connecting…</div></AppShell>;

  return (
    <AppShell title={`${session.exam_name} — ${session.status.toUpperCase()}`} breadcrumb={`Sessions / ${session.exam_code}`}>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="glass rounded-lg px-4 py-2 font-mono text-cyan" data-testid="session-code-pill">
            CODE {session.session_code}
          </div>
          <div className={`glass rounded-lg px-3 py-2 font-mono text-xs flex items-center gap-1.5 ${wsConnected ? "text-online" : "text-warning"}`} data-testid="ws-status">
            {wsConnected ? <Wifi size={12}/> : <WifiOff size={12}/>}
            {wsConnected ? "REALTIME" : "POLLING"}
          </div>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
            <input className="input-hud pl-9" placeholder="Search students, ID..."
              value={search} onChange={e => setSearch(e.target.value)} data-testid="search-input" />
          </div>
        </div>
        <div className="flex gap-2">
          {session.status !== "live" && session.status !== "ended" && (
            <button data-testid="start-session-btn" onClick={start}
              className="btn-cyan rounded-full px-4 py-2 flex items-center gap-2"><PlayCircle size={16}/> Start</button>
          )}
          {session.status === "live" && (
            <button data-testid="end-session-btn" onClick={end}
              className="btn-ghost-violet rounded-full px-4 py-2 flex items-center gap-2"><StopCircle size={16}/> End Exam</button>
          )}
          <button data-testid="report-btn" onClick={() => nav(`/sessions/${sid}/report`)}
            className="btn-ghost-cyan rounded-full px-4 py-2 flex items-center gap-2"><FileText size={16}/> Report</button>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Kpi icon={Activity} label="Connected" value={`${connected} / ${session.max_students}`}
          spark={hbSparkline} color="#00E5FF" testid="kpi-connected"/>
        <Kpi icon={AlertTriangle} label="Violations" value={vios.length}
          spark={violSparkline} color="#B14CFF" testid="kpi-violations"/>
        <Kpi icon={HeartPulse} label="Avg Heartbeat"
          value={hbs.length ? `${(hbs.reduce((a,b)=>a+(b.latency_ms||0),0)/hbs.length).toFixed(0)}ms` : "—"}
          spark={hbSparkline} color="#39FF88" testid="kpi-heartbeat"/>
        <Kpi icon={ShieldCheck} label="Session Health"
          value={`${cands.length ? Math.max(0, 100 - vios.length).toString().slice(0,3) : 100}%`}
          spark={hbSparkline.map(v=>v*0.8)} color="#00E5FF" testid="kpi-health"/>
      </div>

      {/* Pending approvals */}
      {cands.some(c => c.status === "pending") && (
        <div className="glass glass-violet rounded-xl p-5 mb-6" data-testid="pending-section">
          <div className="label-mono mb-3 text-violet">PENDING APPROVAL</div>
          <div className="flex flex-wrap gap-3">
            {cands.filter(c => c.status === "pending").map(c => {
              const isLowScore = c.face_match_score < 0.50;
              return (
                <div key={c.id} className={`glass rounded-lg p-3 flex items-center gap-3 border ${isLowScore ? 'border-violation bg-violation/5' : 'border-violet/20'}`} data-testid={`pending-${c.id}`}>
                  <img src={resolveImg(c.selfie_url || c.selfie_b64 || "")} alt="" className="w-10 h-10 rounded-full object-cover bg-elevated" />
                  <div className="text-sm">
                    <div className="font-medium">{c.full_name}</div>
                    <div className={`font-mono text-xs ${isLowScore ? 'text-violation font-semibold' : 'text-white/60'}`}>
                      ID {c.student_id} • match {(c.face_match_score*100).toFixed(0)}% {isLowScore && "⚠️"}
                    </div>
                  </div>
                  <button data-testid={`approve-${c.id}`} onClick={() => decide(c.id, true)}
                    className="btn-cyan rounded-md px-3 py-1.5 ml-2"><Check size={14}/></button>
                  <button data-testid={`reject-${c.id}`} onClick={() => decide(c.id, false)}
                    className="btn-ghost-violet rounded-md px-3 py-1.5"><X size={14}/></button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Live grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5" data-testid="candidates-grid">
        {filtered.length === 0 && (
          <div className="col-span-full text-center text-white/40 py-12">
            No candidates yet. Share session code <span className="font-mono text-cyan">{session.session_code}</span> with students.
          </div>
        )}
        {filtered.map(c => {
          const cVios = vios.filter(v => v.candidate_id === c.id);
          const lastV = cVios[0];
          const cHb = hbs.filter(h => h.candidate_id === c.id);
          const lastHb = cHb[0];
          const lastFrame = frames[c.id];
          const isInactive = !lastHb && !lastFrame;
          const isLocked = c.status === "locked";
          const borderClass = isLocked ? "neon-red" : lastV ? "neon-red" : isInactive ? "neon-amber" : "neon-cyan";
          const statusLabel = isLocked ? "LOCKED" : lastV ? "VIOLATION" : isInactive ? "INACTIVE" : "LIVE";
          const statusColor = isLocked || lastV ? "text-violation" : isInactive ? "text-warning" : "text-online";
          return (
            <div key={c.id} className={`glass rounded-xl overflow-hidden ${borderClass}`} data-testid={`tile-${c.id}`}>
              <div className="aspect-video bg-elevated relative">
                {frames[c.id]?.image_b64 ? (
                  <img src={frames[c.id].image_b64} alt="" className="w-full h-full object-cover" />
                ) : c.selfie_url || c.selfie_b64 ? (
                  <img src={resolveImg(c.selfie_url || c.selfie_b64)} alt="" className="w-full h-full object-cover opacity-70" />
                ) : (
                  <div className="flex items-center justify-center h-full text-white/30 font-mono text-xs">NO FEED</div>
                )}
                <div className={`absolute top-2 left-2 px-2 py-1 rounded text-[10px] font-mono ${statusColor} bg-void/80 dot-pulse`}>
                  {statusLabel}
                </div>
                <div className="absolute top-2 right-2 flex gap-1">
                  {c.status !== "kicked" && (
                    <button className="p-1.5 bg-violation/80 text-white rounded hover:bg-violation" data-testid={`kick-${c.id}`} title="Kick Student" onClick={() => kickCandidate(c.id)}>
                      <UserX size={12} />
                    </button>
                  )}
                  <button className="p-1.5 bg-void/70 rounded hover:bg-cyan/20" data-testid={`view-${c.id}`}>
                    <Eye size={12} />
                  </button>
                </div>
              </div>
              <div className="p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-sm">{c.full_name}</div>
                    <div className="font-mono text-[11px] text-white/50">ID {c.student_id}</div>
                  </div>
                  <div className="w-20 h-8">
                    <Sparkline data={cHb.slice(0,15).map(h=>h.latency_ms||30).reverse()} color={statusColor.includes("violation")?"#FF3D71":statusColor.includes("warning")?"#FFB020":"#00E5FF"} height={32} />
                  </div>
                </div>
                {lastV && (
                  <div className="text-[11px] text-violation mt-2 font-mono">
                    {lastV.kind.toUpperCase()}: {lastV.detail || "Detected"}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-8 flex justify-end">
        <button data-testid="ai-grade-btn" onClick={() => nav(`/sessions/${sid}/report`)}
          className="btn-ghost-violet rounded-full px-5 py-2.5 flex items-center gap-2">
          <Brain size={16}/> AI Grading & Reports
        </button>
      </div>
    </AppShell>
  );
}

const Kpi = ({ icon: Icon, label, value, spark, color, testid }) => (
  <div className="glass rounded-xl p-4" data-testid={testid}>
    <div className="flex items-center gap-2 label-mono">
      <Icon size={14} /> {label}
    </div>
    <div className="font-mono text-2xl mt-1" style={{ color }}>{value}</div>
    <Sparkline data={spark.length ? spark : [10,12,11,14,13,15,12,16,18,15]} color={color} height={42} />
  </div>
);

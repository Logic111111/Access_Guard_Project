import React from "react";
import { Link } from "react-router-dom";
import { Users, ShieldCheck, ChevronRight } from "lucide-react";

export default function Home() {
  return (
    <div className="min-h-screen hud-bg hex-bg flex items-center justify-center p-6 text-center">
      <div className="max-w-4xl w-full space-y-10">
        <div className="glass rounded-3xl p-10 text-left shadow-2xl border border-white/10">
          <div className="flex flex-col items-center gap-4">
            <div className="rounded-3xl bg-white/5 p-5 inline-flex items-center justify-center">
              <ShieldCheck size={40} className="text-cyan" />
            </div>
            <div>
              <h1 className="font-display text-5xl text-white mb-3">AccessGuard</h1>
              <p className="text-white/70 max-w-2xl mx-auto text-base sm:text-lg">
                Choose your path to begin. Invigilators can manage sessions and monitor exams, while students can join securely and start their assessment flow.
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <Link to="/login" data-testid="invigilator-cta" className="glass rounded-3xl p-8 border border-cyan/20 hover:border-cyan transition-all group">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-cyan mb-4">
                  <ShieldCheck size={22} />
                  <span className="font-mono uppercase text-xs tracking-[0.3em]">Invigilator Portal</span>
                </div>
                <h2 className="font-display text-3xl mb-3">Sign in to monitor exams</h2>
                <p className="text-white/60 text-sm">
                  Create new sessions, review reports, and keep exam integrity intact from a centralized dashboard.
                </p>
              </div>
              <ChevronRight size={24} className="text-white/50 group-hover:text-cyan" />
            </div>
          </Link>

          <Link to="/student" data-testid="student-cta" className="glass rounded-3xl p-8 border border-violet/20 hover:border-violet transition-all group">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-violet mb-4">
                  <Users size={22} />
                  <span className="font-mono uppercase text-xs tracking-[0.3em]">Student Access</span>
                </div>
                <h2 className="font-display text-3xl mb-3">Join your exam session</h2>
                <p className="text-white/60 text-sm">
                  Enter your session code, verify your identity, and start the exam experience securely.
                </p>
              </div>
              <ChevronRight size={24} className="text-white/50 group-hover:text-violet" />
            </div>
          </Link>
        </div>
      </div>
    </div>
  );
}

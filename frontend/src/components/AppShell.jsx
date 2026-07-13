import React from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { Logo } from "./Logo";
import { LayoutDashboard, ServerCog, Users, FileText, ShieldCheck, Bell, LogOut } from "lucide-react";
import { setToken, setUser, getUser } from "../lib/api";

const NavItem = ({ to, icon: Icon, label, testid }) => (
  <NavLink
    to={to}
    end
    data-testid={testid}
    className={({ isActive }) =>
      `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all ${
        isActive
          ? "bg-cyan/10 text-cyan border border-cyan/40 neon-cyan"
          : "text-white/70 hover:text-white hover:bg-white/5"
      }`
    }
  >
    <Icon size={18} />
    <span className="text-sm">{label}</span>
  </NavLink>
);

export default function AppShell({ children, title, breadcrumb }) {
  const nav = useNavigate();
  const u = getUser();
  return (
    <div className="min-h-screen hud-bg flex">
      <aside className="w-64 shrink-0 glass border-r border-cyan/15 p-4 flex flex-col gap-6 sticky top-0 h-screen">
        <Logo />
        <nav className="flex flex-col gap-1.5">
          <NavItem to="/sessions" icon={ServerCog} label="Sessions" testid="nav-sessions" />
          <NavItem to="/dashboard" icon={LayoutDashboard} label="Dashboard" testid="nav-dashboard" />
          <NavItem to="/students" icon={Users} label="Students" testid="nav-students" />
          <NavItem to="/reports" icon={FileText} label="Reports" testid="nav-reports" />
          <NavItem to="/settings" icon={ShieldCheck} label="Settings" testid="nav-settings" />
        </nav>
        <div className="mt-auto glass rounded-lg p-3 text-xs">
          <div className="label-mono">SIGNED IN</div>
          <div className="text-white text-sm font-medium mt-1">{u?.name || "Invigilator"}</div>
          <div className="font-mono text-[11px] text-white/60">{u?.inv_id}</div>
          <button
            data-testid="logout-btn"
            onClick={() => { setToken(null); setUser(null); nav("/login"); }}
            className="btn-ghost-cyan mt-3 w-full rounded-md py-1.5 text-xs flex items-center justify-center gap-2"
          >
            <LogOut size={14} /> Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0">
        <header className="sticky top-0 z-10 glass border-b border-cyan/10 px-8 py-3 flex items-center justify-between">
          <div className="flex flex-col">
            <div className="label-mono">{breadcrumb || "Home"}</div>
            <h1 className="font-display text-xl">{title}</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="dot-pulse text-online text-xs font-mono">ONLINE</span>
            <button className="p-2 rounded-md border border-cyan/20 hover:bg-cyan/10" data-testid="notif-btn">
              <Bell size={16} />
            </button>
          </div>
        </header>
        <div className="p-8">{children}</div>
      </main>
    </div>
  );
}

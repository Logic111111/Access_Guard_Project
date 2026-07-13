import React from "react";

export const Logo = ({ size = 36, showText = true }) => (
  <div className="flex items-center gap-3" data-testid="ag-logo">
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id="agg" x1="0" y1="0" x2="64" y2="64">
          <stop offset="0%" stopColor="#00E5FF" />
          <stop offset="100%" stopColor="#B14CFF" />
        </linearGradient>
      </defs>
      <path d="M32 4 L56 14 V32 C56 46 45 56 32 60 C19 56 8 46 8 32 V14 Z"
        stroke="url(#agg)" strokeWidth="2.5" fill="rgba(0,229,255,0.06)" />
      <circle cx="32" cy="30" r="9" stroke="url(#agg)" strokeWidth="2.5" fill="none" />
      <circle cx="32" cy="30" r="3.5" fill="#00E5FF" />
    </svg>
    {showText && (
      <div className="leading-tight">
        <div className="font-display font-bold text-lg tracking-tight">AccessGuard</div>
        <div className="label-mono text-[0.6rem]">SECURE EXAM CORE</div>
      </div>
    )}
  </div>
);

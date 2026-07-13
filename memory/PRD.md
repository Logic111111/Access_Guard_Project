# AccessGuard — Secure Exam Monitoring System

## Original Problem Statement
Build a safe exam-conducting environment for both invigilators and students. Invigilator: create session, whitelist URLs/apps, approve/reject candidates, real-time face/screen monitoring, lock exam on prohibited site access, connection state every 10s, post-exam report, AI grading from a model answer. Student: login via ID upload (front+back) + selfie + blink liveness, enter session code, take exam, download completion receipt.

## Architecture
- **Backend**: FastAPI + MongoDB (motor). All endpoints under `/api`.
- **Auth**: JWT (PyJWT + bcrypt). Custom 2FA (any 6-digit string accepted — demo).
- **AI Grading**: Claude Sonnet 4.5 (`claude-sonnet-4-5-20250929`) via `emergentintegrations` using EMERGENT_LLM_KEY.
- **Frontend**: React 19 + Tailwind + shadcn UI + lucide-react + recharts + framer-motion + sonner.
- **Theme**: Cyberpunk HUD — Void/Surface dark with Neon Cyan + Violet, Unbounded/Inter/JetBrains Mono fonts.

## User Personas
1. **Invigilator** — creates and runs exam sessions, monitors candidates, grades.
2. **Student** — joins via session code, completes verification, takes exam, downloads receipt.

## What's Implemented (Feb 2026)
### Backend (`/app/backend/server.py`)
- `POST /api/auth/login`, `POST /api/auth/register`, `GET /api/auth/me`
- `POST/GET /api/sessions`, `GET /api/sessions/{sid}`, `/start`, `/end`
- `GET /api/public/sessions/by-code/{code}` (no auth)
- `POST /api/public/candidates/join`, `GET /api/public/candidates/{cid}`
- `GET /api/sessions/{sid}/candidates`, `POST /api/sessions/{sid}/candidates/decision`
- `POST /api/public/heartbeats`, `GET /api/sessions/{sid}/heartbeats`
- `POST /api/public/violations` (auto-locks candidate on `prohibited_url` / `unauthorized_person`)
- `POST /api/public/answers`, `GET /api/public/receipt/{cid}`
- `GET /api/sessions/{sid}/report`, `POST /api/sessions/{sid}/grade` (AI)

### Frontend
- Landing, Login (ID/password/6-digit OTP)
- Sessions list with empty state (per Figma reference)
- 4-step Create Session wizard (Identify → Configure → Whitelist → Launch)
- Live Dashboard: KPI cards w/ sparklines, pending approvals, video tiles w/ status colors, search
- Session Report w/ AI grading + CSV export
- Student Entry → 4-step Verify (ID Front/Back, Selfie, Blink Liveness w/ scan animation)
- Student Exam (timer, heartbeats every 10s, tab-blur violations, prohibited-URL lock screen, copy/right-click prevention)
- Student Receipt (downloadable .txt)

### Seeded
- Admin: `EG/STAFF/0001` / `AccessGuard2026!` / any 6-digit OTP

## Test Status
- Backend: 100% (23/23) — `/app/test_reports/iteration_1.json`
- Frontend: not tested by agent; manually screenshot-verified

## Backlog
### P1
- Production-grade 2FA (TOTP)
- Real face-api.js embedding match (currently passes liveness via brightness variance + sets match score 0.92 placeholder)
- WebRTC live video streaming (currently selfie snapshot is shown as the tile)
- Per-question marks honored in grading (currently hardcoded to 10/Q)
- Persistent file storage for ID images (currently base64 in Mongo)

### P2
- Multi-invigilator org accounts, audit logs
- Email notifications on session end
- Kiosk-mode browser lockdown (Electron)
- WebSocket push instead of 5s polling on dashboard

## Next Tasks
- Frontend e2e testing once UI is reviewed by user
- Wire up Reports/Students/Settings sidebar pages

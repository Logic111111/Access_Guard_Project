# Extension Quick Lockdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an invigilator start a minimal-setup "quick lockdown" session — no identity verification, auto-approved candidates — from the web app or directly from the browser extension's popup, and let a student join that session straight from the extension popup instead of the full web entry/verification flow.

**Architecture:** Three small backend changes (a new session flag, optional join fields, auto-approve wiring) are shared by two independent front-ends: a new one-screen web page (`QuickLockdown.jsx`) and a new role-aware extension popup that talks to the backend directly (invigilator login/create/end, student join+arm). The extension's existing DNR/heartbeat/fail-closed enforcement core is reused unchanged; only how a candidate's token is obtained changes.

**Tech Stack:** FastAPI + Motor (backend, Python 3.13, pytest), React + react-router + axios + Tailwind-style utility classes (frontend, Jest + React Testing Library), Manifest V3 Chrome extension in vanilla JS (`node --test`).

**Spec:** `docs/superpowers/specs/2026-09-29-extension-quick-lockdown-design.md`

## Global Constraints

- No new "unlock" capability anywhere (extension, popup, or web) — release/removal of DNR rules remains authenticated-backend-only, exactly as today.
- No new extension permissions or `host_permissions` — `manifest.json` already covers `http://*/*` and `https://*/*`.
- Invigilator and candidate credentials are stored under distinct `chrome.storage.local` keys and are never sent on the same request.
- Any new (appOrigin, apiBase) pair the extension talks to is validated through the existing `validateBootstrapTrust` (same-origin, loopback-pair, or explicitly trusted) — no new trust mechanism is introduced.
- Quick sessions always set `require_identity_verification: false` and `require_manual_approval: false`; there is no per-session toggle for either in the minimal UIs built here.
- Node engine remains `>=20` (extension); no new runtime dependencies are added to `backend/server.py`, the extension, or the frontend.
- A quick session still requires at least one question (existing "always require ≥1 question" decision).

## Review Focus

- Joining with a session code that does not exist or belongs to an ended session must surface the backend's actual error message from the extension popup, and must not leave the device stuck in an "arming" state. Pinned in Task 9's test.
- A device already armed for one candidate must refuse a second `EXTENSION_JOIN` for a different code rather than silently switching attempts. Pinned in Task 9's test.
- Reconfiguring the deployment (`CONFIGURE_DEPLOYMENT`) while a candidate is currently armed on that device must be refused, so a compromised or careless popup interaction cannot retarget an active lockdown. Pinned in Task 7's test.
- An invigilator's stored bearer token expiring or being revoked mid-session (a 401 on the candidate-count poll) must clear the stored invigilator auth rather than leave the popup showing a stale "signed in" state forever. Pinned in Task 8's test.
- A quick-create form submitted with an empty question must be rejected before any network call, consistent with "always require ≥1 question." Pinned in Task 5's test (pure helper) and Task 10's manual check.

---

## File Structure

**Backend**
- Modify: `backend/server.py` — `SessionConfig`, `StudentJoinIn`, `candidate_join`, `session_by_code`.
- Modify: `backend/tests/test_lockdown_helpers.py` — new Mongo-free tests for the above.

**Web frontend**
- Modify: `frontend/src/pages/StudentEntry.jsx` — skip-verification join branch.
- Modify: `frontend/src/pages/StudentEntry.test.jsx` — new coverage for that branch.
- Create: `frontend/src/pages/QuickLockdown.jsx` — one-screen quick-session creation page.
- Create: `frontend/src/pages/QuickLockdown.test.jsx`.
- Modify: `frontend/src/pages/Sessions.jsx` — "Quick Lockdown" entry point button.
- Modify: `frontend/src/App.js` — new route.

**Extension**
- Modify: `extension/config.js` — new storage keys and backend paths.
- Create: `extension/quick-session.js` — pure, chrome-free helpers (payload building, form validation).
- Create: `extension/tests/quick-session.test.mjs`.
- Modify: `extension/service-worker.js` — `finalizeArm` refactor, deployment config, invigilator auth, quick-session create/end/status, student join-from-extension, new popup message actions.
- Create: `extension/tests/popup-control.test.mjs`.
- Modify: `extension/popup.html`, `extension/popup.js`, `extension/ui.css` — role-aware popup UI.
- Modify: `extension/manifest.json`, `extension/package.json` — version bump.
- Modify: `extension/README.md` — document the new popup flows.

---

## Task 1: Backend — expose `require_identity_verification`

**Files:**
- Modify: `backend/server.py:700-723` (`SessionConfig`), `backend/server.py:1050-1073` (`session_by_code`)
- Test: `backend/tests/test_lockdown_helpers.py`

**Interfaces:**
- Produces: `SessionConfig.require_identity_verification: bool` (default `True`); `/public/sessions/by-code/{code}` response gains `"require_identity_verification"`.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_lockdown_helpers.py` (near `test_kicked_candidate_does_not_block_capacity_or_clean_rejoin`):

```python
def test_by_code_exposes_identity_verification_flag(monkeypatch):
    session = _session(session_code="QUIK-ABCD-EFGH", require_identity_verification=False)

    class FakeSessions:
        async def find_one(self, query, projection=None):
            return session

    class FakeDatabase:
        sessions = FakeSessions()

    monkeypatch.setattr(server, "db", FakeDatabase())

    result = asyncio.run(server.session_by_code(session["session_code"]))
    assert result["require_identity_verification"] is False

    del session["require_identity_verification"]
    default_result = asyncio.run(server.session_by_code(session["session_code"]))
    assert default_result["require_identity_verification"] is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_lockdown_helpers.py::test_by_code_exposes_identity_verification_flag -v`
Expected: FAIL — `KeyError: 'require_identity_verification'`

- [ ] **Step 3: Implement**

In `backend/server.py`, `SessionConfig` (around line 720), add the new field right after `require_manual_approval`:

```python
    require_manual_approval: bool = True
    require_identity_verification: bool = True
    require_fullscreen: bool = True
```

In `session_by_code` (around line 1064), add the field to the returned dict, next to `require_fullscreen`:

```python
        "require_fullscreen": bool(s.get("require_fullscreen", True)),
        "require_identity_verification": bool(s.get("require_identity_verification", True)),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_lockdown_helpers.py::test_by_code_exposes_identity_verification_flag -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/server.py backend/tests/test_lockdown_helpers.py
git commit -m "feat(backend): expose require_identity_verification on session config and by-code lookup"
```

---

## Task 2: Backend — optional join media and auto-approve wiring

**Files:**
- Modify: `backend/server.py:726-734` (`StudentJoinIn`), `backend/server.py:1091-1156` (`candidate_join`)
- Test: `backend/tests/test_lockdown_helpers.py`

**Interfaces:**
- Consumes: `SessionConfig.require_identity_verification`, `SessionConfig.require_manual_approval` (from Task 1 / existing).
- Produces: `StudentJoinIn` fields `id_front_b64`, `id_back_b64`, `selfie_b64` are now optional (default `""`); `candidate_join` auto-approves when the owning session has `require_manual_approval is False`.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_lockdown_helpers.py`:

```python
def test_candidate_join_without_verification_media_when_not_required(monkeypatch):
    session = _session(session_code="QUIK-ABCD-EFGH", require_identity_verification=False, status="scheduled")

    class FakeSessions:
        async def find_one(self, query, projection=None):
            return session

    class FakeCandidates:
        def __init__(self):
            self.inserted = None

        async def count_documents(self, query):
            return 0

        async def find_one(self, query, projection=None):
            return None

        async def insert_one(self, document):
            self.inserted = document.copy()

    fake_candidates = FakeCandidates()

    class FakeDatabase:
        sessions = FakeSessions()
        candidates = fake_candidates

    async def ignore_broadcast(*args, **kwargs):
        return None

    monkeypatch.setattr(server, "db", FakeDatabase())
    monkeypatch.setattr(server, "ws_broadcast", ignore_broadcast)
    monkeypatch.setattr(server, "make_candidate_token", lambda candidate_id, session_id: "test-candidate-token")

    result = asyncio.run(candidate_join(StudentJoinIn(
        session_code=session["session_code"],
        student_id="STUDENT-9",
        full_name="Quick Student",
    )))

    assert result["status"] == "pending"
    assert fake_candidates.inserted["id_front_url"] is None
    assert fake_candidates.inserted["id_back_url"] is None
    assert fake_candidates.inserted["selfie_url"] is None


def test_candidate_join_auto_approves_when_manual_approval_disabled(monkeypatch):
    session = _session(session_code="QUIK-ABCD-EFGH", require_manual_approval=False, status="live")

    class FakeSessions:
        async def find_one(self, query, projection=None):
            return session

    class FakeCandidates:
        def __init__(self):
            self.inserted = None

        async def count_documents(self, query):
            return 0

        async def find_one(self, query, projection=None):
            return None

        async def insert_one(self, document):
            self.inserted = document.copy()

    fake_candidates = FakeCandidates()

    class FakeDatabase:
        sessions = FakeSessions()
        candidates = fake_candidates

    async def ignore_broadcast(*args, **kwargs):
        return None

    monkeypatch.setattr(server, "db", FakeDatabase())
    monkeypatch.setattr(server, "ws_broadcast", ignore_broadcast)
    monkeypatch.setattr(server, "make_candidate_token", lambda candidate_id, session_id: "test-candidate-token")

    result = asyncio.run(candidate_join(StudentJoinIn(
        session_code=session["session_code"],
        student_id="STUDENT-10",
        full_name="Auto Approved",
    )))

    assert result["status"] == "approved"
    assert fake_candidates.inserted["status"] == "approved"
    assert fake_candidates.inserted["approved_at"] is not None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_lockdown_helpers.py -k "without_verification_media or auto_approves" -v`
Expected: FAIL — the first fails with a Pydantic `ValidationError` (missing required fields); the second fails because `result["status"] == "pending"`.

- [ ] **Step 3: Implement**

In `backend/server.py`, `StudentJoinIn` (around line 726-734), give the media fields defaults:

```python
class StudentJoinIn(BaseModel):
    session_code: str
    student_id: str
    full_name: str
    id_front_b64: str = ""
    id_back_b64: str = ""
    selfie_b64: str = ""
    liveness_passed: bool = True
    face_match_score: float = 0.0
```

In `candidate_join` (around line 1136-1151), replace the fixed `initial_status` with logic based on `require_manual_approval`, and stamp `approved_at` accordingly:

```python
    candidate_token = make_candidate_token(cid, s["id"])
    initial_status = "pending" if s.get("require_manual_approval", True) else "approved"
    approved_at = now_iso() if initial_status == "approved" else None
    doc = {
        "id": cid,
        "session_id": s["id"],
        "session_code": body.session_code,
        "student_id": body.student_id,
        "full_name": body.full_name,
        **urls,
        "liveness_passed": body.liveness_passed,
        "face_match_score": body.face_match_score,
        "status": initial_status,
        "joined_at": now_iso(),
        "approved_at": approved_at,
        "submitted_at": None,
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_lockdown_helpers.py -v`
Expected: PASS (all tests in the file, including the two new ones)

- [ ] **Step 5: Commit**

```bash
git add backend/server.py backend/tests/test_lockdown_helpers.py
git commit -m "feat(backend): make join verification media optional and wire require_manual_approval to auto-approve"
```

---

## Task 3: Web — StudentEntry skips verification for quick sessions

**Files:**
- Modify: `frontend/src/pages/StudentEntry.jsx`
- Modify: `frontend/src/pages/StudentEntry.test.jsx`

**Interfaces:**
- Consumes: `require_identity_verification` field on the `/public/sessions/by-code/{code}` response (Task 1); `saveCandidateAttempt({ candidateId, candidateToken })` from `frontend/src/lib/studentSession.js` (existing).
- Produces: no change to any exported function signature; only `StudentEntry`'s internal navigation behavior changes.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/pages/StudentEntry.test.jsx`, update the top-level mock to include `api.post`, add a `/student/verify` route to `renderEntry()`, and add a new describe block:

```jsx
jest.mock("../lib/api", () => ({
  api: { get: jest.fn(), post: jest.fn() },
  candidateAuthConfig: jest.fn(() => ({ headers: { "X-Candidate-Token": "signed-token" } })),
}));
```

```jsx
function renderEntry() {
  return render(
    <MemoryRouter initialEntries={["/student"]}>
      <Routes>
        <Route path="/student" element={<StudentEntry />} />
        <Route path="/student/verify" element={<div>Verify route</div>} />
        <Route path="/student/exam" element={<div>Recovered exam route</div>} />
        <Route path="/student/receipt" element={<div>Recovered receipt route</div>} />
      </Routes>
    </MemoryRouter>
  );
}
```

```jsx
describe("StudentEntry quick-join (no identity verification)", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    jest.clearAllMocks();
  });

  test("joins directly and skips /student/verify when the session waives identity verification", async () => {
    api.get.mockResolvedValueOnce({
      data: {
        session_code: "QUIK-ABCD-EFGH",
        exam_name: "Quick Lockdown",
        require_identity_verification: false,
      },
    });
    api.post.mockResolvedValueOnce({
      data: { id: "candidate-9", candidate_token: "candidate-token-long-enough" },
    });

    renderEntry();

    await userEvent.type(screen.getByTestId("code-input"), "QUIK-ABCD-EFGH");
    await userEvent.type(screen.getByTestId("student-id-input"), "S-42");
    await userEvent.type(screen.getByTestId("full-name-input"), "Asha Perera");
    await userEvent.click(screen.getByTestId("continue-btn"));

    expect(await screen.findByText("Recovered exam route")).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith("/public/candidates/join", {
      session_code: "QUIK-ABCD-EFGH",
      student_id: "S-42",
      full_name: "Asha Perera",
    });
    expect(getStoredCandidateId()).toBe("candidate-9");
  });

  test("still requires verification when the session does not waive it", async () => {
    api.get.mockResolvedValueOnce({
      data: { session_code: "EXAM-1", exam_name: "Full Exam" },
    });

    renderEntry();

    await userEvent.type(screen.getByTestId("code-input"), "EXAM-1");
    await userEvent.type(screen.getByTestId("student-id-input"), "S-1");
    await userEvent.type(screen.getByTestId("full-name-input"), "Someone");
    await userEvent.click(screen.getByTestId("continue-btn"));

    expect(await screen.findByText("Verify route")).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx jest src/pages/StudentEntry.test.jsx -t "quick-join"`
Expected: FAIL — first test times out waiting for "Recovered exam route" (currently always navigates to `/student/verify`); `api.post` is never called.

- [ ] **Step 3: Implement**

In `frontend/src/pages/StudentEntry.jsx`, add `saveCandidateAttempt` to the import from `../lib/studentSession`:

```jsx
import {
  clearStudentAttempt,
  getStoredStudentAttempt,
  saveCandidateAttempt,
  saveStudentJoinContext,
} from "../lib/studentSession";
```

Replace the body of `continueWithDetails`'s success branch:

```jsx
    try {
      const { data } = await api.get(`/public/sessions/by-code/${normalizedCode}`);
      const student = {
        student_id: String(enteredStudentId || "").trim(),
        full_name: String(enteredName || "").trim(),
      };
      saveStudentJoinContext(data, student);

      if (data.require_identity_verification === false) {
        const { data: candidate } = await api.post("/public/candidates/join", {
          session_code: data.session_code,
          student_id: student.student_id,
          full_name: student.full_name,
        });
        saveCandidateAttempt({ candidateId: candidate.id, candidateToken: candidate.candidate_token });
        nav("/student/exam");
        return;
      }

      nav("/student/verify");
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Invalid code");
    } finally {
      setLoading(false);
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx jest src/pages/StudentEntry.test.jsx`
Expected: PASS (all tests in the file, including the pre-existing recovery tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/StudentEntry.jsx frontend/src/pages/StudentEntry.test.jsx
git commit -m "feat(web): skip identity verification page for quick-lockdown sessions"
```

---

## Task 4: Web — QuickLockdown page and entry point

**Files:**
- Create: `frontend/src/pages/QuickLockdown.jsx`
- Create: `frontend/src/pages/QuickLockdown.test.jsx`
- Modify: `frontend/src/pages/Sessions.jsx`
- Modify: `frontend/src/App.js`

**Interfaces:**
- Consumes: `api.post` from `frontend/src/lib/api.js` (existing); backend `POST /sessions` and `POST /sessions/{id}/start` (existing).
- Produces: default export `QuickLockdown` component; route `/sessions/quick`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/pages/QuickLockdown.test.jsx`:

```jsx
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import QuickLockdown from "./QuickLockdown";
import { api } from "../lib/api";

jest.mock("../lib/api", () => ({
  api: { post: jest.fn() },
}));

jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/sessions/quick"]}>
      <Routes>
        <Route path="/sessions/quick" element={<QuickLockdown />} />
        <Route path="/sessions/:sid/dashboard" element={<div>Dashboard route</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("QuickLockdown", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("requires a question before launching", async () => {
    renderPage();
    await userEvent.click(screen.getByTestId("quick-launch-btn"));
    expect(api.post).not.toHaveBeenCalled();
  });

  test("creates and starts a session, then shows the join code", async () => {
    api.post.mockResolvedValueOnce({ data: { id: "session-9", session_code: "QUIK-ABCD-EFGH" } });
    api.post.mockResolvedValueOnce({ data: { ok: true } });

    renderPage();
    await userEvent.type(screen.getByTestId("quick-question-input"), "Summarize the reading.");
    await userEvent.click(screen.getByTestId("quick-launch-btn"));

    expect(await screen.findByTestId("quick-session-code-display")).toHaveTextContent("QUIK-ABCD-EFGH");
    expect(api.post).toHaveBeenNthCalledWith(1, "/sessions", expect.objectContaining({
      require_identity_verification: false,
      require_manual_approval: false,
    }));
    expect(api.post).toHaveBeenNthCalledWith(2, "/sessions/session-9/start");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx jest src/pages/QuickLockdown.test.jsx`
Expected: FAIL — `Cannot find module './QuickLockdown'`

- [ ] **Step 3: Implement**

Create `frontend/src/pages/QuickLockdown.jsx`:

```jsx
import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import AppShell from "../components/AppShell";
import { api } from "../lib/api";
import { Zap, ArrowRight, Plus, X } from "lucide-react";
import { toast } from "sonner";

function defaultExamName() {
  return `Quick Lockdown — ${new Date().toLocaleString()}`;
}

export default function QuickLockdown() {
  const nav = useNavigate();
  const [examName, setExamName] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [questionText, setQuestionText] = useState("");
  const [modelAnswer, setModelAnswer] = useState("");
  const [urls, setUrls] = useState([]);
  const [urlInput, setUrlInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState(null);

  const addUrl = () => {
    if (!urlInput.trim()) return;
    setUrls((u) => [...u, urlInput.trim()]);
    setUrlInput("");
  };

  const removeUrl = (idx) => setUrls((u) => u.filter((_, i) => i !== idx));

  const launch = async () => {
    if (!questionText.trim()) {
      toast.error("Add a question before launching.");
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        exam_name: examName.trim() || defaultExamName(),
        exam_code: `QUICK-${Date.now().toString(36).toUpperCase()}`,
        duration_minutes: Number(durationMinutes) || 60,
        max_students: 100,
        whitelisted_urls: urls,
        questions: [{ id: "q1", type: "text", text: questionText.trim(), marks: 10, options: [] }],
        model_answers: { q1: modelAnswer.trim() },
        lockdown_mode: "extension_required",
        require_manual_approval: false,
        require_identity_verification: false,
        auto_record_webcam: false,
        save_screen_share: false,
      };
      const { data } = await api.post("/sessions", payload);
      await api.post(`/sessions/${data.id}/start`);
      setCreated(data);
      toast.success("Quick lockdown started. Share the code with students.");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to start quick lockdown");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppShell title="Quick Lockdown" breadcrumb="Home / Sessions / Quick Lockdown">
      <div className="max-w-2xl mx-auto glass rounded-2xl p-8 space-y-5" data-testid="quick-lockdown-card">
        {!created ? (
          <>
            <div className="flex items-center gap-2 text-cyan">
              <Zap size={18} />
              <h2 className="font-display text-2xl">Start a quick lockdown</h2>
            </div>
            <p className="text-white/60 text-sm">
              No identity verification and no manual approval — students join with just a name
              and ID and the browser locks down immediately.
            </p>
            <div>
              <label className="label-mono">Exam Name (optional)</label>
              <input data-testid="quick-name-input" className="input-hud mt-1"
                value={examName} onChange={(e) => setExamName(e.target.value)}
                placeholder={defaultExamName()} />
            </div>
            <div>
              <label className="label-mono">Duration (minutes)</label>
              <input data-testid="quick-duration-input" type="number" min={5} max={480}
                className="input-hud mt-1" value={durationMinutes}
                onChange={(e) => setDurationMinutes(e.target.value)} />
            </div>
            <div>
              <label className="label-mono">Question</label>
              <textarea data-testid="quick-question-input" className="input-hud mt-1 min-h-[80px]"
                value={questionText} onChange={(e) => setQuestionText(e.target.value)}
                placeholder="What should students answer?" />
            </div>
            <div>
              <label className="label-mono">Model Answer (for auto-grading)</label>
              <textarea data-testid="quick-model-answer-input" className="input-hud mt-1 min-h-[60px]"
                value={modelAnswer} onChange={(e) => setModelAnswer(e.target.value)}
                placeholder="Key points expected in the answer..." />
            </div>
            <div>
              <label className="label-mono">Allowed URLs (optional)</label>
              <div className="flex gap-2 mt-1">
                <input data-testid="quick-url-input" className="input-hud" value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)} placeholder="docs.python.org" />
                <button data-testid="quick-url-add-btn" onClick={addUrl}
                  className="btn-ghost-cyan rounded-md px-3"><Plus size={16} /></button>
              </div>
              <div className="flex flex-wrap gap-2 mt-3">
                {urls.map((u, i) => (
                  <span key={i} className="glass rounded-full pl-3 pr-2 py-1 text-xs flex items-center gap-2 font-mono">
                    {u}
                    <button onClick={() => removeUrl(i)} data-testid={`quick-url-remove-${i}`}
                      className="text-violation hover:scale-110"><X size={12} /></button>
                  </span>
                ))}
              </div>
            </div>
            <button data-testid="quick-launch-btn" onClick={launch} disabled={submitting}
              className="btn-cyan w-full rounded-full px-6 py-3 flex items-center justify-center gap-2">
              <Zap size={16} /> {submitting ? "Starting..." : "Start Quick Lockdown"}
            </button>
          </>
        ) : (
          <div className="glass glass-violet rounded-lg p-5 text-center" data-testid="quick-session-launched">
            <div className="label-mono text-online">QUICK LOCKDOWN LIVE</div>
            <div className="font-display text-3xl text-cyan mt-2 tracking-widest" data-testid="quick-session-code-display">
              {created.session_code}
            </div>
            <div className="text-xs text-white/60 mt-2">Share this code with students. No verification required.</div>
            <button data-testid="quick-goto-dashboard-btn" onClick={() => nav(`/sessions/${created.id}/dashboard`)}
              className="btn-cyan rounded-lg px-5 py-2.5 mt-4 inline-flex items-center gap-2">
              Open Live Dashboard <ArrowRight size={16} />
            </button>
          </div>
        )}
      </div>
    </AppShell>
  );
}
```

Add the mocks `QuickLockdown.test.jsx` needs from `AppShell` — update its `jest.mock("../lib/api", ...)` block (already written above in Step 1) to also cover what `AppShell` imports:

```jsx
jest.mock("../lib/api", () => ({
  api: { post: jest.fn() },
  getUser: jest.fn(() => ({ name: "Test Invigilator", inv_id: "EG/STAFF/0001" })),
  setToken: jest.fn(),
  setUser: jest.fn(),
}));
```

In `frontend/src/pages/Sessions.jsx`, add the `Zap` import and a button in both the header (non-empty state) and the empty-state actions:

```jsx
import { Plus, FolderOpen, Clock, Calendar, History, Sparkles, Zap } from "lucide-react";
```

```jsx
          <div className="flex gap-2">
            <button data-testid="quick-lockdown-btn" onClick={() => nav("/sessions/quick")}
              className="btn-cyan rounded-full px-5 py-2.5 flex items-center gap-2">
              <Zap size={16} /> Quick Lockdown
            </button>
            <button data-testid="quick-quiz-btn" onClick={() => nav("/sessions/new?mode=quiz")}
              className="btn-ghost-cyan rounded-full px-5 py-2.5 flex items-center gap-2">
              <Sparkles size={16} /> Distribute Quiz
            </button>
            <button data-testid="new-session-btn" onClick={() => nav("/sessions/new")}
              className="btn-cyan rounded-full px-5 py-2.5 flex items-center gap-2">
              <Plus size={16} /> Create New Session
            </button>
          </div>
```

```jsx
          <div className="flex gap-3 mt-6">
            <button data-testid="empty-quick-btn" onClick={() => nav("/sessions/quick")}
              className="btn-cyan rounded-full px-6 py-3 flex items-center gap-2">
              <Zap size={16} /> Quick Lockdown
            </button>
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
```

In `frontend/src/App.js`, import and route it:

```jsx
import QuickLockdown from "./pages/QuickLockdown";
```

```jsx
          <Route path="/sessions/new" element={<Private><CreateSession /></Private>} />
          <Route path="/sessions/quick" element={<Private><QuickLockdown /></Private>} />
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx jest src/pages/QuickLockdown.test.jsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/QuickLockdown.jsx frontend/src/pages/QuickLockdown.test.jsx frontend/src/pages/Sessions.jsx frontend/src/App.js
git commit -m "feat(web): add Quick Lockdown page and entry points"
```

---

## Task 5: Extension — pure quick-session helpers

**Files:**
- Create: `extension/quick-session.js`
- Create: `extension/tests/quick-session.test.mjs`

**Interfaces:**
- Produces: `buildQuickSessionPayload(form, now?)`, `validateJoinForm(form)`, `validateLoginForm(form)`, `generateExamCode(examName, now?)`, `defaultQuickExamName(now?)` — all pure, no `chrome` or network access. Consumed by `service-worker.js` in Tasks 8 and 9.

- [ ] **Step 1: Write the failing tests**

Create `extension/tests/quick-session.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQuickSessionPayload,
  defaultQuickExamName,
  generateExamCode,
  validateJoinForm,
  validateLoginForm,
} from "../quick-session.js";

test("generateExamCode is deterministic and URL-safe for a given timestamp", () => {
  const code = generateExamCode("Networks 101", 1_700_000_000_000);
  assert.equal(code, generateExamCode("Networks 101", 1_700_000_000_000));
  assert.match(code, /^QUICK-[A-Z0-9-]+$/);
});

test("buildQuickSessionPayload fills defaults and always disables verification/approval", () => {
  const payload = buildQuickSessionPayload({
    durationMinutes: 45,
    questionText: "Summarize the reading.",
    modelAnswer: "Any reasonable summary.",
    whitelistedUrls: ["docs.python.org", "  ", "developer.mozilla.org"],
  }, 1_700_000_000_000);

  assert.equal(payload.duration_minutes, 45);
  assert.equal(payload.require_identity_verification, false);
  assert.equal(payload.require_manual_approval, false);
  assert.equal(payload.auto_record_webcam, false);
  assert.deepEqual(payload.whitelisted_urls, ["docs.python.org", "developer.mozilla.org"]);
  assert.deepEqual(payload.questions, [{ id: "q1", type: "text", text: "Summarize the reading.", marks: 10, options: [] }]);
  assert.equal(payload.model_answers.q1, "Any reasonable summary.");
  assert.equal(payload.exam_name, defaultQuickExamName(1_700_000_000_000));
});

test("buildQuickSessionPayload rejects a missing question or an out-of-range duration", () => {
  assert.throws(() => buildQuickSessionPayload({ durationMinutes: 30, questionText: "" }), TypeError);
  assert.throws(() => buildQuickSessionPayload({ durationMinutes: 1, questionText: "Q?" }), TypeError);
  assert.throws(() => buildQuickSessionPayload({ durationMinutes: 1000, questionText: "Q?" }), TypeError);
});

test("validateJoinForm normalizes the session code and requires every field", () => {
  const normalized = validateJoinForm({ sessionCode: " quik-abcd-efgh ", studentId: " S-1 ", fullName: " Asha " });
  assert.deepEqual(normalized, { sessionCode: "QUIK-ABCD-EFGH", studentId: "S-1", fullName: "Asha" });

  assert.throws(() => validateJoinForm({ studentId: "S-1", fullName: "Asha" }), TypeError);
  assert.throws(() => validateJoinForm({ sessionCode: "ABCD", fullName: "Asha" }), TypeError);
  assert.throws(() => validateJoinForm({ sessionCode: "ABCD", studentId: "S-1" }), TypeError);
});

test("validateLoginForm requires both an invigilator ID and a password", () => {
  assert.deepEqual(validateLoginForm({ invId: " EG/STAFF/0001 ", password: "secret" }), {
    invId: "EG/STAFF/0001",
    password: "secret",
  });
  assert.throws(() => validateLoginForm({ password: "secret" }), TypeError);
  assert.throws(() => validateLoginForm({ invId: "EG/STAFF/0001" }), TypeError);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extension && npm test`
Expected: FAIL — `Cannot find module '../quick-session.js'`

- [ ] **Step 3: Implement**

Create `extension/quick-session.js`:

```js
const EXAM_CODE_PREFIX = "QUICK";

function slugifyExamCode(examName) {
  const slug = String(examName || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 12);
  return slug || "SESSION";
}

export function generateExamCode(examName, now = Date.now()) {
  return `${EXAM_CODE_PREFIX}-${slugifyExamCode(examName)}-${now.toString(36).toUpperCase()}`;
}

export function defaultQuickExamName(now = Date.now()) {
  const stamp = new Date(now).toISOString().slice(0, 16).replace("T", " ");
  return `Quick Lockdown — ${stamp}`;
}

export function buildQuickSessionPayload(form = {}, now = Date.now()) {
  const durationMinutes = Number(form.durationMinutes);
  if (!Number.isFinite(durationMinutes) || durationMinutes < 5 || durationMinutes > 480) {
    throw new TypeError("Duration must be between 5 and 480 minutes");
  }
  const questionText = String(form.questionText || "").trim();
  if (!questionText) {
    throw new TypeError("A question is required");
  }
  const examName = String(form.examName || "").trim() || defaultQuickExamName(now);
  const modelAnswer = String(form.modelAnswer || "").trim();
  const whitelistedUrls = Array.isArray(form.whitelistedUrls)
    ? form.whitelistedUrls.map((url) => String(url).trim()).filter(Boolean)
    : [];

  return {
    exam_name: examName,
    exam_code: generateExamCode(examName, now),
    duration_minutes: Math.round(durationMinutes),
    max_students: 100,
    heartbeat_interval_sec: 10,
    allow_pause: true,
    auto_record_webcam: false,
    save_screen_share: false,
    whitelisted_urls: whitelistedUrls,
    whitelisted_apps: [],
    questions: [{ id: "q1", type: "text", text: questionText, marks: 10, options: [] }],
    model_answers: { q1: modelAnswer },
    quiz_mode: false,
    published: false,
    lockdown_mode: "extension_required",
    require_manual_approval: false,
    require_identity_verification: false,
    require_fullscreen: true,
    extension_min_version: "1.0.0",
  };
}

export function validateJoinForm(form = {}) {
  const sessionCode = String(form.sessionCode || "").trim().toUpperCase();
  const studentId = String(form.studentId || "").trim();
  const fullName = String(form.fullName || "").trim();
  if (!sessionCode) throw new TypeError("Session code is required");
  if (!studentId) throw new TypeError("Student ID is required");
  if (!fullName) throw new TypeError("Full name is required");
  return { sessionCode, studentId, fullName };
}

export function validateLoginForm(form = {}) {
  const invId = String(form.invId || "").trim();
  const password = String(form.password || "");
  if (!invId) throw new TypeError("Invigilator ID is required");
  if (!password) throw new TypeError("Password is required");
  return { invId, password };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && npm test`
Expected: PASS (all test files, including the pre-existing ones)

- [ ] **Step 5: Commit**

```bash
git add extension/quick-session.js extension/tests/quick-session.test.mjs
git commit -m "feat(extension): add pure quick-session payload and form validation helpers"
```

---

## Task 6: Extension — extract `finalizeArm` (refactor, no behavior change)

**Files:**
- Modify: `extension/service-worker.js:739-815` (`armFromPage`)

**Interfaces:**
- Produces: `finalizeArm({ candidateId, candidateToken, apiBase, appOrigin, armedExamUrl, examTabId, examWindowId, managed })` — returns the same runtime shape `armFromPage` used to return for a fresh arm. Consumed by `armFromPage` (this task) and by `joinFromExtension` (Task 9).

This task is a pure refactor — no new test is written. The existing `extension/tests/service-worker-smoke.test.mjs` is the regression guard: it must pass unchanged before and after.

- [ ] **Step 1: Confirm the baseline is green**

Run: `cd extension && npm test`
Expected: PASS (establishes the pre-refactor baseline)

- [ ] **Step 2: Extract `finalizeArm` and use it from `armFromPage`**

In `extension/service-worker.js`, add this function directly above `armFromPage` (currently at line 739):

```js
async function finalizeArm({
  candidateId,
  candidateToken,
  apiBase,
  appOrigin,
  armedExamUrl,
  examTabId,
  examWindowId,
  managed,
}) {
  const arming = await writeRuntime({
    ...defaultRuntime(),
    mode: "arming",
    candidateId,
    candidateToken,
    apiBase,
    appOrigin,
    armedExamUrl,
    examUrl: armedExamUrl,
    examTabId,
    examWindowId,
    managed,
    armedAt: new Date().toISOString(),
    lastError: null,
  });

  const next = await refreshPolicy({ initial: !arming.enforcementActive });
  void sendHeartbeat(next, "armed");
  return next;
}
```

Replace the tail of `armFromPage` — everything from `const arming = await writeRuntime({` through the closing `}` of the `catch` block — with:

```js
  return finalizeArm({
    candidateId,
    candidateToken,
    apiBase,
    appOrigin: requestedAppOrigin,
    armedExamUrl,
    examTabId: sender.tab.id,
    examWindowId: sender.tab.windowId,
    managed: trust.managed,
  });
```

The full function now reads:

```js
async function armFromPage(payload, sender) {
  const actualOrigin = senderOrigin(sender);
  const requestedAppOrigin = normalizeOrigin(payload?.appOrigin || actualOrigin);
  assert(
    requestedAppOrigin === actualOrigin,
    "app_origin_mismatch",
    "ARM appOrigin must match the page that sent the request"
  );

  const candidateId = validateCandidateId(payload?.candidateId);
  const candidateToken = validateCandidateToken(payload?.candidateToken);
  const apiBase = normalizeApiBase(payload?.apiBase, requestedAppOrigin);
  const trust = await validateBootstrapTrust(requestedAppOrigin, apiBase);
  const current = await readRuntime();
  const senderUrl = new URL(sender.url || sender.tab.url);
  senderUrl.hash = "";
  const armedExamUrl = senderUrl.toString();

  if (current.candidateToken && current.candidateId) {
    assert(
      current.candidateId === candidateId && current.appOrigin === requestedAppOrigin,
      "attempt_already_active",
      "A different AccessGuard attempt is already enforced"
    );
    assert(
      current.apiBase === apiBase,
      "api_origin_change_denied",
      "An active attempt cannot switch to a different API base"
    );

    const proposed = {
      ...current,
      candidateToken,
      armedExamUrl,
      examUrl: armedExamUrl,
      examTabId: sender.tab.id,
      examWindowId: sender.tab.windowId,
      managed: trust.managed,
    };
    try {
      const policy = await fetchPolicy(proposed);
      const next = await applyPolicy(proposed, policy);
      void sendHeartbeat(next, "rearmed");
      return next;
    } catch (error) {
      await recordPolicyFailure(current, error);
      throw error;
    }
  }

  return finalizeArm({
    candidateId,
    candidateToken,
    apiBase,
    appOrigin: requestedAppOrigin,
    armedExamUrl,
    examTabId: sender.tab.id,
    examWindowId: sender.tab.windowId,
    managed: trust.managed,
  });
}
```

- [ ] **Step 3: Run tests to confirm no regression**

Run: `cd extension && npm test`
Expected: PASS — identical results to Step 1

- [ ] **Step 4: Commit**

```bash
git add extension/service-worker.js
git commit -m "refactor(extension): extract finalizeArm from armFromPage"
```

---

## Task 7: Extension — deployment configuration

**Files:**
- Modify: `extension/config.js`
- Modify: `extension/service-worker.js`
- Create: `extension/tests/popup-control.test.mjs`

**Interfaces:**
- Consumes: `validateBootstrapTrust`, `loadTrustConfiguration`, `normalizeOrigin`, `normalizeApiBase`, `readRuntime`, `assert`, `LockdownError` (all existing in `service-worker.js`).
- Produces: `getOrDetectDeployment()` → `{ appOrigin, apiBase, managed } | null`; `configureDeployment(appUrl)` → same shape or throws; new popup actions `GET_DEPLOYMENT`, `CONFIGURE_DEPLOYMENT`. Consumed by Tasks 8, 9, 10.

- [ ] **Step 1: Write the failing test**

Create `extension/tests/popup-control.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";

export function createChromeMock({ managedTrust = {} } = {}) {
  const listeners = {};
  const storage = {};
  const event = (name) => ({ addListener(listener) { listeners[name] = listener; } });
  const chrome = {
    runtime: {
      getURL: (path = "") => `chrome-extension://test-extension/${path}`,
      getManifest: () => ({ version: "1.1.0" }),
      onMessage: event("runtime.onMessage"),
      onInstalled: event("runtime.onInstalled"),
      onStartup: event("runtime.onStartup"),
    },
    action: {
      setBadgeBackgroundColor: async () => undefined,
      setBadgeText: async () => undefined,
    },
    storage: {
      local: {
        get: async (key) => ({ [key]: storage[key] }),
        set: async (values) => Object.assign(storage, values),
        setAccessLevel: async () => undefined,
      },
      managed: {
        get: async () => managedTrust,
      },
    },
    declarativeNetRequest: {
      getDynamicRules: async () => [],
      updateDynamicRules: async () => undefined,
    },
    tabs: {
      query: async () => [],
      update: async () => ({}),
      create: async ({ url }) => ({ id: 44, windowId: 9, url }),
      get: async () => null,
      sendMessage: async () => undefined,
      onUpdated: event("tabs.onUpdated"),
      onCreated: event("tabs.onCreated"),
      onActivated: event("tabs.onActivated"),
      onRemoved: event("tabs.onRemoved"),
    },
    webNavigation: { onBeforeNavigate: event("webNavigation.onBeforeNavigate") },
    windows: {
      WINDOW_ID_NONE: -1,
      getLastFocused: async () => ({ id: 9, focused: true, state: "normal" }),
      get: async () => ({ id: 9, focused: true, state: "normal" }),
      update: async () => ({ id: 9, focused: true, state: "fullscreen" }),
      onFocusChanged: event("windows.onFocusChanged"),
    },
    idle: { onStateChanged: event("idle.onStateChanged") },
    alarms: { create: async () => undefined, onAlarm: event("alarms.onAlarm") },
  };
  return { chrome, listeners, storage };
}

export async function importFreshServiceWorker() {
  return import(`../service-worker.js?case=${Math.random().toString(36).slice(2)}`);
}

export function popupSender() {
  return { url: "chrome-extension://test-extension/popup.html" };
}

export function makeSend(listeners) {
  return (message) => new Promise((resolve) => {
    listeners["runtime.onMessage"](message, popupSender(), resolve);
  });
}

test("popup can configure a deployment manually", async () => {
  const { chrome, listeners, storage } = createChromeMock();
  globalThis.chrome = chrome;
  globalThis.fetch = async () => { throw new Error("no network expected in this test"); };
  await importFreshServiceWorker();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const send = makeSend(listeners);

  const before = await send({ scope: "accessguard-popup", action: "GET_DEPLOYMENT" });
  assert.equal(before.ok, true);
  assert.equal(before.data, null);

  const configured = await send({
    scope: "accessguard-popup",
    action: "CONFIGURE_DEPLOYMENT",
    appUrl: "https://exam.example.edu",
  });
  assert.equal(configured.ok, true);
  assert.equal(configured.data.appOrigin, "https://exam.example.edu");
  assert.equal(configured.data.apiBase, "https://exam.example.edu/api");
  assert.equal(storage.accessguardDeployment.appOrigin, "https://exam.example.edu");
});

test("popup auto-detects a managed deployment without prompting", async () => {
  const { chrome, listeners } = createChromeMock({
    managedTrust: {
      trusted_app_origins: ["https://managed.example.edu"],
      trusted_api_origins: ["https://managed.example.edu/api"],
    },
  });
  globalThis.chrome = chrome;
  globalThis.fetch = async () => { throw new Error("no network expected in this test"); };
  await importFreshServiceWorker();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const send = makeSend(listeners);

  const detected = await send({ scope: "accessguard-popup", action: "GET_DEPLOYMENT" });
  assert.equal(detected.ok, true);
  assert.equal(detected.data.appOrigin, "https://managed.example.edu");
  assert.equal(detected.data.managed, true);
});

test("configuring a new deployment is refused while a candidate is armed", async () => {
  const { chrome, listeners, storage } = createChromeMock();
  globalThis.chrome = chrome;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/public/extension/policy")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidate_id: "candidate-1",
          session_id: "session-1",
          state: "enforced",
          enforcement: true,
          policy_version: 1,
          exam_url: "https://exam.example.edu/student/exam",
          app_origins: ["https://exam.example.edu"],
          allowed_origins: [],
          timestamps: { generated_at: new Date().toISOString() },
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  await importFreshServiceWorker();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const send = makeSend(listeners);

  storage.accessguardRuntime = {
    mode: "enforced",
    enforcementActive: true,
    candidateId: "candidate-1",
    candidateToken: "candidate-token-long-enough",
    apiBase: "https://exam.example.edu/api",
    appOrigin: "https://exam.example.edu",
    allowedOrigins: ["https://exam.example.edu"],
  };

  const rejected = await send({
    scope: "accessguard-popup",
    action: "CONFIGURE_DEPLOYMENT",
    appUrl: "https://other.example.edu",
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "cannot_reconfigure_while_armed");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npm test`
Expected: FAIL — `Unsupported popup action` for `GET_DEPLOYMENT`/`CONFIGURE_DEPLOYMENT`

- [ ] **Step 3: Implement**

In `extension/config.js`, add:

```js
export const DEPLOYMENT_STORAGE_KEY = "accessguardDeployment";
```

In `extension/service-worker.js`, add `DEPLOYMENT_STORAGE_KEY` to the `config.js` import list, then add these functions after `loadTrustConfiguration` (around line 263):

```js
async function readDeployment() {
  const stored = await chrome.storage.local.get(DEPLOYMENT_STORAGE_KEY);
  const value = stored?.[DEPLOYMENT_STORAGE_KEY];
  if (!value || typeof value !== "object" || !value.appOrigin || !value.apiBase) return null;
  return { appOrigin: value.appOrigin, apiBase: value.apiBase, managed: Boolean(value.managed) };
}

async function writeDeployment(deployment) {
  await chrome.storage.local.set({ [DEPLOYMENT_STORAGE_KEY]: deployment });
  return deployment;
}

async function getOrDetectDeployment() {
  const existing = await readDeployment();
  if (existing) return existing;

  const trust = await loadTrustConfiguration();
  if (trust.appOrigins.length && trust.apiOrigins.length) {
    return writeDeployment({ appOrigin: trust.appOrigins[0], apiBase: trust.apiOrigins[0], managed: true });
  }
  return null;
}

async function configureDeployment(appUrl) {
  const runtime = await readRuntime();
  assert(
    !runtime.candidateToken,
    "cannot_reconfigure_while_armed",
    "Sign out or release the active lockdown before changing servers"
  );

  const appOrigin = normalizeOrigin(appUrl);
  const apiBase = normalizeApiBase(undefined, appOrigin);
  const trust = await validateBootstrapTrust(appOrigin, apiBase);
  return writeDeployment({ appOrigin, apiBase, managed: trust.managed });
}
```

In `handlePopupMessage` (around line 928), add before the final `throw`:

```js
  if (message?.action === "GET_DEPLOYMENT") return getOrDetectDeployment();
  if (message?.action === "CONFIGURE_DEPLOYMENT") return configureDeployment(message.appUrl);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && npm test`
Expected: PASS (all test files)

- [ ] **Step 5: Commit**

```bash
git add extension/config.js extension/service-worker.js extension/tests/popup-control.test.mjs
git commit -m "feat(extension): let the popup configure or auto-detect its AccessGuard deployment"
```

---

## Task 8: Extension — invigilator auth and quick-session create/end/status

**Files:**
- Modify: `extension/config.js`
- Modify: `extension/service-worker.js`
- Modify: `extension/tests/popup-control.test.mjs`

**Interfaces:**
- Consumes: `getOrDetectDeployment()`, `endpointUrl`, `fetchWithTimeout`, `readJsonResponse`, `assert`, `LockdownError` (existing/Task 7); `validateLoginForm`, `buildQuickSessionPayload` (Task 5).
- Produces: `invigilatorLogin({ invId, password })`, `invigilatorLogout()`, `createQuickSession(form)`, `endQuickSession()`, `getControlStatus()`; new popup actions `INVIGILATOR_LOGIN`, `INVIGILATOR_LOGOUT`, `CREATE_QUICK_SESSION`, `END_QUICK_SESSION`, `GET_CONTROL_STATUS`. Consumed by Task 10 (popup UI).

- [ ] **Step 1: Write the failing test**

Append to `extension/tests/popup-control.test.mjs`:

```js
test("invigilator can sign in, start a quick session, poll status, and end it", async () => {
  const { chrome, listeners, storage } = createChromeMock();
  globalThis.chrome = chrome;
  const fetchCalls = [];
  let candidateCount = 0;
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    const href = String(url);
    if (href.endsWith("/auth/login")) {
      return { ok: true, status: 200, json: async () => ({ token: "inv-token-123", inv_id: "EG/STAFF/0001", name: "Ada Lovelace" }) };
    }
    if (href.endsWith("/sessions")) {
      return { ok: true, status: 200, json: async () => ({ id: "session-1", session_code: "QUIK-ABCD-EFGH", exam_name: "Quick Lockdown" }) };
    }
    if (href.endsWith("/sessions/session-1/start")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, started_at: new Date().toISOString() }) };
    }
    if (href.endsWith("/sessions/session-1/candidates")) {
      return { ok: true, status: 200, json: async () => Array.from({ length: candidateCount }, (_, i) => ({ id: `cand-${i}` })) };
    }
    if (href.endsWith("/sessions/session-1/end")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, ended_at: new Date().toISOString() }) };
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  await importFreshServiceWorker();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const send = makeSend(listeners);

  await send({ scope: "accessguard-popup", action: "CONFIGURE_DEPLOYMENT", appUrl: "https://exam.example.edu" });

  const login = await send({
    scope: "accessguard-popup",
    action: "INVIGILATOR_LOGIN",
    invId: "EG/STAFF/0001",
    password: "AccessGuard2026!",
  });
  assert.equal(login.ok, true);
  assert.equal(login.data.name, "Ada Lovelace");
  assert.equal(storage.accessguardInvigilatorAuth.token, "inv-token-123");

  const created = await send({
    scope: "accessguard-popup",
    action: "CREATE_QUICK_SESSION",
    durationMinutes: 45,
    questionText: "Summarize the reading.",
    modelAnswer: "Any reasonable summary.",
    whitelistedUrls: [],
  });
  assert.equal(created.ok, true);
  assert.equal(created.data.sessionCode, "QUIK-ABCD-EFGH");
  assert.ok(fetchCalls.some((c) => c.url.endsWith("/sessions/session-1/start")));
  const createCall = fetchCalls.find((c) => c.url.endsWith("/sessions") && c.options.method === "POST");
  assert.equal(createCall.options.headers.Authorization, "Bearer inv-token-123");

  candidateCount = 3;
  const status = await send({ scope: "accessguard-popup", action: "GET_CONTROL_STATUS" });
  assert.equal(status.ok, true);
  assert.equal(status.data.invigilator.signedIn, true);
  assert.equal(status.data.quickSession.active, true);
  assert.equal(status.data.quickSession.candidateCount, 3);

  const ended = await send({ scope: "accessguard-popup", action: "END_QUICK_SESSION" });
  assert.equal(ended.ok, true);
  const statusAfterEnd = await send({ scope: "accessguard-popup", action: "GET_CONTROL_STATUS" });
  assert.equal(statusAfterEnd.data.quickSession.active, false);
});

test("an expired invigilator token is cleared instead of shown as signed in forever", async () => {
  const { chrome, listeners, storage } = createChromeMock();
  globalThis.chrome = chrome;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.endsWith("/auth/login")) {
      return { ok: true, status: 200, json: async () => ({ token: "stale-token", inv_id: "EG/STAFF/0001", name: "Ada Lovelace" }) };
    }
    if (href.endsWith("/sessions/session-1/candidates")) {
      return { ok: false, status: 401, json: async () => ({ detail: "Invalid token" }) };
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  await importFreshServiceWorker();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const send = makeSend(listeners);

  await send({ scope: "accessguard-popup", action: "CONFIGURE_DEPLOYMENT", appUrl: "https://exam.example.edu" });
  await send({ scope: "accessguard-popup", action: "INVIGILATOR_LOGIN", invId: "EG/STAFF/0001", password: "x" });
  storage.accessguardActiveQuickSession = { sessionId: "session-1", sessionCode: "QUIK-ABCD-EFGH" };

  const status = await send({ scope: "accessguard-popup", action: "GET_CONTROL_STATUS" });
  assert.equal(status.ok, true);
  assert.equal(status.data.invigilator.signedIn, false);
  assert.equal(status.data.quickSession.active, false);
  assert.equal(storage.accessguardInvigilatorAuth, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extension && npm test`
Expected: FAIL — `Unsupported popup action` for `INVIGILATOR_LOGIN`/`CREATE_QUICK_SESSION`/etc.

- [ ] **Step 3: Implement**

In `extension/config.js`, add:

```js
export const INVIGILATOR_AUTH_STORAGE_KEY = "accessguardInvigilatorAuth";
export const ACTIVE_QUICK_SESSION_STORAGE_KEY = "accessguardActiveQuickSession";
export const AUTH_LOGIN_PATH = "/auth/login";
export const SESSIONS_PATH = "/sessions";
```

In `extension/service-worker.js`, add the four new names to the `config.js` import, and add `buildQuickSessionPayload, validateLoginForm` via a new import from `./quick-session.js`:

```js
import { buildQuickSessionPayload, validateLoginForm } from "./quick-session.js";
```

Add these functions after `configureDeployment` (Task 7):

```js
function invigilatorHeaders(token, hasBody = false) {
  return {
    Accept: "application/json",
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
    Authorization: `Bearer ${token}`,
    "Cache-Control": "no-store",
  };
}

async function readInvigilatorAuth() {
  const stored = await chrome.storage.local.get(INVIGILATOR_AUTH_STORAGE_KEY);
  const value = stored?.[INVIGILATOR_AUTH_STORAGE_KEY];
  if (!value || typeof value !== "object" || !value.token) return null;
  return value;
}

async function writeInvigilatorAuth(auth) {
  await chrome.storage.local.set({ [INVIGILATOR_AUTH_STORAGE_KEY]: auth });
  return auth;
}

async function clearInvigilatorAuth() {
  await chrome.storage.local.set({ [INVIGILATOR_AUTH_STORAGE_KEY]: null });
}

async function readActiveQuickSession() {
  const stored = await chrome.storage.local.get(ACTIVE_QUICK_SESSION_STORAGE_KEY);
  const value = stored?.[ACTIVE_QUICK_SESSION_STORAGE_KEY];
  if (!value || typeof value !== "object" || !value.sessionId) return null;
  return value;
}

async function writeActiveQuickSession(session) {
  await chrome.storage.local.set({ [ACTIVE_QUICK_SESSION_STORAGE_KEY]: session });
  return session;
}

async function clearActiveQuickSession() {
  await chrome.storage.local.set({ [ACTIVE_QUICK_SESSION_STORAGE_KEY]: null });
}

async function invigilatorLogin({ invId, password }) {
  const { invId: normalizedInvId, password: normalizedPassword } = validateLoginForm({ invId, password });
  const deployment = await getOrDetectDeployment();
  assert(deployment, "deployment_not_configured", "Connect this extension to an AccessGuard server first");

  const response = await fetchWithTimeout(endpointUrl(deployment.apiBase, AUTH_LOGIN_PATH), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ inv_id: normalizedInvId, password: normalizedPassword, login_method: "password" }),
  });
  const data = await readJsonResponse(response, "invigilator_login_failed");
  await writeInvigilatorAuth({ token: data.token, invId: data.inv_id, name: data.name });
  return { invId: data.inv_id, name: data.name };
}

async function invigilatorLogout() {
  await clearInvigilatorAuth();
  await clearActiveQuickSession();
  return { signedOut: true };
}

async function requireInvigilatorContext() {
  const deployment = await getOrDetectDeployment();
  assert(deployment, "deployment_not_configured", "Connect this extension to an AccessGuard server first");
  const auth = await readInvigilatorAuth();
  assert(auth?.token, "invigilator_not_signed_in", "Sign in as an invigilator first");
  return { deployment, auth };
}

async function createQuickSession(form) {
  const { deployment, auth } = await requireInvigilatorContext();
  const payload = buildQuickSessionPayload(form);

  const createResponse = await fetchWithTimeout(endpointUrl(deployment.apiBase, SESSIONS_PATH), {
    method: "POST",
    headers: invigilatorHeaders(auth.token, true),
    body: JSON.stringify(payload),
  });
  const session = await readJsonResponse(createResponse, "quick_session_create_failed");

  const startResponse = await fetchWithTimeout(endpointUrl(deployment.apiBase, `${SESSIONS_PATH}/${session.id}/start`), {
    method: "POST",
    headers: invigilatorHeaders(auth.token, false),
  });
  await readJsonResponse(startResponse, "quick_session_start_failed");

  await writeActiveQuickSession({ sessionId: session.id, sessionCode: session.session_code });
  return { sessionId: session.id, sessionCode: session.session_code };
}

async function endQuickSession() {
  const { deployment, auth } = await requireInvigilatorContext();
  const active = await readActiveQuickSession();
  assert(active?.sessionId, "no_active_quick_session", "No quick session is currently running");

  const response = await fetchWithTimeout(endpointUrl(deployment.apiBase, `${SESSIONS_PATH}/${active.sessionId}/end`), {
    method: "POST",
    headers: invigilatorHeaders(auth.token, false),
  });
  await readJsonResponse(response, "quick_session_end_failed");
  await clearActiveQuickSession();
  return { ended: true };
}

async function fetchQuickSessionCandidateCount(apiBase, token, sessionId) {
  const response = await fetchWithTimeout(endpointUrl(apiBase, `${SESSIONS_PATH}/${sessionId}/candidates`), {
    method: "GET",
    headers: invigilatorHeaders(token, false),
  });
  const rows = await readJsonResponse(response, "quick_session_status_failed");
  return Array.isArray(rows) ? rows.length : 0;
}

async function getControlStatus() {
  const deployment = await getOrDetectDeployment();
  const invigilatorAuth = await readInvigilatorAuth();
  const active = await readActiveQuickSession();

  let quickSession = { active: false, sessionId: null, sessionCode: null, candidateCount: 0 };
  if (active?.sessionId && deployment && invigilatorAuth?.token) {
    try {
      const candidateCount = await fetchQuickSessionCandidateCount(deployment.apiBase, invigilatorAuth.token, active.sessionId);
      quickSession = { active: true, sessionId: active.sessionId, sessionCode: active.sessionCode, candidateCount };
    } catch (error) {
      if (error?.code === "candidate_auth_failed") {
        await clearInvigilatorAuth();
        await clearActiveQuickSession();
        return getControlStatus();
      }
      quickSession = { active: true, sessionId: active.sessionId, sessionCode: active.sessionCode, candidateCount: 0 };
    }
  }

  const auth = await readInvigilatorAuth();
  return {
    deployment,
    invigilator: { signedIn: Boolean(auth?.token), invId: auth?.invId || null, name: auth?.name || null },
    quickSession,
  };
}
```

In `handlePopupMessage`, add these actions alongside the ones from Task 7:

```js
  if (message?.action === "GET_CONTROL_STATUS") return getControlStatus();
  if (message?.action === "INVIGILATOR_LOGIN") return invigilatorLogin(message);
  if (message?.action === "INVIGILATOR_LOGOUT") return invigilatorLogout();
  if (message?.action === "CREATE_QUICK_SESSION") return createQuickSession(message);
  if (message?.action === "END_QUICK_SESSION") return endQuickSession();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && npm test`
Expected: PASS (all test files)

- [ ] **Step 5: Commit**

```bash
git add extension/config.js extension/service-worker.js extension/tests/popup-control.test.mjs
git commit -m "feat(extension): let the popup sign in an invigilator and run a quick session"
```

---

## Task 9: Extension — student join-from-extension

**Files:**
- Modify: `extension/service-worker.js`
- Modify: `extension/tests/popup-control.test.mjs`

**Interfaces:**
- Consumes: `getOrDetectDeployment()` (Task 7), `finalizeArm` (Task 6), `validateJoinForm` (Task 5), `normalizeExamUrl`, `validateCandidateId`, `validateCandidateToken`, `readRuntime`, `endpointUrl`, `fetchWithTimeout`, `readJsonResponse` (all existing).
- Produces: `joinFromExtension({ sessionCode, studentId, fullName })`; new popup action `EXTENSION_JOIN`.

- [ ] **Step 1: Write the failing test**

Append to `extension/tests/popup-control.test.mjs`:

```js
test("a student can join a quick session directly from the popup, and a second join is refused", async () => {
  const { chrome, listeners, storage } = createChromeMock();
  globalThis.chrome = chrome;
  const fetchCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    const href = String(url);
    if (href.includes("/public/candidates/join")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "candidate-9", candidate_token: "candidate-token-long-enough", status: "approved" }),
      };
    }
    if (href.includes("/public/extension/policy")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidate_id: "candidate-9",
          session_id: "session-1",
          state: "enforced",
          enforcement: true,
          policy_version: 1,
          exam_url: "https://exam.example.edu/student/exam",
          app_origins: ["https://exam.example.edu"],
          allowed_origins: [],
          timestamps: { generated_at: new Date().toISOString() },
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  await importFreshServiceWorker();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const send = makeSend(listeners);

  await send({ scope: "accessguard-popup", action: "CONFIGURE_DEPLOYMENT", appUrl: "https://exam.example.edu" });

  const joined = await send({
    scope: "accessguard-popup",
    action: "EXTENSION_JOIN",
    sessionCode: "quik-abcd-efgh",
    studentId: "S-42",
    fullName: "Asha Perera",
  });

  assert.equal(joined.ok, true);
  assert.equal(joined.data.mode, "enforced");
  assert.equal(joined.data.candidateId, "candidate-9");
  const joinCall = fetchCalls.find((c) => c.url.includes("/public/candidates/join"));
  assert.equal(JSON.parse(joinCall.options.body).session_code, "QUIK-ABCD-EFGH");
  assert.equal(storage.accessguardRuntime.candidateId, "candidate-9");

  const secondJoin = await send({
    scope: "accessguard-popup",
    action: "EXTENSION_JOIN",
    sessionCode: "OTHR-WXYZ-1234",
    studentId: "S-99",
    fullName: "Someone Else",
  });
  assert.equal(secondJoin.ok, false);
  assert.equal(secondJoin.error.code, "already_armed_for_candidate");
});

test("joining with an unknown session code surfaces the backend's error", async () => {
  const { chrome, listeners } = createChromeMock();
  globalThis.chrome = chrome;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/public/candidates/join")) {
      return { ok: false, status: 404, json: async () => ({ detail: "Invalid session code" }) };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  await importFreshServiceWorker();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const send = makeSend(listeners);

  await send({ scope: "accessguard-popup", action: "CONFIGURE_DEPLOYMENT", appUrl: "https://exam.example.edu" });
  const result = await send({
    scope: "accessguard-popup",
    action: "EXTENSION_JOIN",
    sessionCode: "BOGUS-CODE-0000",
    studentId: "S-1",
    fullName: "Nobody",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.message, "Invalid session code");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extension && npm test`
Expected: FAIL — `Unsupported popup action` for `EXTENSION_JOIN`

- [ ] **Step 3: Implement**

In `extension/service-worker.js`, add `CANDIDATE_JOIN_PATH` to the `config.js` import and add `validateJoinForm` to the `quick-session.js` import:

```js
import { buildQuickSessionPayload, validateJoinForm, validateLoginForm } from "./quick-session.js";
```

In `extension/config.js`, add:

```js
export const CANDIDATE_JOIN_PATH = "/public/candidates/join";
```

Add this function after `endQuickSession` in `extension/service-worker.js`:

```js
async function joinFromExtension({ sessionCode, studentId, fullName }) {
  const deployment = await getOrDetectDeployment();
  assert(deployment, "deployment_not_configured", "Connect this extension to an AccessGuard server first");

  const current = await readRuntime();
  assert(!current.candidateToken, "already_armed_for_candidate", "This device is already joined to an exam attempt");

  const { sessionCode: code, studentId: id, fullName: name } = validateJoinForm({ sessionCode, studentId, fullName });

  const response = await fetchWithTimeout(endpointUrl(deployment.apiBase, CANDIDATE_JOIN_PATH), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      session_code: code,
      student_id: id,
      full_name: name,
      id_front_b64: "",
      id_back_b64: "",
      selfie_b64: "",
      liveness_passed: true,
      face_match_score: 1,
    }),
  });
  const candidate = await readJsonResponse(response, "extension_join_failed");
  const candidateId = validateCandidateId(candidate?.id);
  const candidateToken = validateCandidateToken(candidate?.candidate_token);

  const armedExamUrl = normalizeExamUrl("/student/exam", deployment.appOrigin);
  const tab = await chrome.tabs.create({ url: armedExamUrl, active: true });

  return finalizeArm({
    candidateId,
    candidateToken,
    apiBase: deployment.apiBase,
    appOrigin: deployment.appOrigin,
    armedExamUrl,
    examTabId: tab.id,
    examWindowId: tab.windowId,
    managed: deployment.managed,
  });
}
```

In `handlePopupMessage`, add:

```js
  if (message?.action === "EXTENSION_JOIN") return publicStatus(await joinFromExtension(message));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && npm test`
Expected: PASS (all test files)

- [ ] **Step 5: Commit**

```bash
git add extension/config.js extension/service-worker.js extension/tests/popup-control.test.mjs
git commit -m "feat(extension): let a student join a quick session directly from the popup"
```

---

## Task 10: Extension — role-aware popup UI

**Files:**
- Modify: `extension/popup.html`
- Modify: `extension/popup.js`
- Modify: `extension/ui.css`
- Modify: `extension/manifest.json`, `extension/package.json`
- Modify: `extension/README.md`

**Interfaces:**
- Consumes every popup action added in Tasks 7-9 (`GET_DEPLOYMENT`, `CONFIGURE_DEPLOYMENT`, `GET_CONTROL_STATUS`, `INVIGILATOR_LOGIN`, `INVIGILATOR_LOGOUT`, `CREATE_QUICK_SESSION`, `END_QUICK_SESSION`, `EXTENSION_JOIN`) plus the pre-existing `GET_STATUS`/`REFRESH_POLICY`.

There is no DOM test runner in this project (existing `popup.js` has no automated test either); this task's correctness is verified by the already-tested message contract from Tasks 7-9 plus the manual steps in Step 4. Keep `popup.js` a thin caller of those actions so the tested logic stays in `service-worker.js`.

- [ ] **Step 1: Bump the version pair the manifest test enforces**

`extension/tests/manifest.test.mjs` asserts `manifest.version === packageJson.version`. In `extension/manifest.json` and `extension/package.json`, change `"version": "1.0.2"` to `"version": "1.1.0"` in both files.

Run: `cd extension && npm test`
Expected: PASS (manifest test still passes with the matched bump; nothing else should change)

- [ ] **Step 2: Replace `extension/ui.css` additions**

Append to `extension/ui.css`:

```css
input[type="text"],
input[type="password"],
input[type="number"],
textarea {
  display: block;
  width: 100%;
  margin-top: 4px;
  margin-bottom: 12px;
  padding: 9px 12px;
  border: 1px solid rgba(0, 229, 255, 0.35);
  border-radius: 10px;
  background: rgba(7, 16, 25, 0.7);
  color: #e6f7ff;
  font: 500 13px/1.4 inherit;
}

textarea {
  resize: vertical;
}

.tabs {
  display: flex;
  gap: 8px;
  margin: 14px 0;
}

.tab {
  flex: 1;
  background: transparent;
  border: 1px solid rgba(0, 229, 255, 0.3);
  color: #a9c0cd;
}

.tab.active {
  background: rgba(0, 229, 255, 0.12);
  color: #00e5ff;
  border-color: rgba(0, 229, 255, 0.6);
}

.session-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  font-size: 12px;
  color: #a9c0cd;
}
```

- [ ] **Step 3: Replace `extension/popup.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>AccessGuard Lockdown</title>
    <link rel="stylesheet" href="ui.css">
  </head>
  <body class="popup-page">
    <main class="panel">
      <p class="eyebrow">Extension control</p>
      <h1>AccessGuard Lockdown</h1>

      <section id="setup-view" hidden>
        <p class="notice">Connect this extension to your AccessGuard deployment once. Ask your admin if you are not sure of the URL.</p>
        <label class="label" for="setup-app-url">AccessGuard App URL</label>
        <input id="setup-app-url" type="text" placeholder="https://exam.example.edu">
        <div class="actions">
          <button id="setup-connect-btn" type="button">Connect</button>
        </div>
        <p id="setup-notice" class="notice" role="status" aria-live="polite"></p>
      </section>

      <section id="role-view" hidden>
        <div class="tabs">
          <button id="role-tab-invigilator" class="tab" type="button">Invigilator</button>
          <button id="role-tab-student" class="tab" type="button">Join as student</button>
        </div>

        <div id="invigilator-panel" hidden>
          <div id="invigilator-session-bar" class="session-bar" hidden>
            <span id="invigilator-name" class="mono"></span>
            <button id="inv-signout-btn" class="secondary" type="button">Sign out</button>
          </div>

          <div id="invigilator-login-view">
            <label class="label" for="inv-id-input">Invigilator ID</label>
            <input id="inv-id-input" type="text" placeholder="EG/STAFF/####">
            <label class="label" for="inv-password-input">Password</label>
            <input id="inv-password-input" type="password">
            <div class="actions">
              <button id="inv-login-btn" type="button">Sign in</button>
            </div>
          </div>

          <div id="quick-create-view" hidden>
            <label class="label" for="quick-exam-name">Exam Name (optional)</label>
            <input id="quick-exam-name" type="text">
            <label class="label" for="quick-duration">Duration (minutes)</label>
            <input id="quick-duration" type="number" min="5" max="480" value="60">
            <label class="label" for="quick-question">Question</label>
            <textarea id="quick-question" rows="3"></textarea>
            <label class="label" for="quick-model-answer">Model Answer</label>
            <textarea id="quick-model-answer" rows="2"></textarea>
            <label class="label" for="quick-urls">Allowed URLs (one per line, optional)</label>
            <textarea id="quick-urls" rows="2"></textarea>
            <div class="actions">
              <button id="quick-start-btn" type="button">Start Quick Session</button>
            </div>
          </div>

          <div id="quick-active-view" hidden>
            <div class="status-pill" id="quick-active-pill">QUICK SESSION LIVE</div>
            <dl class="diagnostics">
              <dt>Join code</dt><dd id="quick-active-code">—</dd>
              <dt>Candidates joined</dt><dd id="quick-active-count">0</dd>
            </dl>
            <div class="actions">
              <button id="quick-dashboard-btn" type="button">Open dashboard</button>
              <button id="quick-end-btn" class="secondary" type="button">End session</button>
            </div>
          </div>

          <p id="invigilator-notice" class="notice" role="status" aria-live="polite"></p>
        </div>

        <div id="student-panel" hidden>
          <div id="student-join-view">
            <label class="label" for="join-code-input">Session Code</label>
            <input id="join-code-input" type="text" placeholder="XXXX-XXXX-XXXX">
            <label class="label" for="join-student-id-input">Student ID</label>
            <input id="join-student-id-input" type="text">
            <label class="label" for="join-name-input">Full Name</label>
            <input id="join-name-input" type="text">
            <div class="actions">
              <button id="join-btn" type="button">Join</button>
            </div>
          </div>

          <div id="student-armed-view" hidden>
            <div id="popup-status" class="status-pill">Loading status</div>
            <dl class="diagnostics">
              <dt>Backend state</dt><dd id="backend-state">—</dd>
              <dt>Policy version</dt><dd id="policy-version">—</dd>
              <dt>Session</dt><dd id="session-id">—</dd>
              <dt>Allowed origins</dt><dd id="allowed-count">0</dd>
              <dt>Policy checked</dt><dd id="policy-checked">—</dd>
              <dt>Heartbeat</dt><dd id="heartbeat-at">—</dd>
              <dt>Managed trust</dt><dd id="managed-trust">No</dd>
            </dl>
            <button id="refresh-policy" type="button">Refresh authenticated policy</button>
          </div>

          <p id="student-notice" class="notice" role="status" aria-live="polite"></p>
        </div>
      </section>

      <p class="fine-print">
        This popup cannot disable lockdown once joined. Rules are removed only after the backend returns an authenticated release state.
      </p>
    </main>
    <script src="popup.js"></script>
  </body>
</html>
```

- [ ] **Step 4: Replace `extension/popup.js`**

```js
"use strict";

const el = (id) => document.getElementById(id);

function send(action, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ scope: "accessguard-popup", action, ...extra }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      if (!response?.ok) {
        const error = new Error(response?.error?.message || "Extension request failed");
        error.code = response?.error?.code;
        reject(error);
        return;
      }
      resolve(response.data);
    });
  });
}

function timeLabel(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleTimeString();
}

function getRole() {
  try {
    return localStorage.getItem("accessguardPopupRole") || "student";
  } catch {
    return "student";
  }
}

function setRole(role) {
  try {
    localStorage.setItem("accessguardPopupRole", role);
  } catch {
    // Best-effort; the role tab still renders for this popup lifetime.
  }
}

function renderCandidateStatus(status) {
  el("popup-status").textContent = String(status?.mode || "unknown").replaceAll("_", " ");
  el("popup-status").classList.toggle("danger", status?.mode === "locked" || status?.mode === "fail_closed");
  el("backend-state").textContent = status?.backendState || "—";
  el("policy-version").textContent = status?.policyVersion || "—";
  el("session-id").textContent = status?.sessionId || "—";
  el("allowed-count").textContent = String(status?.allowedOrigins?.length || 0);
  el("policy-checked").textContent = timeLabel(status?.lastPolicyAt);
  el("heartbeat-at").textContent = timeLabel(status?.lastHeartbeatAt);
  el("managed-trust").textContent = status?.managed ? "Yes" : "No";
}

let pollTimer = null;
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function renderInvigilatorPanel() {
  el("invigilator-notice").textContent = "";
  const control = await send("GET_CONTROL_STATUS");

  el("invigilator-session-bar").hidden = !control.invigilator.signedIn;
  el("invigilator-name").textContent = control.invigilator.signedIn
    ? `Signed in as ${control.invigilator.name || control.invigilator.invId}`
    : "";
  el("invigilator-login-view").hidden = control.invigilator.signedIn;
  el("quick-create-view").hidden = !control.invigilator.signedIn || control.quickSession.active;
  el("quick-active-view").hidden = !control.invigilator.signedIn || !control.quickSession.active;

  if (control.quickSession.active) {
    el("quick-active-code").textContent = control.quickSession.sessionCode || "—";
    el("quick-active-count").textContent = String(control.quickSession.candidateCount || 0);
    stopPolling();
    pollTimer = setInterval(async () => {
      try {
        const refreshed = await send("GET_CONTROL_STATUS");
        el("quick-active-count").textContent = String(refreshed.quickSession.candidateCount || 0);
        if (!refreshed.quickSession.active) await renderInvigilatorPanel();
      } catch {
        // A transient poll failure is not worth surfacing; the next tick retries.
      }
    }, 5000);
  } else {
    stopPolling();
  }

  return control;
}

async function renderStudentPanel() {
  el("student-notice").textContent = "";
  const status = await send("GET_STATUS");
  const armed = Boolean(status?.mode) && status.mode !== "inactive" && status.mode !== "available";
  el("student-join-view").hidden = armed;
  el("student-armed-view").hidden = !armed;
  if (armed) renderCandidateStatus(status);
}

async function renderRoleView() {
  const role = getRole();
  el("role-tab-invigilator").classList.toggle("active", role === "invigilator");
  el("role-tab-student").classList.toggle("active", role === "student");
  el("invigilator-panel").hidden = role !== "invigilator";
  el("student-panel").hidden = role !== "student";
  stopPolling();
  if (role === "invigilator") {
    await renderInvigilatorPanel();
  } else {
    await renderStudentPanel();
  }
}

async function init() {
  const deployment = await send("GET_DEPLOYMENT");
  el("setup-view").hidden = Boolean(deployment);
  el("role-view").hidden = !deployment;
  if (deployment) await renderRoleView();
}

el("setup-connect-btn").addEventListener("click", async () => {
  el("setup-notice").textContent = "Connecting…";
  el("setup-notice").className = "notice";
  try {
    await send("CONFIGURE_DEPLOYMENT", { appUrl: el("setup-app-url").value });
    await init();
  } catch (error) {
    el("setup-notice").textContent = error.message;
    el("setup-notice").className = "notice error";
  }
});

el("role-tab-invigilator").addEventListener("click", () => { setRole("invigilator"); void renderRoleView(); });
el("role-tab-student").addEventListener("click", () => { setRole("student"); void renderRoleView(); });

el("inv-login-btn").addEventListener("click", async () => {
  el("invigilator-notice").textContent = "Signing in…";
  el("invigilator-notice").className = "notice";
  try {
    await send("INVIGILATOR_LOGIN", {
      invId: el("inv-id-input").value,
      password: el("inv-password-input").value,
    });
    await renderInvigilatorPanel();
  } catch (error) {
    el("invigilator-notice").textContent = error.message;
    el("invigilator-notice").className = "notice error";
  }
});

el("inv-signout-btn").addEventListener("click", async () => {
  await send("INVIGILATOR_LOGOUT");
  await renderInvigilatorPanel();
});

el("quick-start-btn").addEventListener("click", async () => {
  el("invigilator-notice").textContent = "Starting quick session…";
  el("invigilator-notice").className = "notice";
  try {
    await send("CREATE_QUICK_SESSION", {
      examName: el("quick-exam-name").value,
      durationMinutes: el("quick-duration").value,
      questionText: el("quick-question").value,
      modelAnswer: el("quick-model-answer").value,
      whitelistedUrls: el("quick-urls").value.split("\n").map((line) => line.trim()).filter(Boolean),
    });
    el("invigilator-notice").textContent = "";
    await renderInvigilatorPanel();
  } catch (error) {
    el("invigilator-notice").textContent = error.message;
    el("invigilator-notice").className = "notice error";
  }
});

el("quick-end-btn").addEventListener("click", async () => {
  try {
    await send("END_QUICK_SESSION");
    await renderInvigilatorPanel();
  } catch (error) {
    el("invigilator-notice").textContent = error.message;
    el("invigilator-notice").className = "notice error";
  }
});

el("quick-dashboard-btn").addEventListener("click", async () => {
  const [deployment, control] = await Promise.all([send("GET_DEPLOYMENT"), send("GET_CONTROL_STATUS")]);
  if (deployment?.appOrigin && control?.quickSession?.sessionId) {
    chrome.tabs.create({ url: `${deployment.appOrigin}/sessions/${control.quickSession.sessionId}/dashboard` });
  }
});

el("join-btn").addEventListener("click", async () => {
  el("student-notice").textContent = "Joining…";
  el("student-notice").className = "notice";
  try {
    await send("EXTENSION_JOIN", {
      sessionCode: el("join-code-input").value,
      studentId: el("join-student-id-input").value,
      fullName: el("join-name-input").value,
    });
    await renderStudentPanel();
  } catch (error) {
    el("student-notice").textContent = error.message;
    el("student-notice").className = "notice error";
  }
});

el("refresh-policy").addEventListener("click", async () => {
  el("refresh-policy").disabled = true;
  try {
    renderCandidateStatus(await send("REFRESH_POLICY"));
  } catch (error) {
    el("student-notice").textContent = error.message;
    el("student-notice").className = "notice error";
  } finally {
    el("refresh-policy").disabled = false;
  }
});

void init();
```

- [ ] **Step 5: Update `extension/README.md`**

Add a new section after "## Web-page bridge protocol" documenting the popup-native flow:

```markdown
## Quick sessions from the popup (no backend session wizard)

The popup can create/join a session on its own, without a webpage ever calling
`ARM`. This is for ad hoc, low-stakes lockdowns — quick sessions always waive
identity verification and manual approval.

1. **Connect once.** If no server is configured (and no managed
   `trusted_app_origins`/`trusted_api_origins` pair is available to
   auto-detect), the popup asks for the AccessGuard app URL and validates it
   with the same trust rules as the webpage `ARM` flow.
2. **Invigilator.** Sign in with the same credentials as the web app. Start a
   quick session (name, duration, one question, optional allowed URLs); the
   popup shows the join code and a live candidate count, and can end the
   session at any time.
3. **Student.** Enter the join code, student ID, and full name. The extension
   joins the session, arms itself, and opens the exam page — identical
   enforcement to a webpage-driven `ARM`.

Invigilator and candidate credentials are stored under separate extension
storage keys and are never sent on the same request.
```

- [ ] **Step 6: Manual verification**

Since this UI has no automated DOM test, verify by hand:

1. `cd extension && npm test` — confirm every test file (including `manifest.test.mjs`, `rule-helpers.test.mjs`, `service-worker-smoke.test.mjs`, `quick-session.test.mjs`, `popup-control.test.mjs`) passes.
2. Load the extension unpacked (`chrome://extensions` → Developer mode → Load unpacked → `extension/`), open the popup: confirm the setup view asks for a server URL, and that connecting to a running local backend (`http://localhost:3000`) succeeds.
3. In the popup's Invigilator tab, sign in, submit the quick-create form with an empty question, and confirm it is rejected client-side with no network call (Review Focus item 5) before filling it in and starting a session; confirm the join code and a live candidate count appear.
4. In a second Chrome profile with the same extension, use the Student tab to join with that code; confirm a new tab opens on `/student/exam` and the lockdown enforces (attempting to navigate elsewhere redirects to the blocked page).
5. Back in the Invigilator tab, click "End session" and confirm the popup's quick session view returns to the create form.

- [ ] **Step 7: Commit**

```bash
git add extension/popup.html extension/popup.js extension/ui.css extension/manifest.json extension/package.json extension/README.md
git commit -m "feat(extension): add role-aware popup UI for quick sessions"
```

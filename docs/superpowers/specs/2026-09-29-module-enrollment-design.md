# Module Enrollment + Student Accounts — Design

## Problem

AccessGuard already lets an invigilator publish a "quick quiz" for a `module_code` string
(`SessionConfig.quiz_mode`/`module_code`/`published`), and a polling page
(`frontend/src/pages/QuizPrompt.jsx`) shows it if a student happens to have that exact page
open with the right URL query params. There is no durable notion of "this student is enrolled
in this module": `module_code` is free text typed into each session, students are identified
only by a `student_id` string with no password, and "informed" only works if the student
already has the right page open with the right params — there is nothing to check against, and
nobody a quiz-publish event could actually notify.

This is step one of three: give AccessGuard a real Module entity and a real student account
(unique ID + password) so a student can be durably "enrolled," which the next two sub-projects
(notification delivery, RAG grader hardening) build on.

## Goals

- An invigilator can create a Module they own (name, code, a secret enrollment code) and manage
  its roster (view, remove, reset a student's password).
- A student can self-register into a module using the module's enrollment code, choosing their
  own password; the same account (identified by `student_id`) is reused when they later enroll
  in a second module — no per-module duplicate accounts.
- A student can log in with `student_id` + password and see which modules they're enrolled in.
- Only enrolled students can see/join a module's published quick quizzes — the existing public,
  unauthenticated `by-module` lookup becomes an authenticated, enrollment-checked one.
- `CreateSession.jsx`'s free-text module field becomes a dropdown of modules the invigilator
  actually owns, so a quiz can't be published under a module that doesn't exist.

## Non-goals

- No change to the existing full-exam join flow (ID photos, liveness, face-match, manual
  approval) — that flow is untouched and remains the only way into a non-quiz session.
  Confirmed: password login is a **parallel, lighter path used only for `quiz_mode` sessions**.
- No self-service ("forgot password") email flow — there is no SMTP/email infrastructure in this
  codebase today. Password reset is invigilator-driven from the roster view.
- No push notifications, extension popup integration, or WebSocket "you've been notified" event
  in this sub-project — `StudentModules.jsx` still polls, the same way `QuizPrompt.jsx` does
  today. Real delivery beyond polling is the next sub-project.
- No changes to `rag_grader.py` or the grading pipeline — that's the third sub-project.
- No invigilator-side bulk roster import (CSV, etc.) — only self-registration via enrollment
  code, per the agreed enrollment flow.

## Data model

Three new Motor/Mongo collections, following the existing `db.<collection>` pattern already
used for `sessions`, `candidates`, `invigilators`, etc.

```python
# modules
{
    "id": str,              # uuid4
    "code": str,             # human label, e.g. "EE5206"; unique per owner, uppercased
    "name": str,
    "owner_inv_id": str,     # invigilators.inv_id
    "enroll_code": str,      # secret, e.g. 9-char token via secrets.token_hex(4)... formatted
    "created_at": str,       # now_iso()
}

# students
{
    "id": str,               # uuid4
    "student_id": str,       # unique globally, as typed by the student (e.g. "EG/2023/1042")
    "full_name": str,
    "password_hash": str,    # bcrypt via existing hash_pw()
    "created_at": str,
}

# enrollments
{
    "id": str,                # uuid4
    "student_id": str,        # students.student_id
    "module_id": str,         # modules.id
    "enrolled_at": str,
}
```

No index-creation pattern exists anywhere in this codebase today (no `create_index` calls), so
this introduces the first one: four `await db.<collection>.create_index(...)` calls added to
`lifespan` (server.py, right after the existing `await init_storage_async()` at line 817, before
the admin-invigilator seeding block) —
`modules.create_index([("owner_inv_id", 1), ("code", 1)], unique=True)`,
`modules.create_index("enroll_code", unique=True)`,
`students.create_index("student_id", unique=True)`, and
`enrollments.create_index([("student_id", 1), ("module_id", 1)], unique=True)`. These are
idempotent no-ops on every restart once created, same as Mongo's normal `create_index` behavior.

## Backend API changes

New Pydantic models: `ModuleCreateIn {code, name}`, `StudentJoinModuleIn {enroll_code,
student_id, full_name, password}`, `StudentLoginIn {student_id, password}`,
`ResetStudentPasswordOut {student_id, temp_password}`.

New `current_student` dependency, mirroring `current_invigilator` at server.py:610 but requiring
`role == "student"` from the decoded JWT (reuses `make_token`/`JWT_SECRET`/`JWT_ALGORITHM`
unchanged — just a new `role` value).

Endpoints (all under the existing `api` router):

- `POST /modules` (invigilator auth) — creates a module owned by the caller; generates
  `enroll_code` server-side (not client-supplied); rejects duplicate `code` for that owner.
- `GET /modules` (invigilator auth) — lists the caller's modules with their `enroll_code` (only
  the owner ever sees it).
- `GET /modules/{id}/students` (invigilator auth, must own the module) — roster: joins
  `enrollments` → `students`, returns `student_id`, `full_name`, `enrolled_at` (never
  `password_hash`).
- `DELETE /modules/{id}/students/{student_id}` (invigilator auth, must own) — removes that one
  enrollment row; does not delete the student's account (they may be enrolled elsewhere).
- `POST /modules/{id}/students/{student_id}/reset-password` (invigilator auth, must own) —
  generates a new random password, updates `password_hash`, returns the plaintext once in the
  response body (never stored or logged in plaintext).
- `POST /student/auth/join` (public) — body `StudentJoinModuleIn`. Looks up the module by
  `enroll_code`; 404 if none matches. If `students.student_id` doesn't exist yet, creates the
  account with the given `full_name`/`password`. If it exists, verifies `password` with
  `verify_pw` (401 on mismatch) and ignores the supplied `full_name`. Either way, upserts the
  `enrollments` row (idempotent — re-using a code you're already enrolled under just logs you
  in). Returns `TokenOut`-shaped `{token, student_id, full_name}` with `role="student"` baked
  into the JWT.
- `POST /student/auth/login` (public) — plain `student_id` + `password` check, same token shape.
  401 on any mismatch (don't distinguish "no such student" from "wrong password").
- `GET /student/me` (student auth) — profile plus the list of enrolled modules (`code`, `name`).
- `GET /student/modules/{code}/quizzes` (student auth) — replaces the authorization-less
  `GET /public/quizzes/module/{module_code}` for this flow: 403 if the caller has no enrollment
  row for a module with that `code`; otherwise same query/shape as today's endpoint (published,
  `quiz_mode: true` sessions for that module code, projected the same way). The old
  `/public/quizzes/module/{code}` endpoint is left in place unchanged for now — nothing else
  currently depends on removing it, and deleting it is out of scope here.

## Frontend changes

- New `frontend/src/lib/moduleAuth.js` — a small token-storage helper for the module-account JWT
  (`get/save/clearModuleToken`, `get/saveModuleProfile`). This is a **separate** concern from
  `frontend/src/lib/studentSession.js`, which stores the ephemeral per-exam-attempt candidate
  token/answers/breach-count for a single sitting; the module JWT is a longer-lived (12h),
  reusable-across-logins credential for the enrollment/roster flow and is never mixed into
  `studentSession.js`'s keys. It follows the same dual sessionStorage+localStorage read/write
  pattern already used there, but as its own file with its own storage keys.
- New `frontend/src/pages/ModuleEnroll.jsx` (route `/enroll`) — one form: enrollment code,
  student ID, full name (only required/shown once account doesn't exist yet — simplest v1:
  always show it, backend ignores it for an existing account), password. Submits to
  `/student/auth/join`, stores the returned token via `moduleAuth.js`, then navigates to
  `/student/modules`.
- New `frontend/src/pages/StudentModules.jsx` (route `/student/modules`, replaces the polling
  role `QuizPrompt.jsx` played) — requires a stored student token (redirect to `/enroll` if
  none); lists enrolled modules from `GET /student/me`; for each, polls
  `GET /student/modules/{code}/quizzes` every 8s (same interval `QuizPrompt.jsx` uses today) and
  renders any published quiz with a "Join Quiz" button, reusing the toast/Notification-API
  pattern already in `QuizPrompt.jsx`. `QuizPrompt.jsx` itself is left in place unchanged (it's
  still reachable by URL for any existing embeds) — not part of this sub-project's scope to
  migrate or delete.
- New `frontend/src/pages/ManageModules.jsx` (route under the invigilator dashboard) — create a
  module (code, name), see the list with each `enroll_code` (copyable), click into a roster view
  showing enrolled students with "remove" and "reset password" actions (reset shows the new
  temp password once, in a dismissable panel — mirrors how a join/session code is already shown
  after session creation elsewhere in the app).
- `frontend/src/pages/CreateSession.jsx`: the free-text `module_code` input (currently a plain
  `<input>` around line 355) becomes a `<select>` populated from `GET /modules`, storing the
  selected module's `code`. If the invigilator has no modules yet, show a short "Create a module
  first" link to `/manage-modules` instead of a disabled dropdown.
- `frontend/src/App.js` gains the three new routes (`/enroll`, `/student/modules`,
  `/manage-modules`); `frontend/src/App.test.jsx` gains coverage that each route renders.

## Error handling

- Wrong `enroll_code` on `/student/auth/join`: 404, generic "Invalid enrollment code" (don't
  leak which modules exist).
- Existing `student_id` + wrong password on `/student/auth/join` or `/student/auth/login`: 401,
  generic "Invalid credentials" — same non-distinguishing pattern the invigilator login already
  uses (server.py:866-868).
- Re-submitting `/student/auth/join` with a code for a module the student is already enrolled
  in: treated as a login, 200, not an error — enrolling twice is a no-op, not a failure.
  `GET /student/modules/{code}/quizzes` for a module the caller isn't enrolled in: 403, not 404
  (the module exists; they just can't see into it).
- Duplicate module `code` for the same owner on `POST /modules`: 409.
- All new endpoints validate the bearer token's `role` claim (`student` vs `invigilator`)
  exactly like `current_invigilator` does today — a student token can't call invigilator-only
  endpoints and vice versa, returning 401/403 consistent with the existing dependency's behavior.

## Testing

- Backend: new `backend/tests/test_module_enrollment.py` (Mongo-free where possible, following
  the pattern of `backend/tests/test_lockdown_helpers.py` used by the sibling quick-lockdown
  work) covering: module creation/duplicate-code rejection, join-creates-new-account,
  join-with-existing-account-verifies-password, join-with-wrong-password rejection,
  cross-module isolation (a student enrolled in module A gets 403 querying module B's quizzes),
  roster list/remove/reset-password, and `current_student` rejecting an invigilator token and
  vice versa.
- Frontend: `ModuleEnroll.test.jsx`, `StudentModules.test.jsx`, `ManageModules.test.jsx` — one
  happy-path render/submit test each, following existing page test conventions in
  `frontend/src/pages/*.test.jsx`.

## Open items deferred to later sub-projects

- Actual "informed" delivery beyond client-side polling (sub-project 2).
- Extension popup awareness of module enrollment (sub-project 2).
- RAG grader hardening / production checklist (sub-project 3).

# Extension Quick Lockdown — Design

## Problem

AccessGuard's lockdown enforcement (DNR rules, tab redirect, blocked page, heartbeat) already
works, but *starting* it requires a full flow: an invigilator builds a session through the
5-step wizard, and every student uploads ID photos, a selfie, and passes a liveness/face-match
check before the extension ever arms. Invigilators want a lighter-weight path they can use
ad hoc, in-class, without the identity-verification overhead — the extension acting as a small,
self-serve "safe exam browser" for occasional low-stakes lockdowns, not just the fully verified
formal-exam flow.

## Goals

- Invigilator can create, start, and end a "quick session" — minimal setup, no identity
  verification, auto-approved candidates — from **either** the existing web app **or** the
  extension popup.
- A student who has the extension installed can join a quick session **directly from the
  extension popup** (join code + student ID + name), without first visiting the web app's
  entry/verification pages.
- Once joined, enforcement is identical to today's flow: DNR rules, tab redirect, heartbeat,
  fail-closed on backend outage, release only via an authenticated backend policy change.
- No new "unlock" capability is introduced anywhere (extension, popup, or web).

## Non-goals

- No offline/local-only pairing between extension instances (this always requires the backend
  to be reachable).
- No new quiz-taking UI inside the extension — the extension opens the existing
  `/student/exam` web page for questions/timer/submit.
- No roster/report/grading UI duplicated inside the popup — that stays on the web dashboard.
- No change to the release/unlock invariant: only an authenticated backend policy response
  (or a terminal candidate state) removes enforcement.

## Backend changes (shared by both entry points)

These three changes are used by both the web "Quick Lockdown" page and the extension's
student-join flow, since both ultimately call the same public endpoints.

1. `SessionConfig` gains `require_identity_verification: bool = True`. `create_session` persists
   it like any other config field; no other behavior changes for existing sessions (default
   `True` preserves current behavior).
2. `/public/candidates/join` (`CandidateJoinIn`): `id_front_b64`, `id_back_b64`, `selfie_b64`
   become `Optional[str] = None`. When the owning session has
   `require_identity_verification is False`, the endpoint skips the image-upload branch for
   absent fields (stores `None` URLs) and defaults `liveness_passed=True`,
   `face_match_score=1.0` for that candidate. When the session's `require_manual_approval`
   is `False` (this field already exists in `SessionConfig` but is currently unused), the
   endpoint sets the candidate's initial `status` to `"approved"` and stamps `approved_at`
   instead of `"pending"` — mirroring exactly what `/sessions/{sid}/candidates/decision`
   already does for a manual approval, so no other code path needs to change.
3. `/public/sessions/by-code/{code}` response gains `require_identity_verification`.
   `require_manual_approval` is **not** exposed here — approval behavior is decided
   server-side at join time; the client only needs to know whether to show/collect
   verification media.

No new backend endpoints. Session creation, start, and end continue to use the existing
`POST /sessions`, `POST /sessions/{id}/start`, `POST /sessions/{id}/end`. Invigilator auth
continues to use the existing `POST /auth/login`.

## Web app changes

- `StudentEntry.jsx`: after resolving the session by code, if `require_identity_verification
  === false`, call `/public/candidates/join` directly (student_id + full_name only, no
  ID/selfie fields) and navigate straight to `/student/exam`, skipping `/student/verify`.
  Existing sessions (`require_identity_verification` defaults `true`) are unaffected.
- `Sessions.jsx`: new "Quick Lockdown" button alongside "Distribute Quiz" / "Create New
  Session", opening a new route.
- New page `QuickLockdown.jsx` (route `/sessions/quick`): one screen — exam name (defaulted),
  duration, one question + model answer, optional URL whitelist. On submit: `POST /sessions`
  with `require_identity_verification: false`, `require_manual_approval: false`,
  `auto_record_webcam: false`, `save_screen_share: false`, then `POST /sessions/{id}/start`;
  shows the resulting join code and a link to the live dashboard.

## Extension changes

### Server configuration (one-time, per install)

The extension currently only learns the backend's API origin from a webpage's `ARM` message.
Both new popup flows (invigilator login, student join) need to reach the backend with no
webpage involved, so the extension needs a configured "home" deployment.

- New storage key (separate from per-candidate runtime and from any invigilator/candidate
  token) holding `{ appOrigin, apiBase }` for the configured deployment.
- If a managed policy already provides `trusted_app_origins`/`trusted_api_origins`
  (`managed-policy-schema.json`, existing mechanism), the popup pre-fills from the first
  configured pair and skips prompting.
- Otherwise, first popup open prompts for one field: the AccessGuard app URL. The service
  worker derives the API base the same way the web bridge does today and validates the
  resulting `(appOrigin, apiBase)` pair with the **existing** `validateBootstrapTrust` logic
  in `service-worker.js` (same-origin, loopback-pair, or explicitly trusted) — no new trust
  logic, just a new caller of the existing function.
- A "change server" action in the popup clears this and re-prompts; it must not be reachable
  while a candidate is currently armed on that device (avoids retargeting an active lockdown).

### Popup: role switcher

Two roles, remembered as a `chrome.storage.local` preference (not a security boundary — either
can be selected any time; the roles differ only in which token/flow they use):

**Invigilator**
- Not signed in: email + password → service worker calls `POST {apiBase}/auth/login`, stores
  the returned bearer token under a dedicated `invigilatorAuth` storage key (never mixed with
  a candidate's `candidateToken`).
- Signed in, no quick session active: minimal create form (name, duration, one question +
  model answer, optional whitelist) → service worker calls `POST /sessions` (quick defaults
  per the backend section above) then `POST /sessions/{id}/start`.
- Signed in, quick session active (tracked via a stored `activeQuickSessionId`): shows the
  join code, a candidate count polled every few seconds via `GET /sessions/{id}/candidates`,
  an "Open dashboard" button (`{appOrigin}/sessions/{id}/dashboard` in a new tab), and "End
  session" (`POST /sessions/{id}/end`).
- "Sign out" clears only `invigilatorAuth` and `activeQuickSessionId`.

**Join as student**
- Form: join code, student ID, full name → single "Join" action.
- Already armed on this device: popup shows the existing diagnostics view instead of the join
  form (a device can only be armed for one candidate at a time, same as today).

### Popup → service worker → backend (student join)

New message action (e.g. `EXTENSION_JOIN`) carries `{ sessionCode, studentId, fullName }`. The
service worker:

1. `GET {apiBase}/public/sessions/by-code/{sessionCode}`.
2. `POST {apiBase}/public/candidates/join` with the minimal fields.
3. Reuses the refactored core of today's `ARM` handler (see below) with the returned
   `candidateId`/`candidateToken`/the configured `appOrigin`/`apiBase` to persist runtime state
   and start enforcement — identical DNR/heartbeat/fail-closed behavior to a webpage-driven
   `ARM`.
4. Opens/focuses a tab at the session's exam URL.

### Internal refactor

`service-worker.js`'s `ARM` handling (validate bootstrap trust → fetch policy → persist runtime
→ start enforcement/heartbeat) is factored into a function with two callers: the existing
`content-bridge.js` message path (webpage-initiated, unchanged behavior/contract) and the new
popup-initiated join path. This is a refactor of existing logic, not new security logic — same
validation, same fail-closed behavior, same "no direct unlock" invariant.

### What does not change

- DNR rule compilation, tab redirect/restore, blocked page, heartbeat cadence, fail-closed
  behavior, and the release invariant (authenticated backend state only) are untouched.
- The web bridge protocol (`AG_LOCKDOWN_REQUEST`/`RESPONSE`/`EVENT`) is untouched; this adds a
  second, independent way to reach the same enforcement core, not a change to the first.

## Data/storage summary

| Storage key | Holds | Written by | Read by |
|---|---|---|---|
| existing `RUNTIME_STORAGE_KEY` | armed candidate runtime (unchanged) | ARM handler | enforcement, popup diagnostics |
| new `accessguardDeployment` | `{ appOrigin, apiBase }` | server-config step | invigilator login, student join |
| new `accessguardInvigilatorAuth` | bearer token, inv_id, name | invigilator login | quick-session create/end/status calls |
| new `accessguardActiveQuickSession` | session id + join code | quick-session create | popup quick-session panel |

## Security notes

- Invigilator and candidate tokens are stored under distinct keys and never sent together on
  any request.
- The student-join path does not bypass the extension's existing trust checks — it validates
  the same `(appOrigin, apiBase)` pair the webpage flow validates, just sourced from the
  one-time server configuration instead of a postMessage payload.
- Auto-approval and skipped verification are session-level flags set by the invigilator at
  creation time (`require_identity_verification`, `require_manual_approval`), not something a
  student or a compromised popup can request — the backend, not the client, decides whether a
  given session requires those steps.

## Testing plan

- Backend: unit tests for `require_identity_verification` on `by-code`, optional
  ID/selfie/liveness fields on join, and auto-approve when `require_manual_approval` is
  `False`.
- Extension: `service-worker-smoke.test.mjs` coverage for the new popup message actions
  (server-config validation, invigilator login/create/end, student join-and-arm) using the
  same fetch-mocking pattern already used for policy/heartbeat tests; `rule-helpers.test.mjs`
  unaffected (no DNR rule changes).
- Web: `StudentEntry.test.jsx`-style test for the skip-verification branch; new test for
  `QuickLockdown.jsx` covering create → start → code display.

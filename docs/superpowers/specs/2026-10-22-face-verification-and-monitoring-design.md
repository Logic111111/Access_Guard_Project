# Face Verification, Liveness and Exam Face Monitoring — Design

## Problem

Identity checks in AccessGuard cannot currently be trusted:

- Liveness only counts blinks, so a replayed video passes. The face that
  blinks is never compared with the selfie that is matched to the ID, so a
  photo can be used for the selfie and a real person for the blinks.
- A student who denies camera access "bypasses" liveness and is reported to
  the backend as `liveness_passed: true` (`StudentVerify.jsx`). The backend
  also defaults `liveness_passed` to `true` when it is omitted.
- If the face models fail to load, or matching throws, the student is given a
  0.5 score that the page renders as "VERIFIED".
- During the exam no face detection runs at all. `face_visible` is just
  "camera is streaming and the tab is visible" (`StudentExam.jsx`), so
  `face_lost` and second-person events are never raised.
- Face models are fetched at runtime from a third-party GitHub Pages site.

The invigilator dashboard has related gaps: a dead "view" button on live
tiles, an "Avg Heartbeat" KPI that is always 0 ms, and no way to see a
student's ID photos and check results before approving them.

## Goals

1. Liveness that a printed photo or a simple video replay cannot pass, and
   that proves the matched selfie belongs to the live person.
2. Face matching that never reports a failure as success, uses one pass mark
   everywhere, and is more stable than a single-frame comparison.
3. Real face monitoring during the exam: no face, multiple faces, and a
   different person are detected and recorded.
4. Invigilators see clear "Verified" / "Needs review" status with evidence
   and decide.
5. Fix the bugs listed below and improve the UI of the verification flow,
   invigilator dashboard, student exam page and extension popup.

## Decisions (agreed with the project owner, 2026-10-22)

| Question | Decision |
|---|---|
| Failed liveness or face match at join | Student may still join; the attempt is flagged **Needs review** with reasons; the invigilator decides. |
| No face / second person during the exam | Record a violation (after a grace period) and show it live. **Do not auto-lock.** |
| Face model files | Bundle in the app (`frontend/public/models`, ~7 MB). |
| UI focus | Verification flow, invigilator dashboard, student exam page, extension popup. |

## Approach

Client-side challenge–response liveness and matching with the existing
`face-api.js` dependency, backed by invigilator review with photo evidence.

Rejected alternatives:

- **Server-side face verification** (Python face libraries on Railway):
  harder to tamper with, but adds 100+ MB of native dependencies and heavy CPU
  load on a free-tier container.
- **Paid liveness service** (AWS / Azure): strongest anti-spoofing, but costs
  money, needs cloud accounts, and sends student biometrics to a third party.

Known limitation: all checks run in the student's browser, so a determined
attacker could tamper with the JavaScript. The backend therefore never trusts
a client-supplied "verified" label (it derives the status from the raw
results) and the invigilator approval step plus evidence snapshots remain the
final control.

## Components

### 1. Face engine — `frontend/src/lib/faceEngine.js` (new)

Thin wrapper around `face-api.js`; the only module that touches the library.

- `loadFaceModels()` — loads `tinyFaceDetector`, `faceLandmark68Net`,
  `faceRecognitionNet` from `${PUBLIC_URL}/models`, memoised. Resolves `true`
  or `false`; never throws. A failed load is retried on the next call.
- `detectFaces(input, { inputSize })` — all faces with landmarks.
- `describeFace(input, { inputSize })` — the single largest face with
  landmarks and a 128-d descriptor, or `null`.
- Video: `inputSize` 224. Still images (ID card, selfie): 608 with
  `scoreThreshold` 0.3, picking the largest face (ID card faces are small).

The weight files (`tiny_face_detector_model*`, `face_landmark_68_model*`,
`face_recognition_model*`) are copied into `frontend/public/models` from the
face-api.js 0.22.2 repository `weights/` folder.

### 2. Face checks — `frontend/src/lib/faceChecks.js` (new, pure, unit tested)

No DOM, camera or face-api imports — plain landmark/number inputs.

**Matching**

- `matchFromDistance(d)` → `{ score, status }`
  - `score = clamp(1 - d / 1.2, 0, 1)` — distance 0.6 (face-api's standard
    same-person threshold) maps to exactly 50%.
  - `status`: `strong` when `d ≤ 0.5`, `match` when `d ≤ 0.6`, otherwise
    `no_match`.
- `MATCH_PASS_SCORE = 0.5` — the single pass mark used by the verification
  page, the dashboard and the backend.
- `averageDescriptor(descriptors)` — element-wise mean.

**Blink detection**

- `eyeAspectRatio(eyePoints)` — standard EAR from the 6 eye landmarks.
- `createBlinkDetector()` — calibrates a personal open-eye baseline from the
  median EAR of the first 8 samples; an eye is *closed* below
  `0.75 × baseline` and a blink is counted when it reopens above
  `0.9 × baseline`. Replaces the fixed 0.25 threshold.

**Head turns**

- `yawRatio(landmarks)` — `(noseTip.x − eyeMidpoint.x) / interocularDistance`
  on the un-mirrored camera frame. A student turning to **their left** moves
  the nose toward the image's right, so `ratio > +0.25` means "turned left"
  and `ratio < −0.25` means "turned right". A turn must hold for 3
  consecutive samples. `|ratio| < 0.1` counts as frontal.

**Liveness challenge**

- `createLivenessChallenge({ random })` → a state machine over the three
  actions `blink`, `turn_left`, `turn_right` in a random order.
- `step(sample)` takes `{ faceCount, landmarks, descriptor?, now }` and
  returns the state: `calibrating | active | passed | failed`, the current
  action, completed actions, and a `hint`.
- Rules:
  - Each action must be completed within 8 s; the whole check within 30 s.
  - `faceCount ≥ 2` on any sample → `failed` (`multiple_faces`).
  - `faceCount = 0` for more than 1.5 s → hint "Face the camera" (the action
    timer keeps running).
  - Identity continuity: a frontal descriptor captured at the start and at
    the end must be within distance 0.5 of each other, otherwise `failed`
    (`face_changed`).
- Hints: `no_face`, `too_far` (face box narrower than 20% of the frame),
  `multiple_faces`, `hold_still`, `do_action`.

**Exam monitoring**

- `createExamFaceMonitor()` with `next(sample, now)` returning events to
  report. Samples are `{ faceCount, distance? }`.
  - `face_lost` — no face continuously for ≥ 10 s; once per absence episode.
  - `multiple_faces` — `faceCount ≥ 2` on 2 consecutive samples; once per
    episode (episode ends after 2 consecutive samples with ≤ 1 face).
  - `identity_mismatch` — `distance > 0.6` on 2 consecutive identity checks;
    once per episode.
  - `faceVisible` — whether the latest sample saw at least one face.

**Name check**

- `nameMatchesText(fullName, ocrText)` — every name token of 2+ letters
  (case- and punctuation-insensitive) appears in the OCR text. Empty name →
  `false`. Informational only.

### 3. Verification page — `frontend/src/pages/StudentVerify.jsx` (rewritten)

Four steps: **ID front → ID back → Face check → Review & join**.

- **ID photos**: images are downscaled in the browser to at most 1280 px
  (JPEG 0.8) before upload. On ID-front upload: OCR (existing Tesseract) and
  face detection run; the page shows the detected ID face crop, or a warning
  "No face found on this ID photo — retake, or continue and your attempt will
  need invigilator review" (flag `no_face_in_id`).
- **Face check** (replaces the separate Selfie and Liveness steps): live
  video with an oval face guide and a live hint line; the three actions are
  listed with ticks, the current action shown large ("Turn your head to your
  LEFT") with a per-action countdown bar. Detection runs in a sequential loop
  (next frame only after the previous detection finishes — no overlapping
  `setInterval` work).
  - During the check the page keeps the best frontal frame (highest detection
    score, `|yaw| < 0.1`) as the **selfie** (max 480 px, JPEG 0.75), averages
    up to 3 frontal descriptors as the **live descriptor**, and captures one
    small evidence frame per completed action (240 px wide, JPEG 0.6).
  - On failure the reason is shown with **Try again** (new random order) and
    **Continue anyway**, which records `liveness_passed: false` with flag
    `liveness_failed` plus the specific reason (`multiple_faces` or
    `face_changed`) when there is one.
  - Camera unavailable or denied: explanation, plus **Continue without camera**
    which records `liveness_passed: false` and flag `camera_unavailable`.
  - If no usable frontal frame was captured, the selfie is missing and the
    flag `no_face_in_selfie` is set (score `null`).
  - The camera is stopped when leaving this step and when the page unmounts.
- **Review & join**: ID face and selfie side by side with the match ring,
  liveness result, name check, and a banner — **Verified** or **Will need
  invigilator review** with the reasons. The match is recomputed whenever the
  ID photo or selfie changes (no stale score). A score below
  `MATCH_PASS_SCORE` adds flag `face_mismatch`; an unreadable OCR name adds
  `name_unconfirmed`. Model failure → match "Unverified" (`score: null`,
  flag `models_unavailable`), never shown as verified.
- On submit, the live descriptor is stored locally with the attempt
  (`ag_face_descriptor`, removed by `clearStudentAttempt`) for exam-time
  identity checks. It is never sent to the server.
- Step indicator collapses to numbers on narrow screens.

### 4. Exam face monitoring — `frontend/src/pages/StudentExam.jsx`

A `useExamFaceMonitor(videoRef, streaming)` hook (new file
`frontend/src/lib/useExamFaceMonitor.js`):

- Loads models lazily once the camera is streaming; failure disables the
  monitor (heartbeat note `face-check-unavailable`) without affecting the
  exam.
- Every 3 s: counts faces on the video (`inputSize` 224). Every 5th sample,
  when exactly one face is present and a stored descriptor exists, computes
  the distance to it.
- Feeds `createExamFaceMonitor` and reports its events through the existing
  `reportViolation` (so grace periods and "leaving" suppression still apply).
- Heartbeat `face_visible` becomes the real latest result.
- Heartbeat `latency_ms` becomes the measured round-trip time of the previous
  heartbeat request.
- UI: a face status chip next to the timer — **Face OK**, **No face**,
  **Multiple faces**, **Face check off** — and a matching coloured ring on the
  webcam preview.

### 5. Backend — `backend/server.py`

`StudentJoinIn`:

| Field | Change |
|---|---|
| `liveness_passed` | default `False` (was `True`) |
| `face_match_score` | `Optional[float] = None`, validated to 0–1 |
| `verification_flags` | new, `List[str]`; unknown values dropped |
| `liveness_frames_b64` | new, `List[str]`, at most 3 |

Allowed flags: `camera_unavailable`, `liveness_failed`, `multiple_faces`,
`face_changed`, `no_face_in_id`, `no_face_in_selfie`, `face_mismatch`,
`models_unavailable`, `name_unconfirmed`. `name_unconfirmed` is
informational; every other flag requires review.

- New pure function `assess_verification(liveness_passed, face_match_score,
  flags) -> "verified" | "needs_review"`: `verified` only when liveness
  passed, the score is present and `≥ 0.5`, and no review-requiring flag is
  set. The candidate document stores `verification_status`,
  `verification_flags` and `liveness_frame_urls` (stored like the other
  images).
- Size limits (HTTP 413 with a clear message): each ID image and the selfie
  ≤ 2 MB as a data URL; each liveness frame ≤ 100 KB.
- `GET /sessions/{sid}/candidates` additionally excludes
  `liveness_frame_urls` (the list is polled; images are fetched on demand).
- New `GET /sessions/{sid}/candidates/{cid}/evidence` (session owner only):
  ID front/back, selfie, liveness frames, `liveness_passed`,
  `face_match_score`, `verification_status`, `verification_flags`, and the
  candidate's violations.
- Violations: add **non-locking** kinds `multiple_faces` and
  `identity_mismatch`. `face_lost` stays non-locking. `unauthorized_person`
  keeps its current locking behaviour and is not used by the monitor.

### 6. Invigilator dashboard — `frontend/src/pages/SessionDashboard.jsx`

- Pending cards: **Verified** (green) or **Needs review** (amber) badge with
  short reasons from the flags; match shown as a percentage, or
  "Unverified" when there is no score.
- New `frontend/src/components/CandidateEvidencePanel.jsx` (side sheet using
  the existing `components/ui` primitives): ID front/back, selfie, liveness
  frames, check results, violations timeline, and Approve / Reject buttons
  for pending students. Opened by clicking a pending card or the eye button on
  a live tile (currently a dead button).
- Live tiles: face status from the latest heartbeat; labels for the new
  violation kinds.
- "Avg Heartbeat" uses the real round-trip times.
- Delete Session uses the `Trash2` icon like the other buttons.

### 7. Extension popup — `extension/popup.js`, `popup.html`, `ui.css`

- A `runWithBusy(button, label, fn)` helper disables the clicked button and
  shows a progress label while its request runs (sign in, start / end quick
  session, create module, enroll, student sign-in, join). Fixes double
  submission (e.g. two quick sessions from a double click).
- Notices: consistent success / error / info styles; a new action clears the
  previous notice.
- Header line showing the connected server host and the signed-in name.
- Empty state for the module list ("No modules yet").

## Bug list

| # | Bug | Fix |
|---|---|---|
| B1 | No camera → liveness reported as passed | §3, §5 |
| B2 | Model load failure / match error → 0.5 shown as VERIFIED | §2, §3 |
| B3 | Retaking the selfie keeps the old match score | §3 |
| B4 | Camera stays on after leaving the verification steps or page | §3 |
| B5 | Liveness stuck "Detecting…" when the video is missing; overlapping async detections | §3 |
| B6 | Empty name makes the name check "MATCH" | §2 |
| B7 | Inconsistent pass marks (45% vs 50%) | §2 |
| B8 | Backend defaults `liveness_passed` to `true` | §5 |
| B9 | Dashboard shows NaN / 0% for a missing score | §6 |
| B10 | "Avg Heartbeat" always 0 ms | §4, §6 |
| B11 | Live tile eye button does nothing | §6 |
| B12 | `test_accessguard.py` breaks the backend run when `REACT_APP_BACKEND_URL` is unset | skip the module when unset |
| B13 | Extension popup double submission | §7 |
| B14 | Candidate list polls ship full-size images | §3 (downscaling), §5 |
| B15 | Join accepts unbounded image sizes | §3, §5 |
| B16 | `face_visible` is not a face check | §4 |

Bugs found while implementing are added to this list and fixed the same way.

## Error handling

- Face models unavailable at join: verification continues; match is
  "Unverified" with flag `models_unavailable`; the attempt needs review.
- Face models unavailable during the exam: monitoring is off, the chip shows
  "Face check off", the heartbeat note tells the invigilator; the exam is not
  blocked.
- Camera denied at join: `camera_unavailable`, needs review. Camera denied
  during the exam: existing warning toast and heartbeat behaviour.
- Oversized images: 413 with a message the student sees; the client
  downscaling makes this rare.

## Testing

- **Jest, pure logic** (`faceChecks.test.js`): EAR; blink detector with
  narrow-eye and wide-eye baselines; yaw ratio and turn direction from
  synthetic landmarks; challenge state machine (random order, per-action and
  overall timeouts, multiple faces, face changed, pass); `matchFromDistance`
  boundaries; exam monitor episodes (10 s grace, two consecutive samples, once
  per episode); `nameMatchesText`.
- **Jest, components** (face engine mocked): camera-unavailable path submits
  `liveness_passed: false` with `camera_unavailable`; model failure shows
  "Unverified"; dashboard renders Verified / Needs review badges and the eye
  button opens the evidence panel.
- **Pytest**: `assess_verification` cases; join stores status / flags and
  enforces size limits; new violation kinds accepted and non-locking; evidence
  endpoint allows only the session owner.
- **Extension (node --test)**: `runWithBusy` disables and re-enables the
  button, including on error.
- **Manual (owner, real camera)**: pass with a real face; fail with a printed
  photo and with a phone video held to the camera; second person in view
  during liveness and during the exam; looking away > 10 s during the exam;
  model files served from the Vercel site.

## Out of scope

- Server-side face verification and passive anti-spoofing (screen-replay
  texture detection).
- Audio monitoring.
- Deployment configuration (e.g. `ENVIRONMENT=production` on Railway).
- Merging teammates' changes from `origin/main`. Note: `main` has comment-only
  edits to `StudentVerify.jsx`, `StudentExam.jsx` and `StudentEntry.jsx`, so a
  later merge of `pasi` into `main` will need small conflict resolution.

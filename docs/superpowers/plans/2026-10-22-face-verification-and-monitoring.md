# Face Verification, Liveness and Exam Face Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trustworthy join-time identity checks (challenge liveness + face match tied to the live face), real face monitoring during exams, invigilator review with evidence, and the bug/UI fixes listed in the spec.

**Architecture:** All face work runs in the browser through one wrapper (`faceEngine.js`) over the existing `face-api.js`; every decision rule lives in a pure module (`faceChecks.js`) so it is unit tested without a camera. The backend never trusts a client "verified" label — it derives `verification_status` from raw results — and exposes evidence to the session owner only.

**Tech Stack:** React 19 (CRA + craco, Jest + Testing Library), face-api.js 0.22.2, FastAPI + Motor (pytest), Chrome MV3 extension (vanilla JS, `node --test`).

**Spec:** `docs/superpowers/specs/2026-10-22-face-verification-and-monitoring-design.md`

## Global Constraints

- Work on branch `pasi` in `D:\Access Guard`. Commit messages carry **no** `Co-Authored-By` / AI attribution trailer. Never push to `main`.
- `MATCH_PASS_SCORE = 0.5` everywhere (frontend, dashboard, backend). `score = clamp(1 - d / 1.2, 0, 1)`; status `strong` if `d ≤ 0.5`, `match` if `d ≤ 0.6`, else `no_match`.
- Blink: baseline = median EAR of first 8 samples; closed below `0.75 × baseline`; blink counted on reopening above `0.9 × baseline`.
- Head turn: `yawRatio = (noseTip.x − eyeMidpoint.x) / interocularDistance` on un-mirrored frames; `> +0.25` = turned **left** (student's left), `< −0.25` = turned **right**; must hold 3 consecutive samples; `|ratio| < 0.1` = frontal.
- Liveness: actions `blink`, `turn_left`, `turn_right` in random order; 8 s per action; 30 s total; any sample with `faceCount ≥ 2` fails (`multiple_faces`); no face > 1.5 s → hint `no_face`; start/end frontal descriptors must be within distance 0.5 or fail (`face_changed`). Hints: `no_face`, `too_far` (face box < 20% of frame width), `multiple_faces`, `hold_still`, `do_action`.
- Exam monitor: sample every 3 s (video `inputSize` 224); identity distance every 5th sample when exactly one face and a stored descriptor exist; `face_lost` after ≥ 10 s with no face; `multiple_faces` / `identity_mismatch` (distance > 0.6) after 2 consecutive samples; each once per episode.
- Detector settings: video `inputSize` 224, `scoreThreshold` 0.4; still images `inputSize` 608, `scoreThreshold` 0.3, largest face wins.
- Images: ID photos ≤ 1280 px JPEG 0.8; selfie ≤ 480 px JPEG 0.75; evidence frames 240 px wide JPEG 0.6, at most 3. Backend rejects (HTTP 413) ID/selfie data URLs > 2 MB and frames > 100 KB.
- Verification flags (exact set): `camera_unavailable`, `liveness_failed`, `multiple_faces`, `face_changed`, `no_face_in_id`, `no_face_in_selfie`, `face_mismatch`, `models_unavailable`, `name_unconfirmed` (informational only).
- `verification_status ∈ {"not_required", "verified", "needs_review"}`.
- New non-locking violation kinds: `multiple_faces`, `identity_mismatch`. `unauthorized_person` keeps locking and is not used by the monitor.
- Face models served from `${PUBLIC_URL}/models` (bundled; no third-party fetch). Local face descriptor key `ag_face_descriptor`; never sent to the server.
- Commands: backend `cd backend && python -m pytest tests -q -p no:cacheprovider --ignore=tests/test_accessguard.py`; frontend `cd frontend && CI=true npx craco test --watchAll=false <path>`; extension `cd extension && npm test`.

## Review Focus

- **ID cards with a ghost image** (a second, smaller printed face) — the larger face must be used, not reject the ID. Test in Task 1 (`describeFace picks the largest face`).
- **Names with accents or initials** (`Āsha N. Perera` vs OCR `ASHA PERERA`) — should still count as a name match. Test in Task 2.
- **Camera stream ending mid-check** (unplugged, another app takes it) — the check must stop with a retry, not hang on "Detecting…". Test in Task 9.
- **A failed or timed-out heartbeat** — must not be recorded as a 0 ms (or huge) latency on the dashboard. Test in Task 10.
- **Page reload during the exam** — the enrolled face descriptor must survive so identity checks continue. Test in Task 8.

---

### Task 1: Bundle face models and add the face engine wrapper

**Files:**
- Create: `frontend/public/models/` (7 files below), `frontend/src/lib/faceEngine.js`
- Test: `frontend/src/lib/faceEngine.test.js`

**Interfaces:**
- Produces:
  - `MODELS_URL: string` = `` `${process.env.PUBLIC_URL || ""}/models` ``
  - `loadFaceModels(): Promise<boolean>` — memoised; never throws; a failed load resets the memo so the next call retries.
  - `detectFaces(input, { inputSize = 224, scoreThreshold = 0.4 } = {}): Promise<Face[]>`
  - `describeFace(input, { inputSize = 608, scoreThreshold = 0.3 } = {}): Promise<Face & { descriptor: number[] } | null>` — largest face by box area.
  - `faceDistance(a: number[], b: number[]): number` (euclidean)
  - `Face = { box: { x, y, width, height }, score: number, landmarks: { x, y }[] /* 68 points */ }`

- [ ] **Step 1: Download the weights** from `https://justadudewhohacks.github.io/face-api.js/models/` into `frontend/public/models/`: `tiny_face_detector_model-weights_manifest.json`, `tiny_face_detector_model-shard1`, `face_landmark_68_model-weights_manifest.json`, `face_landmark_68_model-shard1`, `face_recognition_model-weights_manifest.json`, `face_recognition_model-shard1`, `face_recognition_model-shard2`. Verify each manifest parses as JSON and total size is ~7 MB.

- [ ] **Step 2: Write the failing tests** (mock `face-api.js` with `jest.mock`)

```js
test("loads all three nets from the bundled models folder", async () => {
  expect(await loadFaceModels()).toBe(true);
  expect(faceapi.nets.tinyFaceDetector.loadFromUri).toHaveBeenCalledWith("/models");
  expect(faceapi.nets.faceLandmark68Net.loadFromUri).toHaveBeenCalledWith("/models");
  expect(faceapi.nets.faceRecognitionNet.loadFromUri).toHaveBeenCalledWith("/models");
});
test("returns false instead of throwing, and retries on the next call", async () => {
  faceapi.nets.tinyFaceDetector.loadFromUri.mockRejectedValueOnce(new Error("404"));
  expect(await loadFaceModels()).toBe(false);
  expect(await loadFaceModels()).toBe(true);
});
test("describeFace picks the largest face (ID card ghost image)", async () => {
  // detectAllFaces(...).withFaceLandmarks().withFaceDescriptors() resolves two faces: 40x40 and 120x150
  expect((await describeFace(img)).box.width).toBe(120);
});
test("describeFace returns null when no face is found", async () => { /* resolves [] */ });
test("faceDistance is euclidean", () => { expect(faceDistance([0, 0], [3, 4])).toBe(5); });
```

- [ ] **Step 3: Run** `cd frontend && CI=true npx craco test --watchAll=false src/lib/faceEngine.test.js` — expect FAIL (module missing).
- [ ] **Step 4: Implement `faceEngine.js`.** Use `faceapi.detectAllFaces(input, new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold })).withFaceLandmarks()` (plus `.withFaceDescriptors()` in `describeFace`); map results to plain objects (`landmarks.positions` → `{x, y}`, `Array.from(descriptor)`).
- [ ] **Step 5: Run the test** — expect PASS.
- [ ] **Step 6: Commit** `git add frontend/public/models frontend/src/lib/faceEngine.js frontend/src/lib/faceEngine.test.js && git commit -m "feat(face): bundle face models and add face engine wrapper"`

### Task 2: Matching and name checks

**Files:** Create `frontend/src/lib/faceChecks.js`; Test `frontend/src/lib/faceChecks.test.js`

**Interfaces:**
- Produces: `MATCH_PASS_SCORE = 0.5`, `STRONG_MATCH_DISTANCE = 0.5`, `MATCH_DISTANCE = 0.6`, `matchFromDistance(d: number): { score: number, status: "strong" | "match" | "no_match" }`, `averageDescriptor(list: number[][]): number[]`, `nameMatchesText(fullName: string, ocrText: string): boolean`.

- [ ] **Step 1: Write the failing tests**

```js
test("distance 0.6 maps to exactly the 50% pass mark", () => {
  expect(matchFromDistance(0.6)).toEqual({ score: 0.5, status: "match" });
});
test("statuses at the boundaries", () => {
  expect(matchFromDistance(0.5).status).toBe("strong");
  expect(matchFromDistance(0.61).status).toBe("no_match");
  expect(matchFromDistance(0).score).toBe(1);
  expect(matchFromDistance(2).score).toBe(0);
});
test("averageDescriptor is the element-wise mean", () => {
  expect(averageDescriptor([[0, 2], [2, 4]])).toEqual([1, 3]);
});
test("name check ignores case, punctuation, accents and initials", () => {
  expect(nameMatchesText("Āsha N. Perera", "STUDENT ID\nASHA PERERA\n2024")).toBe(true);
});
test("name check fails when a name token is missing or the name is empty", () => {
  expect(nameMatchesText("Asha Perera", "ASHA SILVA")).toBe(false);
  expect(nameMatchesText("", "ANY TEXT")).toBe(false);
});
```

- [ ] **Step 2: Run** `CI=true npx craco test --watchAll=false src/lib/faceChecks.test.js` — expect FAIL.
- [ ] **Step 3: Implement.** Name normalisation: `normalize("NFD")`, strip combining marks, lowercase, split on non-letters, keep tokens of 2+ letters; every name token must appear in the OCR token set.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(face): add match scoring and OCR name check"`

### Task 3: Blink detector and head-turn estimate

**Files:** Modify `frontend/src/lib/faceChecks.js`; Test `frontend/src/lib/faceChecks.test.js`

**Interfaces:**
- Produces: `eyeAspectRatio(eye: {x,y}[6]): number`; `createBlinkDetector(): { push(ear: number): boolean, baseline(): number | null }` (`push` returns `true` on the sample that completes a blink); `yawRatio(landmarks: {x,y}[68]): number`. Landmark indices: left eye 36–41, right eye 42–47, nose tip 30; eye midpoint = mean of the two eye centroids; interocular distance = distance between eye centroids.

- [ ] **Step 1: Write the failing tests** (build synthetic 68-point arrays with a helper `face({ eyeOpen, noseOffset })`)

```js
test("blink is relative to the person's own baseline (narrow eyes)", () => {
  const d = createBlinkDetector();
  for (let i = 0; i < 8; i++) d.push(0.2);          // narrow open eyes
  expect(d.baseline()).toBeCloseTo(0.2);
  expect(d.push(0.19)).toBe(false);                  // not below 0.15 → still open
  expect(d.push(0.12)).toBe(false);                  // closed
  expect(d.push(0.19)).toBe(true);                   // reopened above 0.18 → blink
});
test("no blink is counted during calibration", () => {
  const d = createBlinkDetector();
  expect([0.3, 0.1, 0.3].map(e => d.push(e))).toEqual([false, false, false]);
});
test("yaw sign: nose toward image right means the student turned left", () => {
  expect(yawRatio(face({ noseOffset: +0.4 }))).toBeGreaterThan(0.25);
  expect(yawRatio(face({ noseOffset: -0.4 }))).toBeLessThan(-0.25);
  expect(Math.abs(yawRatio(face({ noseOffset: 0 })))).toBeLessThan(0.1);
});
```

- [ ] **Step 2: Run** — expect FAIL. **Step 3: Implement.** **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(face): add calibrated blink detector and yaw estimate"`

### Task 4: Liveness challenge state machine

**Files:** Modify `frontend/src/lib/faceChecks.js`; Test `frontend/src/lib/faceChecks.test.js`

**Interfaces:**
- Consumes: `createBlinkDetector`, `yawRatio`, `eyeAspectRatio` (Task 3); `faceDistance` semantics (euclidean) — implement a local euclidean helper, do not import `faceEngine.js`.
- Produces: `LIVENESS_ACTIONS = ["blink", "turn_left", "turn_right"]`; `createLivenessChallenge({ random = Math.random } = {}): { step(sample): ChallengeState, state(): ChallengeState }`.
  - `sample = { now: number, faceCount: number, landmarks?: {x,y}[], box?: {width}, frameWidth?: number, descriptor?: number[] }`
  - `ChallengeState = { phase: "calibrating" | "active" | "verifying" | "passed" | "failed", order: string[], action: string | null, completed: string[], hint: null | "no_face" | "too_far" | "multiple_faces" | "hold_still" | "do_action", failure: null | "multiple_faces" | "face_changed" | "timeout", needsDescriptor: boolean, actionDeadline: number | null }`
  - Calibration ends after 8 single-face samples **and** a frontal start descriptor; `needsDescriptor` is `true` while a frontal descriptor is wanted (calibration and `verifying`). After the last action → `verifying` until a frontal end descriptor arrives, then `passed` or `failed` (`face_changed`).

- [ ] **Step 1: Write the failing tests** (drive with synthetic samples; inject `random` for a fixed order)

```js
test("order is a permutation of the three actions", ...);
// [...state().order].sort() equals [...LIVENESS_ACTIONS].sort()
test("passes when every action is done and start/end faces match", ...);
// end descriptor at distance 0.3 from start → phase "passed", completed.length === 3
test("fails immediately on a second face", ...);
// step({ faceCount: 2, ... }) → phase "failed", failure "multiple_faces"
test("fails with timeout when an action takes longer than 8 s", ...);
// first action starts at t; step at t + 8001 → failure "timeout"
test("fails with timeout after 30 s overall", ...);
// actions keep completing just inside 8 s each, but a step at first-sample + 30001 → failure "timeout"
test("fails with face_changed when end descriptor is > 0.5 from start", ...);
// end descriptor at distance 0.51 → phase "failed", failure "face_changed"
test("hints no_face after 1.5 s without a face, too_far for a small box", ...);
// faceCount 0 at +1400 → hint not "no_face"; at +1600 → "no_face"; box.width 100 / frameWidth 640 → "too_far"
test("a turn must hold 3 consecutive samples", ...);
// yaw +0.3, +0.3, 0 → turn_left not completed; +0.3 ×3 → completed includes "turn_left"
```

- [ ] **Step 2: Run** — expect FAIL. **Step 3: Implement.** **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(face): add randomized challenge-response liveness state machine"`

### Task 5: Exam face monitor rules

**Files:** Modify `frontend/src/lib/faceChecks.js`; Test `frontend/src/lib/faceChecks.test.js`

**Interfaces:**
- Produces: `createExamFaceMonitor({ noFaceMs = 10000 } = {}): { next(sample: { faceCount: number, distance?: number }, now: number): { events: ("face_lost" | "multiple_faces" | "identity_mismatch")[], faceVisible: boolean } }`.

- [ ] **Step 1: Write the failing tests**

```js
test("face_lost only after 10 s with no face, once per absence", ...);
// faceCount 0 at t=0,3000,6000,9000 → events []; t=10000 → ["face_lost"]; t=13000 → []
test("face_lost re-arms after the face returns", ...);
// after face_lost, one sample with faceCount 1, then 10 s of 0 → ["face_lost"] again
test("multiple_faces needs 2 consecutive samples and fires once per episode", ...);
// counts 2 → []; 2 → ["multiple_faces"]; 2 → []
test("episode ends after 2 consecutive samples with ≤ 1 face", ...);
// 2,2 (fires), 1,1, 2,2 → fires a second time
test("identity_mismatch needs 2 consecutive distances > 0.6", ...);
// distances 0.7, 0.4, 0.7 → no event; 0.7, 0.7 → ["identity_mismatch"] once
test("faceVisible reflects the latest sample", ...);
// faceCount 1 → faceVisible true; faceCount 0 → false
```

- [ ] **Step 2–4:** run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** `git commit -m "feat(face): add exam face monitor episode rules"`

### Task 6: Backend — join verification, size limits, trimmed payloads

**Files:** Modify `backend/server.py` (`StudentJoinIn` ~line 793, `candidate_join` ~1370, `list_candidates` ~1458); Test: create `backend/tests/test_face_verification.py`

**Interfaces:**
- Produces (module level in `server.py`): `ALLOWED_VERIFICATION_FLAGS: set[str]` (spec list), `INFORMATIONAL_VERIFICATION_FLAGS = {"name_unconfirmed"}`, `MATCH_PASS_SCORE = 0.5`, `MAX_IMAGE_DATA_URL_BYTES = 2 * 1024 * 1024`, `MAX_LIVENESS_FRAME_BYTES = 100 * 1024`, `MAX_LIVENESS_FRAMES = 3`, `clean_verification_flags(flags: List[str]) -> List[str]` (drop unknown, dedupe, keep order), `assess_verification(required: bool, liveness_passed: bool, face_match_score: Optional[float], flags: List[str]) -> str`.
- `StudentJoinIn`: `liveness_passed: bool = False`, `face_match_score: Optional[float] = Field(default=None, ge=0, le=1)`, `verification_flags: List[str] = []`, `liveness_frames_b64: List[str] = []`.
- Candidate document gains `verification_status`, `verification_flags`, `liveness_frame_urls: List[str]` (stored with `put_b64_image(f"{APP_NAME}/candidates/{cid}/liveness_{i}.jpg", b64)`, falling back to the data URL like the other images).
- `list_candidates` projection also excludes `liveness_frame_urls`; the `candidate_joined` broadcast omits `id_front_url`, `id_back_url`, `liveness_frame_urls`.

- [ ] **Step 1: Write the failing tests**

```python
def test_assess_verification_not_required():
    assert assess_verification(False, False, None, []) == "not_required"
def test_assess_verification_verified():
    assert assess_verification(True, True, 0.5, ["name_unconfirmed"]) == "verified"
@pytest.mark.parametrize("live,score,flags", [
    (False, 0.9, []), (True, None, []), (True, 0.49, []), (True, 0.9, ["camera_unavailable"])])
def test_assess_verification_needs_review(live, score, flags):
    assert assess_verification(True, live, score, flags) == "needs_review"
def test_clean_flags_drops_unknown_and_duplicates():
    assert clean_verification_flags(["x", "face_mismatch", "face_mismatch"]) == ["face_mismatch"]
def test_join_defaults_to_needs_review_and_hides_frames(live_client): ...
    # session with identity required; join without liveness fields
    # → response verification_status == "needs_review"; GET candidates rows lack "liveness_frame_urls"
def test_join_in_quick_session_is_not_required(live_client): ...           # require_identity_verification False
def test_join_rejects_oversized_selfie_with_413(live_client): ...          # "data:image/jpeg;base64," + "A" * (2*1024*1024)
def test_join_rejects_more_than_three_frames_or_large_frame(live_client): ...
```

Use a self-registered invigilator per test (copy `_fresh_invigilator_token` from `test_module_enrollment.py`) so no shared account is touched.

- [ ] **Step 2: Run** `cd backend && python -m pytest tests/test_face_verification.py -q` — expect FAIL.
- [ ] **Step 3: Implement.** Size checks run before any upload; error text `"<field> image is too large"` with 413.
- [ ] **Step 4: Run the new file and the full backend suite** — expect PASS (existing join tests send `liveness_passed`/`face_match_score` and must keep passing).
- [ ] **Step 5: Commit** `git commit -m "feat(backend): derive verification status server-side and cap join image sizes"`

### Task 7: Backend — evidence endpoint and camera violation kinds

**Files:** Modify `backend/server.py` (new route after `list_candidates`; `allowed_kinds` ~line 2009); Test `backend/tests/test_face_verification.py`

**Interfaces:**
- Produces: `GET /api/sessions/{sid}/candidates/{cid}/evidence` (owner only via `owned_session`) → `{ id, full_name, student_id, id_front_url, id_back_url, selfie_url, liveness_frame_urls, liveness_passed, face_match_score, verification_status, verification_flags, violations: [{ kind, detail, ts }] }` (violations newest first). 404 if the candidate is not in that session.
- `allowed_kinds` gains `"multiple_faces"`, `"identity_mismatch"`; neither is in `LOCKING_VIOLATION_KINDS`.

- [ ] **Step 1: Write the failing tests**

```python
def test_evidence_returns_images_and_violations_for_owner(live_client): ...
    # join with selfie + 2 frames, report one face_lost → 200; len(liveness_frame_urls) == 2;
    # selfie_url set; violations[0]["kind"] == "face_lost"
def test_evidence_forbidden_for_another_invigilator(live_client): ...
    # second self-registered invigilator → same status owned_session returns for foreign sessions (assert != 200)
def test_evidence_404_for_candidate_of_other_session(live_client): ...
    # candidate id from session B requested under session A (same owner) → 404
@pytest.mark.parametrize("kind", ["multiple_faces", "identity_mismatch", "face_lost"])
def test_camera_violations_are_recorded_without_locking(live_client, kind): ...
    # approved candidate in a live session → response {"ok": True, "locked": False}; candidate status still "approved"
```

- [ ] **Step 2–4:** run (FAIL) → implement → run file + full suite (PASS).
- [ ] **Step 5: Commit** `git commit -m "feat(backend): add candidate evidence endpoint and non-locking camera violations"`

### Task 8: Local descriptor storage, image helpers, join payload builder

**Files:**
- Modify `frontend/src/lib/studentSession.js` (+ `studentSession.test.js`)
- Create `frontend/src/lib/imageTools.js`, `frontend/src/lib/verificationPayload.js`; Tests `imageTools.test.js`, `verificationPayload.test.js`

**Interfaces:**
- Produces:
  - `saveFaceDescriptor(descriptor: number[]): void`, `getStoredFaceDescriptor(): number[] | null` (key `ag_face_descriptor`, removed by `clearStudentAttempt`).
  - `fitWithin(width: number, height: number, maxSide: number): { width, height }` (never upscales); `downscaleDataUrl(dataUrl, { maxSide, quality }): Promise<string>`; `captureVideoFrame(video, { maxSide, quality }): string` (canvas; not unit tested — jsdom has no canvas).
  - `buildJoinPayload({ session, student, idFront, idBack, idFaceFound, faceResult, match, nameOk, modelsOk }): object` where `faceResult = { passed: boolean, selfie: string | null, descriptor: number[] | null, frames: string[], flags: string[], skipped: null | "camera_unavailable" }` and `match = { score, status } | null` → `{ session_code, student_id, full_name, id_front_b64, id_back_b64, selfie_b64, liveness_passed, face_match_score, verification_flags, liveness_frames_b64 }`. `idFaceFound === false` adds `no_face_in_id`.

- [ ] **Step 1: Write the failing tests**

```js
test("descriptor survives a reload (read back from storage) and is cleared with the attempt", ...);
test("fitWithin keeps aspect ratio and never upscales", () => {
  expect(fitWithin(4000, 3000, 1280)).toEqual({ width: 1280, height: 960 });
  expect(fitWithin(300, 200, 1280)).toEqual({ width: 300, height: 200 });
});
test("camera unavailable → liveness false + camera_unavailable", ...);       // B1
test("models unavailable → score null + models_unavailable (never verified)", ...); // B2
test("score below 0.5 adds face_mismatch; name mismatch adds name_unconfirmed", ...);
test("failed liveness carries liveness_failed and its reason", ...);
test("no selfie → score null + no_face_in_selfie", ...);
test("no face on the ID → no_face_in_id", ...);
test("at most 3 evidence frames are sent", ...);                       // 5 frames in → liveness_frames_b64.length === 3
```

- [ ] **Step 2–4:** run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** `git commit -m "feat(face): store live descriptor locally and build join payload from raw results"`

### Task 9: Verification page rewrite

**Files:**
- Create `frontend/src/components/verify/IdPhotoStep.jsx`, `FaceCheckStep.jsx`, `ReviewStep.jsx`
- Rewrite `frontend/src/pages/StudentVerify.jsx`; Test `frontend/src/pages/StudentVerify.test.jsx`

**Interfaces:**
- Consumes: Task 1 engine, Tasks 2–4 checks, Task 8 helpers, `api.post("/public/candidates/join", payload)`.
- `IdPhotoStep({ title, image, analysing, warning, onImage(dataUrl) })`.
- `FaceCheckStep({ onComplete(faceResult), onSkip("camera_unavailable") })` — owns the camera: requests `getUserMedia({ video: { width: 640, height: 480 } })`, stops all tracks on unmount and on completion; sequential detection loop (`await` each detection, then `requestAnimationFrame`/`setTimeout(0)`); preview mirrored with CSS only; oval guide overlay, hint line, action list with ticks, large current instruction ("Turn your head to your LEFT"), per-action countdown bar; on `failed`: reason + **Try again** (new challenge) + **Continue anyway**; on the video track `ended` event: stop the loop and show "Camera stopped" with **Try again**.
- `ReviewStep({ idFace, selfie, match, liveness, nameOk, reasons, submitting, onSubmit, onBack })` — banner **Verified** or **Will need invigilator review** + reasons.
- `StudentVerify`: steps `["ID front", "ID back", "Face check", "Review"]`; ID front upload → `downscaleDataUrl(…, { maxSide: 1280, quality: 0.8 })`, OCR (Tesseract, existing) and `describeFace`; the match is **derived** with `useMemo` from the current ID descriptor and `faceResult.descriptor` via `matchFromDistance(faceDistance(...))` — never stored separately, so it cannot go stale (B3); on success `saveCandidateAttempt` + `saveFaceDescriptor(faceResult.descriptor)`; step indicator shows numbers only below the `sm` breakpoint.

- [ ] **Step 1: Write the failing tests** (mock `../lib/api`, `../lib/faceEngine`, `tesseract.js`, `sonner`; seed join context like `StudentEntry.test.jsx`)

```js
test("camera denied → 'Continue without camera' → submits liveness false with camera_unavailable", ...);
// api.post called with "/public/candidates/join", payload.liveness_passed === false,
// payload.verification_flags contains "camera_unavailable"
test("model load failure shows 'Unverified' and never 'Verified'", ...);
// loadFaceModels → false; review step text includes "Unverified" and "Will need invigilator review"
test("camera tracks are stopped when the page unmounts during the face check", ...);
// getUserMedia resolves { getTracks: () => [track] }; unmount → track.stop called once
test("camera track ending mid-check shows 'Camera stopped' and a retry", ...);
// fire track's "ended" listener → screen shows "Camera stopped" and a "Try again" button
```

- [ ] **Step 2: Run** `CI=true npx craco test --watchAll=false src/pages/StudentVerify.test.jsx` — expect FAIL.
- [ ] **Step 3: Implement** the three step components and the page.
- [ ] **Step 4: Run** the test file and `src/pages/StudentEntry.test.jsx` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(verify): challenge liveness, live-face selfie, review step with flags"`

### Task 10: Exam face monitoring, latency, status chip

**Files:**
- Create `frontend/src/lib/useExamFaceMonitor.js`, `frontend/src/lib/latency.js`; Tests `useExamFaceMonitor.test.js`, `latency.test.js`
- Modify `frontend/src/pages/StudentExam.jsx` (heartbeat effect ~line 331, webcam preview ~line 704, header ~line 652)

**Interfaces:**
- Consumes: `loadFaceModels`, `detectFaces`, `describeFace`, `faceDistance` (Task 1); `createExamFaceMonitor` (Task 5); `getStoredFaceDescriptor` (Task 8); existing `reportViolation(kind, detail)`.
- Produces: `useExamFaceMonitor({ videoRef, active: boolean, descriptor: number[] | null, onEvent(kind) }): { status: "starting" | "ok" | "no_face" | "multiple" | "off", faceVisible: boolean | null }` — counts with `detectFaces(video)` and computes identity with `describeFace(video, { inputSize: 224, scoreThreshold: 0.4 })` (video settings, not the still-image defaults); `createLatencyTracker(): { measure(fn: () => Promise): Promise, latest(): number }` (records elapsed ms only when `fn` resolves).
- StudentExam: heartbeat sends `face_visible` = monitor result (falls back to `streaming && !document.hidden` when status is `off`), `latency_ms` = `tracker.latest()`, note `face-check-unavailable` when `off`; face chip next to the timer (**Face OK**, **No face**, **Multiple faces**, **Face check off**); webcam preview ring colour follows the chip.

- [ ] **Step 1: Write the failing tests**

```js
test("latency: a failed request does not change the latest value", async () => {
  const t = createLatencyTracker();
  await t.measure(() => Promise.resolve());
  const before = t.latest();
  await expect(t.measure(() => Promise.reject(new Error("x")))).rejects.toThrow();
  expect(t.latest()).toBe(before);
});
test("monitor reports multiple_faces after two 3 s samples", ...);
// fake timers; detectFaces → 2 faces; advance 3000 → onEvent not called; advance 3000 → onEvent("multiple_faces") once
test("monitor goes 'off' and reports nothing when models fail to load", ...);
// loadFaceModels → false; result.status === "off"; onEvent never called after 30 s
test("identity distance is only computed every 5th sample", ...);
// detectFaces → 1 face; after 15 000 ms describeFace called 1 time, after 30 000 ms 2 times
```

- [ ] **Step 2–4:** run (FAIL) → implement → run (PASS); also run `src/pages/QuickLockdown.test.jsx`.
- [ ] **Step 5: Commit** `git commit -m "feat(exam): real face monitoring, measured heartbeat latency, face status chip"`

### Task 11: Dashboard — badges, evidence panel, live tile fixes

**Files:**
- Create `frontend/src/lib/verificationLabels.js` (+ test), `frontend/src/components/CandidateEvidencePanel.jsx`
- Modify `frontend/src/pages/SessionDashboard.jsx` (pending cards ~232–257, tile buttons ~316–335, Delete button ~211); Test `frontend/src/pages/SessionDashboard.test.jsx`

**Interfaces:**
- Produces: `verificationBadge(candidate): { label: "Verified" | "Needs review", tone: "ok" | "warn", reasons: string[] } | null` (null for `not_required`), `FLAG_LABELS` = `camera_unavailable` "Camera unavailable", `liveness_failed` "Liveness failed", `multiple_faces` "Multiple faces", `face_changed` "Face changed during check", `no_face_in_id` "No face on ID", `no_face_in_selfie` "No clear selfie", `face_mismatch` "Face does not match ID", `models_unavailable` "Face check unavailable", `name_unconfirmed` "Name not confirmed", `VIOLATION_LABELS: Record<kind, string>` (adds "Face not visible", "Multiple faces", "Different person"), `matchLabel(score: number | null): string` ("Unverified" for null, else `"NN%"`).
- `CandidateEvidencePanel({ sessionId, candidateId, open, onOpenChange, onDecide(candidateId, approve) })` — uses `components/ui/sheet.jsx`; fetches `GET /sessions/${sessionId}/candidates/${candidateId}/evidence` when opened; shows ID front/back, selfie, liveness frames, results, violations; Approve/Reject only when the candidate is `pending`.
- Pending card click and the tile eye button open the panel; tiles show face status from the latest heartbeat (`face_visible`); Delete Session uses lucide `Trash2`.

- [ ] **Step 1: Write the failing tests**

```js
test("verificationBadge maps statuses and flag reasons", ...);
// { verification_status: "needs_review", verification_flags: ["camera_unavailable", "name_unconfirmed"] }
//   → { label: "Needs review", tone: "warn", reasons: ["Camera unavailable", "Name not confirmed"] }
// "verified" → { label: "Verified", tone: "ok", reasons: [] }; "not_required" → null
test("matchLabel shows Unverified for a missing score", () => {
  expect(matchLabel(null)).toBe("Unverified");
  expect(matchLabel(0.734)).toBe("73%");
});
test("pending cards show Verified / Needs review and none for not_required", ...);
// three pending candidates → getByText("Verified"), getByText("Needs review"); the not_required card has neither
test("the tile eye button opens the evidence panel and loads evidence", ...);
// click data-testid "view-c1" → api.get called with "/sessions/s1/candidates/c1/evidence"; panel shows the student's name
```

- [ ] **Step 2–4:** run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** `git commit -m "feat(dashboard): verification badges, evidence panel, working tile view button"`

### Task 12: Remaining bug fixes

**Files:** Modify `backend/tests/test_accessguard.py` (top of module)

- [ ] **Step 1:** Add a module-level skip: `if not os.environ.get("REACT_APP_BACKEND_URL"): pytest.skip("live-server tests need REACT_APP_BACKEND_URL", allow_module_level=True)` before `BASE_URL` is read (B12).
- [ ] **Step 2: Run** `cd backend && python -m pytest tests -q -p no:cacheprovider` (no `--ignore`) — expect all pass with the module skipped.
- [ ] **Step 3:** Re-run the spec's bug table (B1–B16) against the code; for any bug found during Tasks 1–11 that is not yet fixed, add a failing test in the owning area, fix it, and add a row to the spec's table.
- [ ] **Step 4: Commit** `git commit -m "fix(tests): skip live-server suite when no backend URL is configured"`

### Task 13: Extension popup polish and double-submit fix

**Files:**
- Create `extension/popup-ui.js`; Test `extension/tests/popup-ui.test.mjs`
- Modify `extension/popup.html` (script tag → `type="module"`, header host line), `extension/popup.js`, `extension/ui.css`, `extension/manifest.json` + `extension/package.json` (version `1.4.0` in both)

**Interfaces:**
- Produces: `runWithBusy(button, busyLabel: string, fn: () => Promise<T>): Promise<T>` — disables the button and sets `textContent = busyLabel`, restores both in `finally`, ignores calls while already busy; `setNotice(element, message: string, tone: "info" | "success" | "error")` — sets text and `className = "notice"` plus the tone class (`info` has none).
- Wrap these click handlers: `setup-connect-btn`, `inv-login-btn`, `quick-start-btn`, `quick-end-btn`, `module-create-btn`, `module-enroll-btn`, `module-signin-btn`, `join-btn`. Header `#server-host` shows `new URL(deployment.appOrigin).host`; module list shows "No modules yet" when empty; `.notice.success` style added.

- [ ] **Step 1: Write the failing tests** (fake button `{ disabled: false, textContent: "Go" }`)

```js
test("disables and relabels while running, restores afterwards", ...);
test("restores the button even when fn throws", ...);
test("a second click while busy does not run fn again", ...);
test("setNotice applies tone classes", ...);
```

- [ ] **Step 2–4:** `cd extension && npm test` (FAIL) → implement → (PASS, including `manifest.test.mjs`).
- [ ] **Step 5: Rebuild the hosted package**: stage the runtime files (`blocked.html`, `blocked.js`, `config.js`, `content-bridge.js`, `managed-policy-schema.json`, `manifest.json`, `popup.html`, `popup.js`, `popup-ui.js`, `quick-session.js`, `rule-helpers.js`, `service-worker.js`, `ui.css`) into a scratch folder, set the trusted origins in the staged `config.js` (`https://access-guard-project.vercel.app` / `https://feisty-renewal-production-83ec.up.railway.app`), and write `artifacts/accessguard-lockdown-hosted.zip` (replace the old one).
- [ ] **Step 6: Commit** `git commit -m "feat(extension): busy states, consistent notices and server header in the popup"`

### Task 14: Full verification and hand-off

- [ ] **Step 1:** Run all suites: backend (no `--ignore`), frontend (`CI=true npx craco test --watchAll=false`), extension (`npm test`) — all pass.
- [ ] **Step 2:** `cd frontend && CI=false npx craco build` — succeeds; `build/models/` contains the 7 weight files; `build/index.html` starts with `<!doctype html>`.
- [ ] **Step 3:** Push `pasi`: `git push origin pasi`.
- [ ] **Step 4:** Give the owner the manual camera checklist from the spec's Testing section (real face pass; printed photo and phone video fail; second person during liveness and exam; look away > 10 s in the exam; models load from the Vercel site).

# AccessGuard Lockdown Extension

This directory is a self-contained Chrome Manifest V3 extension for browser-level AccessGuard exam enforcement. It does not contain or require a frontend build step.

## What it enforces

After the AccessGuard exam page arms the extension, the service worker fetches an authenticated candidate policy from the backend. For backend states `armed`, `enforced`, and `locked`, it:

- installs persistent dynamic Declarative Net Request rules that deny every HTTP(S) main-frame navigation except exact policy origins;
- always preserves the authenticated exam/app origin, API origin, exam URL origin, and invigilator allowlisted origins;
- redirects disallowed, already-open, newly-created, activated, and in-flight tabs to `blocked.html`;
- restores the exam tab if it is closed and requests fullscreen for its Chrome window;
- refreshes policy and sends an authenticated extension heartbeat every 30 seconds;
- remains fail-closed when the backend is unavailable or returns an invalid policy.

The blocked page lets the student request access. That request does not create a local exception. The attempted origin becomes available only after the invigilator updates backend policy and the extension fetches the new `policy_version`.

Rules are removed only when an authenticated backend policy response has one of these terminal states: `released`, `finished`, `kicked`, `rejected`, or `ended`, or when that authenticated policy explicitly sets `enforcement: false` for monitor-only/disabled mode. A non-enforcing policy keeps its candidate credential and continues policy refreshes so a later backend version can enable enforcement. The web page, popup, and blocked page have no direct unlock operation.

## Load it unpacked

1. Open `chrome://extensions` in Chrome 120 or later.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose this `extension` directory (the directory containing `manifest.json`).

No icons are declared, intentionally. Chrome supplies its normal extension placeholder, so unpacked loading never depends on missing image assets.

For a release archive, zip the **contents** of this directory so `manifest.json` is at the archive root. Do not include `node_modules` (there are no runtime dependencies).

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

## Web-page bridge protocol

The content bridge accepts same-window, same-origin requests with this shape:

```js
window.postMessage({
  source: "accessguard-web",
  type: "AG_LOCKDOWN_REQUEST",
  requestId: crypto.randomUUID(),
  action: "DISCOVER", // DISCOVER | ARM | STATUS | REFRESH_POLICY
  payload: {},
}, window.location.origin);
```

It returns exactly one correlated response:

```js
{
  source: "accessguard-extension",
  type: "AG_LOCKDOWN_RESPONSE",
  requestId,
  ok: true,
  data: { /* sanitized status */ },
  error: null,
}
```

After a page has sent a valid request, status changes are pushed as:

```js
{
  source: "accessguard-extension",
  type: "AG_LOCKDOWN_EVENT",
  event: "STATUS",
  data: { /* sanitized status */ },
}
```

### ARM

```js
window.postMessage({
  source: "accessguard-web",
  type: "AG_LOCKDOWN_REQUEST",
  requestId: crypto.randomUUID(),
  action: "ARM",
  payload: {
    candidateId: candidate.id,
    candidateToken: candidate.candidate_token,
    apiBase: "/api",
    appOrigin: window.location.origin,
  },
}, window.location.origin);
```

`apiBase` can be `/api`, an origin such as `https://api.example.edu` (which becomes `/api`), or a full base such as `https://api.example.edu/v1/api`. The candidate token is stored only in extension-local storage restricted to trusted extension contexts. It is never returned to the webpage, popup, blocked-page query string, or status event.

Status data contains:

```js
{
  installed: true,
  protocolVersion: 1,
  extensionVersion: "1.0.1",
  mode: "inactive" | "available" | "arming" | "monitoring" | "enforced" | "locked" |
        "released" | "fail_closed" | "error",
  backendState: null | "armed" | "enforced" | "locked" | "released" |
                "finished" | "kicked" | "rejected" | "ended",
  enforcementActive: true,
  candidateId: "...",
  sessionId: "...",
  policyVersion: "...",
  examUrl: "https://...",
  allowedOrigins: ["https://..."],
  lastPolicyAt: "ISO timestamp",
  lastHeartbeatAt: "ISO timestamp",
  lastError: null | { code, message, at },
  managed: false,
}
```

Before arming, `DISCOVER` intentionally returns only installation/protocol/version availability. Candidate/session details are exposed only to the exact app origin that armed the attempt.

`REFRESH_POLICY` is safe for the page to request: it only asks the service worker to perform a new authenticated backend fetch. It does not pass a requested state and cannot directly unlock.

## Backend contract

Every request carries `Authorization: Bearer <candidate token>`, `X-Candidate-Token: <candidate token>`, and `X-AccessGuard-App-Origin: <exact armed origin>`. The last header lets the backend build a deployment-correct exam URL; the extension still pins navigation to the exact origin and URL that armed the attempt.

`Return to Exam` and closed-tab recovery use the exact URL captured when the student exam page armed the extension. This prevents aliases such as `localhost` and `127.0.0.1` from changing the browser-storage origin and losing the candidate session. Existing v1.0.0 runtime data is migrated automatically after the extension is reloaded.

### Policy

```text
GET {apiBase}/public/extension/policy?candidate_id={candidateId}
```

Expected fields:

```json
{
  "candidate_id": "candidate_123",
  "session_id": "session_456",
  "state": "enforced",
  "enforcement": true,
  "policy_version": 4,
  "exam_url": "https://exam.example.edu/student/exam",
  "app_origins": ["https://exam.example.edu"],
  "allowed_origins": ["https://docs.example.edu"],
  "timestamps": { "generated_at": "2026-08-03T08:00:00Z" }
}
```

An optional top-level `expires_at` is validated when present. Policy release still depends on an authenticated live backend response; a local clock or webpage message never releases rules.

### Heartbeat

```text
POST {apiBase}/public/extension/heartbeat
```

The body follows the backend `ExtensionHeartbeatIn` schema: `candidate_id`, `extension_version`, monotonic `sequence`, numeric `policy_version`, `fullscreen`, `enforcement_active`, `active_url`, `active_origin`, and `open_tab_count`.

### Access request

```text
POST {apiBase}/public/extension/access-requests
```

Body: `{ "candidate_id": "...", "url": "https://...", "reason": "..." }`.

## Origin trust

Same-origin HTTPS app/API deployments are accepted automatically. Different loopback ports on `localhost`, `127.0.0.1`, or `[::1]` are accepted for local development.

For a hosted cross-origin deployment, configure both sides of the trust pair using one of these mechanisms:

- Build-time: edit `BUILD_TRUSTED_APP_ORIGINS` and `BUILD_TRUSTED_API_ORIGINS` in `config.js` before packaging.
- Enterprise policy: set `trusted_app_origins` and `trusted_api_origins` using `managed-policy-schema.json`.

Entries are exact origins, for example `https://exam.example.edu`; wildcards, credentials, paths, and non-HTTP schemes are rejected. Hosted non-HTTPS origins are rejected even if configured.

## Tests

The extension has no third-party runtime or test dependencies. With Node.js 20 or later:

```powershell
cd extension
npm test
```

Tests validate exact-origin handling, default-deny DNR rule compilation, policy state normalization, URL sanitization, the owned rule range, manifest shape, and every declared local entry point.

For full end-to-end validation, launch a persistent Chrome test profile with this directory loaded as an unpacked extension, arm it against a real backend, and cover approval, blocked navigation, access approval, backend outage, tab close, browser restart, and authenticated release.

## Security boundary and unmanaged-device limitations

This extension materially strengthens browser-level control, but it is not an operating-system kiosk by itself:

- On an unmanaged device, a student can disable or uninstall an ordinary extension, launch another browser, use another application/device, or use OS-level shortcuts and capture tools.
- DNR controls Chrome network navigation; tab listeners provide defense in depth for `chrome://`, `file://`, other extension pages, and already-loaded tabs, but Chrome may restrict what extensions can observe or redirect on privileged internal pages.
- Fullscreen can be requested and restored, but an extension cannot guarantee suppression of every OS window switch.
- “Allowed applications” require a native agent or OS/device-management policy; this extension enforces web origins only.

For high-stakes exams, force-install the extension on managed Chrome and combine it with ChromeOS single-app kiosk or managed guest/user policies: block all URLs with explicit assessment exceptions, disable incognito, screenshots, printing, external storage, task manager/process ending, and unapproved apps as appropriate. The UI should call this extension mode **browser restriction** on unmanaged BYOD, not complete device lockdown.

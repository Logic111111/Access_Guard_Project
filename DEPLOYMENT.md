# AccessGuard deployment guide

This guide covers the Docker Compose deployment in this repository. It builds the React application as static files, serves it through nginx, proxies `/api` and live WebSockets to FastAPI, and keeps MongoDB on a private network with a persistent volume.

## Security boundary

AccessGuard's browser code and extension improve monitoring and navigation control, but a normal browser extension is not an operating-system lock. A student can disable an unpacked extension, use another browser or device, or switch to another application. For high-assurance exams, use institution-managed devices, force-install the extension through browser policy, restrict guest/incognito profiles, and use kiosk or managed-browser controls.

Before an internet-facing launch, verify all of the following:

- Demo users and `/api/test/*` routes are disabled in the running production API.
- The API rejects startup when authentication secrets are missing or weak.
- Invigilator actions enforce session ownership, and every student mutation uses a short-lived candidate credential.
- HTTPS is enabled at the public edge and `APP_ORIGIN` is the exact public HTTPS origin.
- Camera/identity capture has an approved consent, retention, deletion, and incident-response policy.
- Telemetry and session recording are disabled unless explicitly approved and disclosed.
- Durable object storage is configured and tested before identity images or webcam evidence are collected; database-embedded image fallbacks are not a production storage strategy.

The Compose file sets `APP_ENV=production`, disables remote-token login and self-registration, and therefore keeps demo routes and demo users out of the production application. Confirm those controls against the running image before launch rather than relying on configuration alone.

## Architecture

```text
Browser / managed extension
          |
       HTTPS
          |
TLS edge or hosting load balancer
          |
  frontend nginx :80
      |       |
 static SPA   /api + WebSocket
              |
       FastAPI :8000 (one worker)
              |
          MongoDB :27017
          persistent volume
```

Only nginx is published by Compose, and it binds to `127.0.0.1:8080` by default. FastAPI and MongoDB remain on Docker networks. The backend is intentionally limited to one worker because its live WebSocket subscriber registry is process-local. Do not scale backend replicas until event fan-out is moved to a shared broker such as Redis.

## Prerequisites

- Docker Engine or Docker Desktop with Docker Compose v2
- At least 4 GB of available memory for builds and local services
- A DNS name and TLS-terminating reverse proxy/load balancer for production
- Chrome or another Chromium browser for the Manifest V3 extension

## First deployment

1. Create the private environment file:

   ```powershell
   Copy-Item .env.example .env
   ```

   On macOS or Linux, use `cp .env.example .env`.

2. Generate separate random values for `MONGO_ROOT_PASSWORD`, `JWT_SECRET`, `ADMIN_PASSWORD`, and `REMOTE_LOGIN_SECRET`. Hex output is URL-safe for the generated MongoDB connection string:

   ```text
   openssl rand -hex 32
   ```

   Put each generated value in `.env`. Never commit `.env`. For local HTTP testing, set `APP_ORIGIN=http://localhost:8080`. For production, use the final origin, such as `https://exam.example.edu`.

   Mongo's initialization variables and the application's bootstrap admin password apply when their records are first created. Editing `.env` later does not rotate credentials already stored in `mongo_data`; perform an explicit database/application credential rotation and test it before replacing the old values.

3. Validate and build:

   ```text
   docker compose config
   docker compose build --pull
   ```

4. Start the stack:

   ```text
   docker compose up -d
   docker compose ps
   docker compose logs --tail=100 backend frontend mongo
   ```

5. Smoke-test the same-origin entrypoint:

   ```text
   http://localhost:8080/healthz
   http://localhost:8080/
   ```

   The first endpoint should return `ok`. The second should load the application. Confirm login, student join, approval, WebSocket updates, camera permission, submission, and report generation with non-production data.

   FastAPI readiness is checked internally at `/api/health`; it reports unhealthy when MongoDB cannot be reached.

## Quick start: one Linux server with automatic HTTPS

This is the shortest path to a public deployment. It uses `compose.https.yaml`, which adds Caddy in front of the stack to obtain and renew a Let's Encrypt certificate automatically.

1. **Server.** Provision an Ubuntu 22.04/24.04 VM with at least 2 vCPU and 4 GB RAM on any cloud provider (DigitalOcean, Hetzner, AWS Lightsail, Azure, and so on). Install Docker Engine with the Compose plugin **v2.24 or later** (`docker compose version`).
2. **DNS.** Create an `A` record (and `AAAA` for IPv6) for your domain, for example `exam.example.edu`, pointing at the server's public IP. Wait until `nslookup exam.example.edu` returns that IP.
3. **Firewall.** Allow inbound TCP 22, 80, and 443 plus UDP 443. Nothing else needs to be open.
4. **Code and secrets.**

   ```bash
   git clone <your-repo-url> accessguard && cd accessguard
   cp .env.example .env
   for k in MONGO_ROOT_PASSWORD JWT_SECRET ADMIN_PASSWORD REMOTE_LOGIN_SECRET; do
     sed -i "s|^$k=.*|$k=$(openssl rand -hex 32)|" .env
   done
   ```

   Then edit `.env` and set:

   ```text
   APP_ORIGIN=https://exam.example.edu
   APP_DOMAIN=exam.example.edu
   ACME_EMAIL=you@example.edu
   ```

   `APP_ORIGIN` must be the exact public origin (scheme and host, no trailing slash). The backend uses it for CORS and to validate the extension's app-origin header.
5. **Start.**

   ```bash
   docker compose -f compose.yaml -f compose.https.yaml up -d --build
   docker compose -f compose.yaml -f compose.https.yaml ps
   docker compose -f compose.yaml -f compose.https.yaml logs --tail=100 caddy backend
   ```

   Caddy requests the certificate on first start; the logs show `certificate obtained successfully`.
6. **Sign in.** Open `https://exam.example.edu/login` and sign in as `ADMIN_INV_ID` (default `admin`) with the `ADMIN_PASSWORD` from `.env`. Demo accounts are not created in production.
7. **Extension.** Because the app and API share one HTTPS origin, the extension trusts it without extra configuration. Load or distribute the `extension/` folder as described below, then run a full rehearsal: join, approve, start, answer, submit, and confirm that the extension releases the browser and the dashboard shows no unexpected events.

Use the same `-f compose.yaml -f compose.https.yaml` flags for every later `build`, `up`, `logs`, and `down` command.

## Public HTTPS behind your own proxy

Keep `APP_BIND_ADDRESS=127.0.0.1` when a reverse proxy runs on the same host, and forward the public HTTPS virtual host to `http://127.0.0.1:8080`. The edge must preserve the `Host` header, set `X-Forwarded-Proto: https`, and support WebSocket upgrades for `/api/ws/`.

If a hosting platform routes directly to the Compose port, set `APP_BIND_ADDRESS=0.0.0.0` and restrict the port with the platform firewall. Do not expose the service over public plain HTTP; camera APIs and the extension trust model require a secure context outside localhost.

The nginx configuration applies SPA fallback, WebSocket proxying, upload limits, cache policy, and browser security headers. Its Content Security Policy currently permits the external services used by the application for fonts, face models, and OCR assets; third-party analytics is disabled by default. If those assets are self-hosted, tighten `frontend/nginx.conf` accordingly.

## Extension installation and packaging

The extension source is in `extension/`. For developer testing:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose the repository's `extension` directory.
4. Reload the extension after changing any extension file.
5. Open the AccessGuard site and confirm the extension reports a healthy connection before starting a test exam.

See [extension/README.md](extension/README.md) for the bridge protocol, authenticated backend contract, enforcement states, and managed-device limitations.

Same-origin HTTPS deployments are trusted automatically, and localhost or `127.0.0.1` loopback ports are accepted for development. A hosted cross-origin layout must place both origins in the extension trust configuration. The extension accepts exact trusted origins from enterprise-managed storage using `trusted_app_origins` and `trusted_api_origins`. Production values should be exact HTTPS origins, for example `https://exam.example.edu`; do not use wildcard origins. Build-time trust anchors `BUILD_TRUSTED_APP_ORIGINS` and `BUILD_TRUSTED_API_ORIGINS` in `extension/config.js` are intended only for a controlled packaged build.

To create a review/upload archive with `manifest.json` at the archive root:

```powershell
New-Item -ItemType Directory -Force artifacts
Compress-Archive -Path extension\* -DestinationPath artifacts\accessguard-lockdown.zip -Force
```

For production, publish through the Chrome Web Store or the institution's managed extension channel and force-install the resulting extension ID through Chrome Enterprise policy. An unpacked developer extension is not a production enforcement mechanism. Validate policy refresh, heartbeat reporting, blocked navigation, invigilator-granted access, session release, browser restart recovery, and fail-closed behavior before rollout.

### How monitoring events are counted

The extension holds the exam window in browser-level fullscreen. The exam page treats either that or HTML element fullscreen as compliant. A focus loss or fullscreen exit is recorded only if it persists (1.5 s for focus, 2 s for fullscreen). Nothing is recorded during short grace windows around exam start, the camera permission prompt, extension mode changes, or submission. The API also collapses repeated reports of the same kind within `VIOLATION_DEDUPE_SEC` (default 5 s); locking kinds are never collapsed. After changing extension code, bump the version in `extension/manifest.json` and reload the extension so students do not run a stale build.

## Operations

### Logs and status

```text
docker compose ps
docker compose logs --follow --tail=200 frontend backend
docker compose logs --tail=200 mongo
```

Container logs rotate at 10 MB with three files. Send logs to a managed destination for production, redact tokens and identity data, and alert on repeated login failures, extension health loss, API errors, and MongoDB storage pressure.

### Updates

```text
docker compose build --pull
docker compose up -d --remove-orphans
docker compose ps
```

Use immutable image tags in a registry for a real release pipeline. Test database compatibility and take a verified backup before application or MongoDB upgrades.

### Backups

The `mongo_data` volume survives container replacement, but a volume is not a backup. Schedule authenticated `mongodump` backups to encrypted off-host storage and routinely test `mongorestore` into an isolated environment. Document retention and deletion schedules for identity images, webcam frames, answers, reports, login audits, and violation records.

### Shutdown

```text
docker compose down
```

This preserves `mongo_data`. `docker compose down --volumes` permanently deletes the database and must not be used as a routine shutdown command.

## Validation commands

Backend unit checks that do not require the live integration stack:

```powershell
cd backend
..\.venv\Scripts\python.exe -m pytest -p no:cacheprovider tests\test_rag_and_features.py -q
..\.venv\Scripts\python.exe -m pytest -p no:cacheprovider tests\test_unit_features.py -q -k fallback
```

Frontend tests and production build:

```powershell
cd frontend
$env:CI = "true"
yarn test --watchAll=false --runInBand --no-cache
yarn build
```

Extension contract and package checks:

```powershell
cd extension
npm test
```

Run API integration tests only against an isolated test database. They create, update, and delete records and must never target production.

## Production checklist

- [ ] Docker images build from a clean checkout and pass vulnerability scanning.
- [ ] `docker compose config` contains no blank required values.
- [ ] Only the HTTPS edge is public; backend and MongoDB ports are closed.
- [ ] Demo accounts, test routes, public registration, and fixed 2FA codes are absent.
- [ ] Secrets come from the hosting secret manager and have a rotation procedure.
- [ ] Database backups and restore drills are scheduled.
- [ ] Extension is signed, force-installed, and configured with exact origins.
- [ ] End-to-end tests cover reconnects, browser restart, camera denial, network loss, and invigilator approval/release.
- [ ] Privacy notices, consent, retention, accessibility, and support procedures are approved.

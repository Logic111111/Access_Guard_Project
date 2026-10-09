
# AccessGuard

AccessGuard is a React and FastAPI exam-monitoring application with invigilator sessions, student verification, live monitoring, violation reporting, grading, and a Chromium lockdown extension.

The web application can detect and report common navigation violations, but it cannot provide a complete operating-system lock by itself. High-assurance deployments need managed devices, a force-installed extension, and browser kiosk or institutional device policy. See [DEPLOYMENT.md](DEPLOYMENT.md) for the security boundary and production checklist.
## Getting Started

### Prerequisites

- Windows 10/11
- [.NET Framework](https://dotnet.microsoft.com/en-us/download/dotnet-framework) (or .NET SDK, depending on project target)
- [Visual Studio](https://visualstudio.microsoft.com/) (recommended IDE for building and debugging both applications)
- All devices (invigilator and student machines) connected to the same Local Area Network (LAN)

### Running the Server Application (Invigilator)

1. Open the Server project solution in Visual Studio.
2. Build the solution (`Ctrl+Shift+B`).
3. Run the Server application on the invigilator's machine.
4. From the dashboard, configure the session: set the URL/application whitelist and start the session.

### Running the Client Application (Student)

1. Open the Client project solution in Visual Studio.
2. Build the solution (`Ctrl+Shift+B`).
3. Run the Client application on each student machine.
4. The client will automatically attempt to connect to the server over the LAN and join the active session.

### Notes

- Both applications must be on the same network for the client to detect and connect to the server.
- No internet connection is required unless whitelisted URLs are accessed during the exam.

## Quick start with Docker Compose

Docker Compose builds the frontend and backend, starts MongoDB with a persistent volume, and exposes the same-origin application at `http://localhost:8080`.

```powershell
Copy-Item .env.example .env
# Fill every blank secret in .env, then set APP_ORIGIN=http://localhost:8080
docker compose config
docker compose build --pull
docker compose up -d
docker compose ps
```

Open `http://localhost:8080`. Before any public deployment, use HTTPS and complete every launch gate in [DEPLOYMENT.md](DEPLOYMENT.md). The backend and MongoDB are intentionally not published to the host.

## Local development and LAN testing

Prerequisites are MongoDB, Python 3.12, Node.js 22, and Yarn 1.x. Install dependencies before the first run:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
cd frontend
yarn install --frozen-lockfile
cd ..
```

### 1. Start the backend on all interfaces

Open a terminal in `backend` and run:

```powershell
cd backend
..\.venv\Scripts\python.exe -m uvicorn server:app --reload --host 0.0.0.0 --port 8000
```

### 2. Start the frontend on all interfaces

Open a terminal in `frontend` and run:

```powershell
cd frontend
yarn start
```

The frontend will bind to `0.0.0.0` using the `.env.development` settings. Other devices on your LAN can then visit:

```text
http://<your-pc-ip>:3000
```

Replace `<your-pc-ip>` with your machine's LAN IP address (for example `192.168.1.45`).

## Backend routing

The browser uses same-origin `/api` requests. During development, Create React App proxies those requests to `http://127.0.0.1:8000`. The production nginx image proxies `/api/` and `/api/ws/` to the backend container, including WebSocket upgrades. Keeping one public origin avoids fragile cross-origin camera, authentication, and extension configuration.

For LAN development, allow Python and Node through the local firewall and visit `http://<your-pc-ip>:3000`. Do not expose the development servers directly to the internet. Use the Compose deployment behind an HTTPS edge for remote or production access.

## Lockdown extension

For a developer install, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the `extension` directory. Production deployments should package and sign the extension, force-install it on managed browsers, and configure exact trusted HTTPS origins through enterprise policy. Detailed load, packaging, and validation steps are in [DEPLOYMENT.md](DEPLOYMENT.md#extension-installation-and-packaging).

## Test commands

```powershell
cd backend
..\.venv\Scripts\python.exe -m pytest -p no:cacheprovider tests\test_rag_and_features.py -q

cd ..\frontend
$env:CI = "true"
yarn test --watchAll=false --runInBand --no-cache
yarn build

cd ..\extension
npm test
```

The API integration suite mutates database records. Run it only with a dedicated test database and an explicit test backend URL.

## Local launcher

`start_test.ps1` remains available for local demos. It can stop processes already listening on ports 3000 and 8000 and writes demo credentials, so review it before running and never use it as a production process manager.

## Future Enhancements

The following items are currently out of scope for this release but are being considered for future iterations:

- **Cross-Platform Support** — extend the Client and Server applications to macOS and Linux, beyond the current Windows-only support.
- **LMS Integration** — connect AccessGuard with external Learning Management Systems (e.g. Moodle, Google Classroom) for automated student/session import, removing the need for manual setup.
- **Mobile Applications** — explore lightweight Android/iOS companion apps for invigilators to monitor sessions on the go.
- **Advanced Violation Detection** — expand beyond basic disconnection/termination alerts to include behavior-based anomaly detection (e.g. unusual mouse/keyboard inactivity patterns).
- **Cloud-Based Session Storage** — optional cloud backup of session logs for institutions running exams across multiple labs or campuses.
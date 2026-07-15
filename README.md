
# AccessGuard

## Run locally for shared LAN testing

### 1. Start the backend on all interfaces

Open a terminal in `backend` and run:

```powershell
cd "d:\Access Guard\backend"
python -m uvicorn server:app --reload --host 0.0.0.0 --port 8000
```

### 2. Start the frontend on all interfaces

Open a terminal in `frontend` and run:

```powershell
cd "d:\Access Guard\frontend"
yarn start
```

The frontend will bind to `0.0.0.0` using the `.env.development` settings. Other devices on your LAN can then visit:

```text
http://<your-pc-ip>:3000
```

Replace `<your-pc-ip>` with your machine's LAN IP address (for example `192.168.1.45`).

## How the app resolves the backend URL

The frontend now defaults to the host used by the browser and connects to port `8000` unless you override it with:

```text
REACT_APP_BACKEND_URL=http://<your-pc-ip>:8000
```

This makes shared LAN testing much easier.

## Remote testing options

### Option 1: LocalTunnel (Easiest, free, no account needed)

```powershell
npm install -g localtunnel
```

In separate terminals:
```powershell
# Frontend
lt --port 3000

# Backend
lt --port 8000
```

Each outputs a unique public URL like `https://random-id.loca.lt`. Share the frontend URL with testers.

If the frontend and backend are on different tunnel URLs, start the frontend with `REACT_APP_BACKEND_URL=https://<backend-loca-url>` so API calls point at the backend tunnel.

### Option 2: Tailscale (Best for teams, VPN-based)

Free personal plan, works on mobile too.

```powershell
choco install tailscale
tailscale up
tailscale ip -4
```

Share your Tailscale IP with team members:
- Frontend: `http://<tailscale-ip>:3000`
- Backend: `http://<tailscale-ip>:8000`

See [scripts/TAILSCALE-SETUP.md](scripts/TAILSCALE-SETUP.md) for details.

### Option 3: Cloudflare Tunnel (Professional, free tier)

Most robust, supports custom domains.

See [scripts/CLOUDFLARE-TUNNEL-SETUP.md](scripts/CLOUDFLARE-TUNNEL-SETUP.md) for setup.

### Option 4: ngrok (if you have authtoken)

```powershell
ngrok config add-authtoken <your-authtoken>
cd "d:\Access Guard"
.\scripts\start-ngrok.ps1 -Mode both
```

Then set the backend URL before starting frontend:
```powershell
set "REACT_APP_BACKEND_URL=https://<backend-ngrok-url>"
yarn start
```

## Notes

- The backend must be reachable from the clients on port `8000` or via a public tunnel.
- The frontend must be reachable on port `3000` or via a public tunnel.
- For **LAN testing**, use `http://<your-pc-ip>:3000` (your local IP is `10.124.6.67`).

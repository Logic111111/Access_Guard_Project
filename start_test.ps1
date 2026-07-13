# ============================================================
#  AccessGuard - Local Test Mode
#  Starts backend + frontend, seeds a demo session, then
#  opens two browser windows (Invigilator & Student).
# ============================================================

$ErrorActionPreference = "Continue"
$APP_HOST = "localhost"
$BACKEND_PORT = 8000
$FRONTEND_PORT = 3000
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "       AccessGuard - Local Test Mode Launcher        " -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host ""

# ----------------------------------------------------------
# 1. Check MongoDB
# ----------------------------------------------------------
Write-Host "[1/5] Checking MongoDB..." -ForegroundColor Yellow
$mongoRunning = $false
try {
    $mongoProc = Get-Process mongod -ErrorAction SilentlyContinue
    if ($mongoProc) { $mongoRunning = $true }
} catch {}

if (-not $mongoRunning) {
    # Try connecting via TCP
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $tcp.Connect("localhost", 27017)
        $tcp.Close()
        $mongoRunning = $true
    } catch {}
}

if ($mongoRunning) {
    Write-Host "  MongoDB is running." -ForegroundColor Green
} else {
    Write-Host "  WARNING: MongoDB does not appear to be running on port 27017." -ForegroundColor Red
    Write-Host "  Please start MongoDB before continuing." -ForegroundColor Red
    Write-Host "  If using Docker: docker run -d -p 27017:27017 --name mongo mongo:7" -ForegroundColor Gray
    Write-Host ""
    $continue = Read-Host "  Continue anyway? (y/N)"
    if ($continue -ne "y" -and $continue -ne "Y") {
        Write-Host "Exiting." -ForegroundColor Red
        exit 1
    }
}

# ----------------------------------------------------------
# 2. Start Backend
# ----------------------------------------------------------
Write-Host ""
Write-Host "[2/5] Starting Backend (FastAPI on port $BACKEND_PORT)..." -ForegroundColor Yellow

# Kill any existing process on port 8000
$existingBackend = Get-NetTCPConnection -LocalPort $BACKEND_PORT -ErrorAction SilentlyContinue |
    Where-Object { $_.State -eq "Listen" } |
    Select-Object -First 1
if ($existingBackend) {
    Write-Host "  Port $BACKEND_PORT already in use (PID $($existingBackend.OwningProcess)). Killing..." -ForegroundColor DarkYellow
    Stop-Process -Id $existingBackend.OwningProcess -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

$backendJob = Start-Job -ScriptBlock {
    param($root, $port)
    Set-Location "$root\backend"
    & python -m uvicorn server:app --host 0.0.0.0 --port $port --reload 2>&1
} -ArgumentList $ROOT, $BACKEND_PORT

Write-Host "  Backend starting (Job ID: $($backendJob.Id))..." -ForegroundColor Green

# Wait for backend to be ready
$maxWait = 30
$waited = 0
Write-Host "  Waiting for backend to be ready..." -NoNewline
while ($waited -lt $maxWait) {
    Start-Sleep -Seconds 1
    $waited++
    Write-Host "." -NoNewline
    try {
        $response = Invoke-WebRequest -Uri "http://${APP_HOST}:${BACKEND_PORT}/api/auth/me" -Method GET -TimeoutSec 2 -ErrorAction SilentlyContinue
    } catch {
        $statusCode = $null
        if ($_.Exception.Response) {
            $statusCode = [int]$_.Exception.Response.StatusCode
        }
        # 401/403 means the server is up (just not authenticated)
        if ($statusCode -eq 401 -or $statusCode -eq 403 -or $statusCode -eq 422) {
            break
        }
    }
}
Write-Host ""
if ($waited -ge $maxWait) {
    Write-Host "  WARNING: Backend may not be ready yet. Check logs." -ForegroundColor Red
} else {
    Write-Host "  Backend is ready!" -ForegroundColor Green
}

# ----------------------------------------------------------
# 3. Seed Test Data
# ----------------------------------------------------------
Write-Host ""
Write-Host "[3/5] Seeding test data..." -ForegroundColor Yellow

$seedResult = $null
try {
    $seedResponse = Invoke-RestMethod -Uri "http://${APP_HOST}:${BACKEND_PORT}/api/test/seed" -Method POST -ContentType "application/json" -TimeoutSec 10
    $seedResult = $seedResponse
    Write-Host "  Test data seeded successfully!" -ForegroundColor Green
} catch {
    Write-Host "  WARNING: Could not seed test data: $_" -ForegroundColor Red
    Write-Host "  You can manually seed later: POST http://localhost:${BACKEND_PORT}/api/test/seed" -ForegroundColor Gray
}

# ----------------------------------------------------------
# 4. Start Frontend
# ----------------------------------------------------------
Write-Host ""
Write-Host "[4/5] Starting Frontend (React on port $FRONTEND_PORT)..." -ForegroundColor Yellow

# Kill any existing process on port 3000
$existingFrontend = Get-NetTCPConnection -LocalPort $FRONTEND_PORT -ErrorAction SilentlyContinue |
    Where-Object { $_.State -eq "Listen" } |
    Select-Object -First 1
if ($existingFrontend) {
    Write-Host "  Port $FRONTEND_PORT already in use (PID $($existingFrontend.OwningProcess)). Killing..." -ForegroundColor DarkYellow
    Stop-Process -Id $existingFrontend.OwningProcess -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

$frontendJob = Start-Job -ScriptBlock {
    param($root, $port)
    Set-Location "$root\frontend"
    $env:PORT = $port
    $env:BROWSER = "none"
    $env:HTTPS = "true"
    & yarn start 2>&1
} -ArgumentList $ROOT, $FRONTEND_PORT

Write-Host "  Frontend starting (Job ID: $($frontendJob.Id))..." -ForegroundColor Green

# Wait for frontend to be ready
$waited = 0
$maxWait = 60
Write-Host "  Waiting for frontend to compile..." -NoNewline
while ($waited -lt $maxWait) {
    Start-Sleep -Seconds 2
    $waited += 2
    Write-Host "." -NoNewline
    try {
        $resp = Invoke-WebRequest -Uri "https://${APP_HOST}:${FRONTEND_PORT}" -Method GET -TimeoutSec 3 -SkipCertificateCheck -ErrorAction SilentlyContinue
        if ($resp.StatusCode -eq 200) { break }
    } catch {}
}
Write-Host ""
if ($waited -ge $maxWait) {
    Write-Host "  WARNING: Frontend may still be compiling. Give it a moment." -ForegroundColor DarkYellow
} else {
    Write-Host "  Frontend is ready!" -ForegroundColor Green
}

# ----------------------------------------------------------
# 5. Print Credentials & Open Browsers
# ----------------------------------------------------------
Write-Host ""
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "       AccessGuard Test Mode - READY!               " -ForegroundColor Green
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  INVIGILATOR LOGIN:" -ForegroundColor White
Write-Host "    ID:       EG/STAFF/0001" -ForegroundColor Yellow
Write-Host "    Password: AccessGuard2026!" -ForegroundColor Yellow
Write-Host "    URL:      http://${APP_HOST}:${FRONTEND_PORT}/login" -ForegroundColor Cyan
Write-Host ""

if ($seedResult) {
    $sessionCode = $seedResult.session.session_code
    Write-Host "  STUDENT ACCESS:" -ForegroundColor White
    Write-Host "    Session Code: $sessionCode" -ForegroundColor Yellow
    Write-Host "    URL:          http://${APP_HOST}:${FRONTEND_PORT}/student" -ForegroundColor Cyan
} else {
    Write-Host "  STUDENT ACCESS:" -ForegroundColor White
    Write-Host "    URL:          http://${APP_HOST}:${FRONTEND_PORT}/student" -ForegroundColor Cyan
    Write-Host "    (Create a session as invigilator first to get a code)" -ForegroundColor Gray
}

Write-Host ""
Write-Host "  BACKEND API:    http://${APP_HOST}:${BACKEND_PORT}/api" -ForegroundColor Gray
Write-Host "  API DOCS:       http://${APP_HOST}:${BACKEND_PORT}/docs" -ForegroundColor Gray
Write-Host ""
Write-Host "====================================================" -ForegroundColor Cyan

# Save credentials to file
$credFile = Join-Path $ROOT "test_credentials.md"
$credContent = @"
# AccessGuard - Test Mode Credentials

## Invigilator Login
- **ID:** EG/STAFF/0001
- **Password:** AccessGuard2026!
- **URL:** http://${APP_HOST}:${FRONTEND_PORT}/login

## Student Access
- **Session Code:** $(if ($seedResult) { $seedResult.session.session_code } else { "(run seed first)" })
- **URL:** http://${APP_HOST}:${FRONTEND_PORT}/student

## Backend
- **API Base:** http://${APP_HOST}:${BACKEND_PORT}/api
- **API Docs:** http://${APP_HOST}:${BACKEND_PORT}/docs

## Useful Commands
- **Reset test data:** ``Invoke-RestMethod -Uri "http://localhost:${BACKEND_PORT}/api/test/reset" -Method DELETE``
- **Re-seed:** ``Invoke-RestMethod -Uri "http://localhost:${BACKEND_PORT}/api/test/seed" -Method POST``
"@
$credContent | Out-File -FilePath $credFile -Encoding UTF8
Write-Host "  Credentials saved to: test_credentials.md" -ForegroundColor Gray

# Open browser windows
Write-Host ""
Write-Host "  Opening browser windows..." -ForegroundColor Yellow
Start-Sleep -Seconds 2
Start-Process "http://${APP_HOST}:${FRONTEND_PORT}/login"
Start-Sleep -Seconds 1
Start-Process "http://${APP_HOST}:${FRONTEND_PORT}/student"

Write-Host ""
Write-Host "  Press Ctrl+C to stop all servers." -ForegroundColor DarkYellow
Write-Host ""

# Keep running and show logs
try {
    while ($true) {
        # Show backend logs
        $backendOutput = Receive-Job -Job $backendJob -ErrorAction SilentlyContinue
        if ($backendOutput) {
            $backendOutput | ForEach-Object { Write-Host "[BACKEND] $_" -ForegroundColor DarkGray }
        }
        # Show frontend logs
        $frontendOutput = Receive-Job -Job $frontendJob -ErrorAction SilentlyContinue
        if ($frontendOutput) {
            $frontendOutput | ForEach-Object { Write-Host "[FRONTEND] $_" -ForegroundColor DarkGray }
        }
        Start-Sleep -Seconds 2
    }
} finally {
    Write-Host ""
    Write-Host "Shutting down..." -ForegroundColor Yellow
    Stop-Job -Job $backendJob -ErrorAction SilentlyContinue
    Remove-Job -Job $backendJob -Force -ErrorAction SilentlyContinue
    Stop-Job -Job $frontendJob -ErrorAction SilentlyContinue
    Remove-Job -Job $frontendJob -Force -ErrorAction SilentlyContinue
    Write-Host "All servers stopped." -ForegroundColor Green
}

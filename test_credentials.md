# AccessGuard - Test Mode Credentials

## Invigilator Login
- **ID:** EG/STAFF/0001
- **Password:** AccessGuard2026!
- **URL:** http://localhost:3000/login

## Student Access
- **Session Code:** 6849-8778-6045
- **URL:** http://localhost:3000/student

## Backend
- **API Base:** http://localhost:8000/api
- **API Docs:** http://localhost:8000/docs

## Useful Commands
- **Reset test data:** `Invoke-RestMethod -Uri "http://localhost:8000/api/test/reset" -Method DELETE`
- **Re-seed:** `Invoke-RestMethod -Uri "http://localhost:8000/api/test/seed" -Method POST`

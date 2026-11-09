# StudyFlow

StudyFlow is a local assignment tracker backed by Node.js 24's built-in SQLite support. It helps students track coursework and gives students and teachers browser reminders for upcoming and overdue deadlines. No runtime packages or external database are required.

## Run locally

1. Install [Node.js 24 or newer](https://nodejs.org/).
2. From this folder, run `node server.js` (or `npm.cmd start` in PowerShell).
3. Open [http://127.0.0.1:3001](http://127.0.0.1:3001). StudyFlow uses port 3001 by default to avoid clashing with other local apps. Do not open `index.html` directly; the app needs its local server.
4. Students can create accounts from the sign-in screen. Passwords must be 8–128 characters.

The database is created automatically at `data/studyflow.sqlite`. Keep the `data/` folder private and back it up to preserve accounts, assignments, and progress.

## Set up the teacher reminder account

Set credentials in the current PowerShell session and run the one-time setup command:

```powershell
$env:ADMIN_EMAIL = "admin@example.com"
$secureAdminPassword = Read-Host "Choose a password with at least 12 characters" -AsSecureString
$env:ADMIN_PASSWORD = [System.Net.NetworkCredential]::new("", $secureAdminPassword).Password
npm.cmd run create-admin
Remove-Variable secureAdminPassword
Remove-Item Env:ADMIN_EMAIL, Env:ADMIN_PASSWORD
```

The password is stored as a salted hash. Student registration cannot grant teacher reminder access, and setup refuses to create a second teacher account.

## Assignment and reminder workflow

- Students add assignments their teachers have given them, set due dates and priorities, and track progress.
- A seven-day plan groups unfinished assignments by due date, while the assignment list tracks all coursework.
- Each assignment can schedule a browser alert for one week, three days, one day, or the due date. Alerts are checked every minute while signed in.
- The **Teacher reminders** sign-in opens a focused deadline view across student assignments. It does not include student management, grading, or a submission-review portal.
- Students and teachers can enable browser notifications. Keep the relevant StudyFlow page open and signed in on each device to receive scheduled alerts; browser notifications are device-specific and are not sent by email.
- Students do not submit work for teacher review in this app; the focus is assignment tracking and reminders.
- New student accounts are signed in automatically after registration.
- In-app reminders show overdue assignments and deadlines within seven days, even if browser notifications are unavailable or blocked.

Run the backend tests with `node --test` (or `npm.cmd test` in PowerShell).

## Security notes

StudyFlow stores hashed passwords and hashed, expiring server-side session tokens in SQLite. Mutating requests are checked against the same origin. The server binds to loopback by default; use HTTPS and a production-ready host before exposing the app to a network.

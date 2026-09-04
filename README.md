# VIJETA Final System

This is the server-backed final architecture for the VIJETA calculator.

## What is protected
- Public Agent/DO link opens directly. No Google Sign-in and no user account is required.
- Only the server-authenticated Admin can add, edit, archive, delete competitions or replace/delete posters.
- Admin password is **not stored in the HTML/JavaScript**. It is read from `ADMIN_PASSWORD` on the server.
- Expired competitions automatically stop appearing in active inputs/milestones because the existing VIJETA engine checks competition dates.
- Historical base milestones remain available; dynamic competition records are stored in SQLite.
- Poster deletion and competition deletion are separate actions.
- AI poster reading is proposal-only: the Admin must review and publish.

## Run locally
1. Install Node.js 20+.
2. Copy `.env.example` to `.env`.
3. Set a strong `ADMIN_PASSWORD`.
4. Run:
   ```bash
   npm install
   npm start
   ```
5. Open `http://localhost:3000`.
6. Share that same URL with Agents/DOs. They can use it without login.
7. Admin opens Posters → Admin Unlock and enters the server password.

## AI poster extraction (optional)
Set `OPENAI_API_KEY` in `.env`. The Admin can upload a poster and click **Read Poster with AI**. The result is only a draft; verify every date, target, condition and reward before publishing.

If no API key is configured, the system still works with manual structured rule entry.

## Production deployment
Deploy the whole folder to a Node-capable host (for example a VPS/container platform). Use:
- `NODE_ENV=production`
- a strong random `ADMIN_PASSWORD`
- HTTPS (required for the Secure admin cookie in production)
- persistent storage for `data/vijeta.db` and regular backups.

The public URL is the only URL you need to share with Agents/DOs. No Google authentication is part of this system.

## Important operational rule
Do not expose the `.env` file or the SQLite database publicly. Keep Admin password private. The browser UI is not the security boundary; the server API is.

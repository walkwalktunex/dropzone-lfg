# DropZone LFG Pro

A Fortnite LFG-style community site with accounts, persistent rooms, private/password rooms, player limits, chat, WebRTC voice, reporting, and moderation.

## Render setup
1. Create a Render PostgreSQL database.
2. Create a Render Web Service from this repository.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variables from `.env.example`:
   - `DATABASE_URL` from your Render Postgres database
   - `SESSION_SECRET` to a long random string
   - `ADMIN_EMAIL` to the email that should receive moderator privileges on registration
   - `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` from your TURN provider
6. Deploy.

The app initializes its tables on startup.

## TURN
The app will fall back to Google STUN, but public voice reliability is better with TURN. A TURN provider such as Twilio Network Traversal, Metered, or a self-hosted coturn server can supply the credentials. Put the provider's URLs/username/credential into the Render environment variables.

## Important security notes
- Use a strong `SESSION_SECRET` and never commit `.env`.
- Set `NODE_ENV=production` on Render.
- The first account whose email matches `ADMIN_EMAIL` gets moderator privileges. Change this environment variable before production or replace it with a proper invite/role flow.
- Passwords are hashed with bcrypt.
- Room passwords are hashed with bcrypt.

## Current MVP moderation
Moderators can view open reports, resolve them, and temporarily ban a reported user. For a larger community, add audit logs, IP/device abuse controls, rate limits, CAPTCHA, content filtering, and permanent bans.

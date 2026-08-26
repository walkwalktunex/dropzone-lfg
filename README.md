# DropZone LFG Pro — fixed / no-login edition

This build keeps users as guests. There is **no registration or login screen**. Players enter only a display name, then they can create, join, chat in, report, and manage rooms they own.

## Included
- Public + private/password rooms
- 2–64 player limit
- Room owner controls
- Empty custom rooms auto-delete when everyone leaves
- Permanent public Lobby room
- Live room counts and player presence
- Socket.IO real-time chat
- WebRTC voice with TURN support via environment variables
- Reporting + moderator key panel
- Render-friendly Postgres sessions
- Better error messages and proxy/cookie handling for Render

## Render
Build: `npm install`
Start: `npm start`

Required environment variables:
- `DATABASE_URL`
- `SESSION_SECRET`
- `NODE_ENV=production`

Optional:
- `TURN_URLS`
- `TURN_USERNAME`
- `TURN_CREDENTIAL`
- `MODERATOR_KEY`

Do not commit `.env`.

# DropZone No-Login Create Rooms Patch

This version removes the login requirement from room creation and other player actions.

- Visitors are automatically given a guest session.
- A display name is taken from `localStorage` when available; otherwise a Guest name is generated.
- Creating, editing, deleting, and reporting rooms no longer returns `Login required.`
- Room ownership still works because each guest receives a server-side user record.
- Admin/moderator endpoints remain protected.

Deploy the project normally with `npm start`.

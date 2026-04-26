# Verify Calendar Tool

After install, ask the bot a calendar question in any registered group:

> What's on my calendar tomorrow?

Expected: bot calls `mcp__calendar__list_events`, returns events from the primary calendar (and any in `CALENDAR_IDS`).

Then test a write:

> Add a calendar event tomorrow at 3pm called "test event"

Expected: bot calls `mcp__calendar__create_event`, returns event ID and confirmation.  Verify on Google Calendar UI.

## Troubleshooting

**"OAuth keys file not found at /workspace/group/.calendar-mcp/gcp-oauth.keys.json"**:
- Check the symlink: `ls -la groups/main/.calendar-mcp/`
- Both `gcp-oauth.keys.json` and `credentials.json` must be readable inside the container.

**"Token expired" / refresh errors**:
- Run `node scripts/auth-calendar.js` again on host to refresh.
- Re-link if needed: `ln -sf ~/.calendar-mcp/credentials.json groups/main/.calendar-mcp/credentials.json`

**Multi-calendar IDs not querying**:
- Verify `CALENDAR_IDS` reached the container: `grep CALENDAR_IDS data/env/env`
- IDs must be exactly the calendar IDs from Google Calendar settings (often look like `xxxx@group.calendar.google.com`).

---
name: add-calendar-tool
description: Add Google Calendar MCP server (multi-calendar list/search/create/update/delete events) to the agent container.  OAuth-based, vendored from gongrzhe/server-calendar-autoauth-mcp with multi-calendar support.
---

# Add Google Calendar Tool

Adds a Google Calendar MCP server to the agent container.  The agent gains `mcp__calendar__*` tools for listing events, creating/updating/deleting events on the primary calendar, and querying free/busy across multiple calendars defined in `CALENDAR_IDS`.

OAuth keys and tokens live on the host filesystem (or inside the per-group folder mounted as `/workspace/group`).  No OneCLI integration; this is the v1 file-based pattern.

## Phase 1: Pre-flight (idempotent)

Skip to **Phase 2: Credentials** if all of these are already in place:

- `container/agent-runner/src/calendar-mcp.ts` exists
- `container/agent-runner/src/index.ts` has a `calendar:` entry under `mcpServers`
- `'mcp__calendar__*'` is in `allowedTools`
- `scripts/auth-calendar.js` exists on the host

Otherwise continue.

### 1. Fetch the skill branch

```bash
git fetch origin skill/calendar-tool
```

### 2. Copy the MCP server source

```bash
git show origin/skill/calendar-tool:container/agent-runner/src/calendar-mcp.ts > container/agent-runner/src/calendar-mcp.ts
```

### 3. Wire into agent-runner

In `container/agent-runner/src/index.ts`:

Add `'mcp__calendar__*'` to the `allowedTools` array.

Add to the `mcpServers` object:

```typescript
calendar: {
  command: 'node',
  args: [path.join(__dirname, 'calendar-mcp.js')],
  env: {
    ...sdkEnv,
    HOME: '/workspace/group',
    CALENDAR_IDS: process.env.CALENDAR_IDS || 'primary',
  },
},
```

Note the `HOME: '/workspace/group'` override -- the MCP server reads OAuth files from `$HOME/.calendar-mcp/`, so this redirects it to the per-group mount.

### 4. Build

```bash
npm run build
./container/build.sh
```

## Phase 2: Credentials

### 2a. GCP project + OAuth client

1. Open the Google Cloud Console: https://console.cloud.google.com/
2. Create or select a project.
3. Enable the **Google Calendar API**.
4. Configure the OAuth consent screen (External, internal use is fine).
5. Create OAuth 2.0 credentials, type **Desktop app**.
6. Download the JSON.

### 2b. Place the OAuth keys file

Two options depending on where the container expects them.  The wiring above sets `HOME=/workspace/group` which makes the container look in the group folder.  But `scripts/auth-calendar.js` runs on the host and writes to host `~/.calendar-mcp/`.

Practical setup that works with both:

```bash
# Host: place the downloaded OAuth client JSON
mkdir -p ~/.calendar-mcp
mv ~/Downloads/client_secret_*.json ~/.calendar-mcp/gcp-oauth.keys.json

# Symlink (or copy) into the group folder so the container can see it
mkdir -p groups/main/.calendar-mcp
ln -sf ~/.calendar-mcp/gcp-oauth.keys.json groups/main/.calendar-mcp/gcp-oauth.keys.json
```

After OAuth completes (next step), do the same for `credentials.json`.

### 2c. Run the OAuth flow on the host

```bash
node scripts/auth-calendar.js
```

The script prints a URL.  Open it in a browser, sign in with the Google account the agent will act as, grant calendar access.  The script captures the redirect, exchanges the code for tokens, and writes `~/.calendar-mcp/credentials.json`.

Then:

```bash
ln -sf ~/.calendar-mcp/credentials.json groups/main/.calendar-mcp/credentials.json
```

### 2d. Configure CALENDAR_IDS (optional)

By default the MCP queries the user's primary calendar.  To include additional calendars (read-only, for free/busy and list operations):

```bash
echo 'CALENDAR_IDS=primary,family@group.calendar.google.com,work@example.com' >> .env
```

Sync to container env:

```bash
mkdir -p data/env && cp .env data/env/env
```

Write operations always target `primary`.

## Phase 3: Restart

```bash
systemctl --user restart nanoclaw
```

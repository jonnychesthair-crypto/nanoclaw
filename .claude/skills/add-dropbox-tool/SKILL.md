---
name: add-dropbox-tool
description: Add Dropbox MCP server (file ops with headless refresh-token auth) to the agent container.  Power Glove only -- Jeeves never has Dropbox.
---

# Add Dropbox Tool

Adds a Dropbox MCP server.  The agent gains `mcp__dropbox__*` tools for Dropbox file/folder operations (list, search, read, upload, move, copy, delete).  Headless auth -- no browser flow at runtime; uses a long-lived refresh token to mint short-lived access tokens.

**Power Glove only.**  Jeeves explicitly does NOT have Dropbox per Jon's account-separation rule.  Do not install this on the Jeeves instance.

## Phase 1: Pre-flight (idempotent)

Skip to **Phase 2: Credentials** if all of these are already present:

- `container/agent-runner/src/dropbox-mcp.ts` exists
- `container/agent-runner/src/index.ts` has a `dropbox:` entry under `mcpServers`
- `'mcp__dropbox__*'` is in `allowedTools`
- `scripts/refresh-dropbox-token.sh` exists on the host
- Crontab has a `*/3 * * *` entry running `refresh-dropbox-token.sh`

Otherwise:

### 1. Fetch the skill branch

```bash
git fetch origin skill/dropbox-tool
```

### 2. Copy the MCP server source

```bash
git show origin/skill/dropbox-tool:container/agent-runner/src/dropbox-mcp.ts > container/agent-runner/src/dropbox-mcp.ts
```

### 3. Wire into agent-runner

In `container/agent-runner/src/index.ts`:

Add `'mcp__dropbox__*'` to `allowedTools`.

Add to `mcpServers`:

```typescript
dropbox: {
  command: 'node',
  args: [path.join(__dirname, 'dropbox-mcp.js')],
  env: {
    ...sdkEnv,
    DROPBOX_CLIENT_ID: process.env.DROPBOX_CLIENT_ID || '',
    DROPBOX_CLIENT_SECRET: process.env.DROPBOX_CLIENT_SECRET || '',
    DROPBOX_REFRESH_TOKEN: process.env.DROPBOX_REFRESH_TOKEN || '',
  },
},
```

Note: only the refresh token is wired in -- the MCP server mints short-lived access tokens itself.  No `DROPBOX_ACCESS_TOKEN` needed in the env.

### 4. Build

```bash
npm run build
./container/build.sh
```

### 5. Remove the deprecated Go binary (if present)

The old Dropbox MCP was a Go binary at `container/dropbox-mcp-server`, copied into `/usr/local/bin/dropbox-mcp-server` via the Dockerfile.  This is now superseded.  Remove the Dockerfile lines:

```dockerfile
COPY dropbox-mcp-server /usr/local/bin/dropbox-mcp-server
RUN chmod +x /usr/local/bin/dropbox-mcp-server
```

The binary itself is gitignored at the repo root.

## Phase 2: Credentials

### 2a. Create a Dropbox app

1. https://www.dropbox.com/developers/apps -- Create app.
2. Choose **Scoped access**, **Full Dropbox** (or specific app folder).
3. Permissions tab: enable `files.metadata.read`, `files.content.read`, `files.content.write` (and any others you want).
4. Settings tab: copy the **App key** (CLIENT_ID) and **App secret** (CLIENT_SECRET).

### 2b. Get a refresh token (headless)

Generate the auth URL with `token_access_type=offline` (the magic incantation that returns a refresh token):

```
https://www.dropbox.com/oauth2/authorize?client_id=<APP_KEY>&token_access_type=offline&response_type=code
```

Open in browser, authorize, copy the auth code.  Exchange for a refresh token (replace placeholders):

```bash
curl -s https://api.dropboxapi.com/oauth2/token \
  -d code=<AUTH_CODE> \
  -d grant_type=authorization_code \
  -d client_id=<APP_KEY> \
  -d client_secret=<APP_SECRET>
```

Response includes `refresh_token` -- save it; it doesn't expire.

### 2c. Add to `.env`

```
DROPBOX_CLIENT_ID=<APP_KEY>
DROPBOX_CLIENT_SECRET=<APP_SECRET>
DROPBOX_REFRESH_TOKEN=<REFRESH_TOKEN>
DROPBOX_ACCESS_TOKEN=<short-lived; populated by refresh script>
```

No additional sync step needed on Power Glove -- `src/container-runner.ts` forwards the `DROPBOX_*` vars to the container via docker `-e` flags from the running service's process env.  See the host `CLAUDE.md` "Power Glove env injection" note for the upstream-vs-fork divergence.

### 2d. Install the refresh cron

The access token expires every ~4 hours.  `scripts/refresh-dropbox-token.sh` mints a fresh one and updates `.env`.  Add to crontab:

```
0 */3 * * * /home/melto007/nanoclaw/scripts/refresh-dropbox-token.sh
```

(Already installed on Power Glove.)

## Phase 3: Restart

```bash
systemctl --user restart nanoclaw
```

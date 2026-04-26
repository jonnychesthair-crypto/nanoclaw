---
name: add-drive-tool
description: Add Google Drive MCP server (search, list, read, download files) to the agent container.  OAuth-based, file-mounted credentials, v1 pattern.
---

# Add Google Drive Tool

Adds a Google Drive MCP server.  The agent gains `mcp__drive__*` tools for searching files, listing folders, reading file contents, and downloading attachments.  Sibling to /add-calendar-tool -- shares the same OAuth/credential pattern, scoped to drive.

## Phase 1: Pre-flight (idempotent)

Skip to **Phase 2: Credentials** if all of these are already present:

- `container/agent-runner/src/drive-mcp.ts` exists
- `container/agent-runner/src/index.ts` has a `drive:` entry under `mcpServers`
- `'mcp__drive__*'` is in `allowedTools`

Otherwise:

### 1. Fetch the skill branch

```bash
git fetch origin skill/drive-tool
```

### 2. Copy the MCP server source

```bash
git show origin/skill/drive-tool:container/agent-runner/src/drive-mcp.ts > container/agent-runner/src/drive-mcp.ts
```

### 3. Wire into agent-runner

In `container/agent-runner/src/index.ts`:

Add `'mcp__drive__*'` to `allowedTools`.

Add to `mcpServers`:

```typescript
drive: {
  command: 'node',
  args: [path.join(__dirname, 'drive-mcp.js')],
  env: {
    ...sdkEnv,
    HOME: '/workspace/group',
  },
},
```

`HOME=/workspace/group` makes the MCP read OAuth files from the group folder mount.

### 4. Build

```bash
npm run build
./container/build.sh
```

## Phase 2: Credentials

### 2a. GCP OAuth client

1. https://console.cloud.google.com/ -- create or select a project.
2. Enable the **Google Drive API**.
3. OAuth consent screen configured (External is fine for personal use).
4. Create OAuth 2.0 credentials, type **Desktop app**.
5. Download the JSON.

### 2b. Place the keys + run OAuth

The container reads from `/workspace/group/.drive-mcp/`.  The bootstrap is host-side and writes to `~/.drive-mcp/`.  Symlink to bridge:

```bash
mkdir -p ~/.drive-mcp groups/main/.drive-mcp
mv ~/Downloads/client_secret_*.json ~/.drive-mcp/gcp-oauth.keys.json
ln -sf ~/.drive-mcp/gcp-oauth.keys.json groups/main/.drive-mcp/gcp-oauth.keys.json
```

Run the OAuth flow on the host (similar pattern to scripts/auth-calendar.js -- adapt the script for Drive scopes if not already present).  Scopes needed: `https://www.googleapis.com/auth/drive.readonly` (or `drive` for full access).

After it writes `~/.drive-mcp/credentials.json`:

```bash
ln -sf ~/.drive-mcp/credentials.json groups/main/.drive-mcp/credentials.json
```

### 2c. (Optional) override paths via env

`DRIVE_OAUTH_PATH` and `DRIVE_CREDENTIALS_PATH` env vars override the default `$HOME/.drive-mcp/` paths if you prefer a different layout.

## Phase 3: Restart

```bash
systemctl --user restart nanoclaw
```

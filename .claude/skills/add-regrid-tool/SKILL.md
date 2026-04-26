---
name: add-regrid-tool
description: Add Regrid Parcel Data MCP server (parcel lookup by address, coordinates, owner, APN, field queries) to the agent container.  Reads REGRID_API_TOKEN env var.
---

# Add Regrid Parcel Data Tool

Adds the Regrid Parcel API (https://app.regrid.com/api/v2) as an MCP server.  The container agent gains `mcp__regrid__*` tools for parcel lookup by address, point-in-radius, owner name, APN, and field-based queries.

API token is read from the `REGRID_API_TOKEN` env var on the host.  No OneCLI integration; this is a v1-pattern skill.

## Phase 1: Pre-flight (idempotent)

Skip to **Phase 2: Credentials** if all of these are already in place (idempotent re-run):

- `container/agent-runner/src/regrid-mcp.ts` exists
- `container/agent-runner/src/index.ts` has a `regrid:` entry under `mcpServers`
- `container/agent-runner/src/index.ts` has `'mcp__regrid__*'` in `allowedTools`

Otherwise continue.

### 1. Fetch the skill branch

```bash
git fetch origin skill/regrid-tool
```

### 2. Copy the MCP server source

```bash
git show origin/skill/regrid-tool:container/agent-runner/src/regrid-mcp.ts > container/agent-runner/src/regrid-mcp.ts
```

### 3. Wire into agent-runner

In `container/agent-runner/src/index.ts`:

Add `'mcp__regrid__*'` to the `allowedTools` array (alongside the other `mcp__*__*` entries).

Add to the `mcpServers` object:

```typescript
regrid: {
  command: 'node',
  args: [path.join(__dirname, 'regrid-mcp.js')],
  env: {
    REGRID_API_TOKEN: process.env.REGRID_API_TOKEN || '',
  },
},
```

### 4. Build

```bash
npm run build
./container/build.sh
```

## Phase 2: Credentials

1. Sign in at https://app.regrid.com/account/profile
2. Generate or copy an API token
3. Add to host `.env`:

   ```
   REGRID_API_TOKEN=<your-token>
   ```

4. No additional sync step needed on Power Glove.  `src/container-runner.ts` injects env vars into the container via docker `-e` flags from the running nanoclaw service's process env (which systemd loads from `.env`).  See the host `CLAUDE.md` "Power Glove env injection" note for context, including the upstream-vs-fork divergence.

## Phase 3: Restart

```bash
systemctl --user restart nanoclaw
```

## Tools exposed (subject to implementation)

- `mcp__regrid__address_search` -- parcel lookup by street address
- `mcp__regrid__point_search` -- parcels within a radius of a lat/lon
- `mcp__regrid__owner_search` -- search by owner name (min 4 chars)
- `mcp__regrid__apn_search` -- lookup by parcel APN
- `mcp__regrid__field_query` -- arbitrary field-based queries

Run `tools/list` against the regrid MCP server to enumerate the exact set.

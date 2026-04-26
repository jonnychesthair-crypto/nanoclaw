# Remove Calendar Tool

1. Delete the MCP server source:

   ```bash
   rm container/agent-runner/src/calendar-mcp.ts
   ```

2. In `container/agent-runner/src/index.ts`:

   - Remove `'mcp__calendar__*'` from `allowedTools`
   - Remove the `calendar:` entry from `mcpServers`

3. Optionally revoke the OAuth grant at https://myaccount.google.com/permissions and delete the host credentials:

   ```bash
   rm -rf ~/.calendar-mcp
   rm -rf groups/main/.calendar-mcp
   sed -i '/^CALENDAR_IDS=/d' .env data/env/env 2>/dev/null || true
   ```

4. Optionally remove the bootstrap script:

   ```bash
   rm scripts/auth-calendar.js
   ```

5. Rebuild:

   ```bash
   npm run build
   ./container/build.sh
   ```

6. Restart:

   ```bash
   systemctl --user restart nanoclaw
   ```

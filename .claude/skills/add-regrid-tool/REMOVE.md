# Remove Regrid Tool

1. Delete the MCP server source:

   ```bash
   rm container/agent-runner/src/regrid-mcp.ts
   ```

2. In `container/agent-runner/src/index.ts`:

   - Remove `'mcp__regrid__*'` from `allowedTools`
   - Remove the `regrid:` entry from `mcpServers`

3. Optionally remove the env var:

   ```bash
   sed -i '/^REGRID_API_TOKEN=/d' .env
   sed -i '/^REGRID_API_TOKEN=/d' data/env/env 2>/dev/null || true
   ```

4. Rebuild:

   ```bash
   npm run build
   ./container/build.sh
   ```

5. Restart:

   ```bash
   systemctl --user restart nanoclaw
   ```

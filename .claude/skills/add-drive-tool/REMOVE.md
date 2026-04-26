# Remove Drive Tool

1. Delete the source:

   ```bash
   rm container/agent-runner/src/drive-mcp.ts
   ```

2. In `container/agent-runner/src/index.ts`:

   - Remove `'mcp__drive__*'` from `allowedTools`
   - Remove the `drive:` entry from `mcpServers`

3. Optionally revoke OAuth at https://myaccount.google.com/permissions and delete credentials:

   ```bash
   rm -rf ~/.drive-mcp groups/main/.drive-mcp
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

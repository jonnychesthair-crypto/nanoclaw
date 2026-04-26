# Remove Dropbox Tool

1. Delete the source:

   ```bash
   rm container/agent-runner/src/dropbox-mcp.ts
   ```

2. In `container/agent-runner/src/index.ts`:

   - Remove `'mcp__dropbox__*'` from `allowedTools`
   - Remove the `dropbox:` entry from `mcpServers`

3. Remove the refresh cron:

   ```bash
   crontab -l | grep -v refresh-dropbox-token | crontab -
   ```

4. Remove the refresh script and any leftover Go binary:

   ```bash
   rm scripts/refresh-dropbox-token.sh
   rm -f container/dropbox-mcp-server
   ```

5. Remove env vars:

   ```bash
   sed -i '/^DROPBOX_/d' .env data/env/env 2>/dev/null || true
   ```

6. (Optional) revoke the Dropbox app authorization in https://www.dropbox.com/account/connected_apps

7. Rebuild:

   ```bash
   npm run build
   ./container/build.sh
   ```

8. Restart:

   ```bash
   systemctl --user restart nanoclaw
   ```

# Verify Dropbox Tool

After install, ask the bot a Dropbox question (Power Glove main channel only):

> List the files in my Dropbox root

Expected: bot calls `mcp__dropbox__list_folder`, returns a JSON-ish list of files/folders.

Then test a read:

> Read the contents of /<some-text-file>.txt from Dropbox

Expected: bot calls `mcp__dropbox__download` (or similar), returns file contents.

## Troubleshooting

**"DROPBOX_REFRESH_TOKEN not set"**:
- Check container env: `grep DROPBOX data/env/env`
- Re-sync: `cp .env data/env/env`
- Restart: `systemctl --user restart nanoclaw`

**"invalid_access_token" / 401**:
- Refresh token may have been revoked or app reset.  Re-do the OAuth flow in Phase 2b.

**Cron isn't running**:
- `crontab -l | grep refresh-dropbox-token` should show the entry
- `tail -20 /home/melto007/nanoclaw/logs/dropbox-refresh.log` (or wherever your cron logs)

**Confirm the Go binary is gone** (if you removed it):
- `docker exec <container-name> which dropbox-mcp-server` should return nothing

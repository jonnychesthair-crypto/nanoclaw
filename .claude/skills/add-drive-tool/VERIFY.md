# Verify Drive Tool

After install, ask the bot a Drive question in any registered group:

> List my recent Drive files

Expected: bot calls `mcp__drive__list_files` (or similar), returns recently-modified files.

Then test a read:

> Read the contents of <some-doc-name>

Expected: bot calls `mcp__drive__search_files` then a read tool, returns file contents.

## Troubleshooting

**"OAuth keys file not found"**: check `ls -la groups/main/.drive-mcp/`.  Both `gcp-oauth.keys.json` and `credentials.json` must be readable inside the container.

**"insufficient permissions"**: you granted readonly but tried to write, OR the OAuth scope is too narrow.  Re-run OAuth with the broader scope.

**"Token expired"**: re-run the OAuth bootstrap script on host, re-link credentials.json into the group folder.

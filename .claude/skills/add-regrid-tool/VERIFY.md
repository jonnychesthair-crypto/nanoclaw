# Verify Regrid Tool

After install, ask the bot a parcel question in any registered group:

> What parcel data can you find for 1600 Pennsylvania Ave Washington DC?

Expected: bot calls `mcp__regrid__address_search`, returns at least geocoded parcel info (parcel ID, owner if available, basic fields).

## Troubleshooting

If the response says "no MCP tool available" or "REGRID_API_TOKEN not set":

- Verify token on host: `grep REGRID_API_TOKEN .env`
- Verify wiring: `grep -A 6 "regrid:" container/agent-runner/src/index.ts`
- Check container env was synced: `ls -la data/env/env && grep REGRID data/env/env`
- Restart: `systemctl --user restart nanoclaw`
- Check container logs: `docker logs $(docker ps --filter name=nc-power-glove --format '{{.Names}}' | head -1)`

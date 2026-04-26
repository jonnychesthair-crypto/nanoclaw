#!/bin/bash
# Refresh Dropbox access token every 3 hours (token expires in 4 hours)
# Called by cron: 0 */3 * * * /home/melto007/nanoclaw/scripts/refresh-dropbox-token.sh

ENV_FILE="/home/melto007/nanoclaw/.env"

CLIENT_ID=$(grep ^DROPBOX_CLIENT_ID= "$ENV_FILE" | cut -d= -f2-)
CLIENT_SECRET=$(grep ^DROPBOX_CLIENT_SECRET= "$ENV_FILE" | cut -d= -f2-)
REFRESH_TOKEN=$(grep ^DROPBOX_REFRESH_TOKEN= "$ENV_FILE" | cut -d= -f2-)

NEW_TOKEN=$(curl -s -X POST https://api.dropboxapi.com/oauth2/token \
  -d grant_type=refresh_token \
  -d "refresh_token=$REFRESH_TOKEN" \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" 2>/dev/null)

if [ -n "$NEW_TOKEN" ] && [ ${#NEW_TOKEN} -gt 100 ]; then
  sed -i "s|^DROPBOX_ACCESS_TOKEN=.*|DROPBOX_ACCESS_TOKEN=$NEW_TOKEN|" "$ENV_FILE"
else
  echo "$(date): Dropbox token refresh failed" >> /home/melto007/nanoclaw/logs/dropbox-refresh.log
fi

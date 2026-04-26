#!/usr/bin/env node
/**
 * Re-authenticate Google Calendar OAuth.
 * Run on host (needs browser): node scripts/auth-calendar.js
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const CONFIG_DIR = path.join(require("os").homedir(), ".calendar-mcp");
const OAUTH_PATH = path.join(CONFIG_DIR, "gcp-oauth.keys.json");
const CREDENTIALS_PATH = path.join(CONFIG_DIR, "credentials.json");
const PORT = 3000;

const keysContent = JSON.parse(fs.readFileSync(OAUTH_PATH, "utf8"));
const keys = keysContent.installed || keysContent.web;

const oauth2Client = new google.auth.OAuth2(
  keys.client_id,
  keys.client_secret,
  `http://localhost:${PORT}/oauth2callback`
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: ["https://www.googleapis.com/auth/calendar"],
});

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith("/oauth2callback")) return;
  const code = new URL(req.url, `http://localhost:${PORT}`).searchParams.get("code");
  if (!code) {
    res.end("No code received.");
    return;
  }
  try {
    const { tokens } = await oauth2Client.getToken(code);
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(tokens, null, 2));
    res.end("Done!  Credentials saved.  You can close this tab.");
    console.log("\nCredentials saved to", CREDENTIALS_PATH);
    console.log("Restart nanoclaw: systemctl --user restart nanoclaw");
    server.close();
  } catch (err) {
    res.end("Error: " + err.message);
    console.error(err);
  }
});

server.listen(PORT, () => {
  console.log(`\nOpen this URL in your browser:\n\n${authUrl}\n`);
});

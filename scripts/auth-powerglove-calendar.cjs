#!/usr/bin/env node
/**
 * Power Glove Google Calendar OAuth bootstrap.
 *
 * Writes credentials.json into the per-group calendar dir
 * (~/nanoclaw/groups/telegram_main/.calendar-mcp/), which the
 * container reads via HOME=/workspace/group (see
 * data/sessions/telegram_main/agent-runner-src/index.ts:566).
 *
 * NEVER touches ~/.calendar-mcp/ (legacy host-home path the bot
 * doesn't actually read) or any Jeeves paths.
 *
 * Mirrors nanoclaw-jeeves/scripts/auth-jeeves-calendar.cjs with
 * four changes:
 *   - paths point at ~/nanoclaw/ instead of ~/nanoclaw-jeeves/
 *   - port 3778 instead of 3777 (avoid Jeeves's port)
 *   - identity check + login_hint = jonsmelton@gmail.com (not Andrea)
 *   - uses google-auth-library directly (which PG's package.json has)
 *     instead of googleapis (which only Jeeves's package.json has);
 *     OAuth2 flow is identical between the two packages.
 *
 * Three flows supported:
 *   Default (HTTP callback on localhost:3778):
 *     node scripts/auth-powerglove-calendar.cjs
 *     Open the printed URL in a browser that can reach this
 *     server's localhost:3778 — either run from a server-side
 *     browser, or SSH with -L 3778:localhost:3778 from your Mac.
 *
 *   Manual paste (when browser can't reach localhost:3778):
 *     node scripts/auth-powerglove-calendar.cjs --manual
 *     Open the URL in any browser; after consent, copy the full
 *     redirect URL from the address bar (which won't load) and
 *     paste it back. Mirrors reauth-manual.js's pattern.
 *
 *   Direct code exchange (when you already have a code from a
 *   previous default-mode flow whose browser redirect failed):
 *     node scripts/auth-powerglove-calendar.cjs --code '<CODE>'
 *     Uses the default-mode redirect URI so codes obtained from
 *     default-mode auth URLs can be exchanged after the fact.
 *     Codes expire in ~60s, so be fast.
 *
 * After successful run: systemctl --user restart nanoclaw
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { OAuth2Client } = require("google-auth-library");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const CONFIG_DIR = path.join(PROJECT_ROOT, "groups", "telegram_main", ".calendar-mcp");
const OAUTH_PATH = path.join(CONFIG_DIR, "gcp-oauth.keys.json");
const CREDENTIALS_PATH = path.join(CONFIG_DIR, "credentials.json");
const PORT = 3778;
const MANUAL_MODE = process.argv.includes("--manual");
const CODE_IDX = process.argv.indexOf("--code");
const CODE_VALUE = CODE_IDX !== -1 ? process.argv[CODE_IDX + 1] : null;
const EXPECTED_USER = "jonsmelton@gmail.com";

if (!fs.existsSync(OAUTH_PATH)) {
  console.error(`Missing OAuth keys: ${OAUTH_PATH}`);
  process.exit(1);
}

const keysContent = JSON.parse(fs.readFileSync(OAUTH_PATH, "utf8"));
const keys = keysContent.installed || keysContent.web;
if (!keys) {
  console.error("Invalid OAuth keys file format.");
  process.exit(1);
}

console.log(`Using OAuth client: ${keys.client_id.split("-")[0]}...`);
console.log(`Will write credentials to: ${CREDENTIALS_PATH}`);
console.log(`Mode: ${MANUAL_MODE ? "manual paste" : "HTTP callback (port " + PORT + ")"}`);

// --code mode uses the default redirect URI so codes from a prior
// default-mode flow can be exchanged.  --manual uses its own URI.
const redirectUri = MANUAL_MODE
  ? "http://localhost"
  : `http://localhost:${PORT}/oauth2callback`;

const oauth2Client = new OAuth2Client(
  keys.client_id,
  keys.client_secret,
  redirectUri
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "select_account consent",
  login_hint: EXPECTED_USER,
  scope: ["https://www.googleapis.com/auth/calendar"],
});

async function exchangeAndSave(code) {
  const { tokens } = await oauth2Client.getToken(code);

  // Verify the authenticated user is Jon before saving.
  oauth2Client.setCredentials(tokens);
  const profileResp = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary",
    { headers: { Authorization: `Bearer ${tokens.access_token}` } }
  );
  const profile = await profileResp.json();
  if (profile.id !== EXPECTED_USER) {
    const msg = `REJECTED: OAuth completed as ${profile.id}, not ${EXPECTED_USER}.  Token NOT saved.  Re-run and select Jon's account.`;
    console.error("\n" + msg);
    process.exit(1);
  }

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(tokens, null, 2));
  console.log(`\nCredentials saved to ${CREDENTIALS_PATH}`);
  console.log(`Authenticated user: ${profile.id}`);
  console.log(`Scope: ${tokens.scope}`);
  console.log(`\nNext: systemctl --user restart nanoclaw`);
  return profile;
}

if (CODE_VALUE) {
  // Direct code exchange — bypass URL printing and server/stdin.
  (async () => {
    try {
      await exchangeAndSave(CODE_VALUE);
      process.exit(0);
    } catch (err) {
      console.error("Token exchange failed:", err.message);
      console.error("If 'invalid_grant', the code expired (~60s TTL) — re-run default mode for a fresh code.");
      process.exit(1);
    }
  })();
} else if (MANUAL_MODE) {
  console.log(`\nOpen this URL in any browser (sign in as Jon):\n\n${authUrl}\n`);
  console.log("After authorizing, the browser will redirect to a localhost URL that won't load.");
  console.log("Copy the FULL URL from the address bar (or just the code= value) and paste it here.\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("Paste the redirect URL (or just the code): ", async (input) => {
    rl.close();
    let code = input.trim();
    if (code.startsWith("http")) {
      try {
        const url = new URL(code);
        code = url.searchParams.get("code");
      } catch {
        // try as-is
      }
    }
    if (!code) {
      console.error("No code found.");
      process.exit(1);
    }
    try {
      await exchangeAndSave(code);
      process.exit(0);
    } catch (err) {
      console.error("Token exchange failed:", err.message);
      process.exit(1);
    }
  });
} else {
  const server = http.createServer(async (req, res) => {
    if (!req.url.startsWith("/oauth2callback")) return;
    const code = new URL(req.url, `http://localhost:${PORT}`).searchParams.get("code");
    if (!code) {
      res.end("No code received.");
      return;
    }
    try {
      const profile = await exchangeAndSave(code);
      res.end(`Done.  Jon's (${profile.id}) calendar credentials saved.  You can close this tab.`);
      server.close();
    } catch (err) {
      res.end("Error: " + err.message);
      console.error(err);
    }
  });

  server.listen(PORT, () => {
    console.log(`\nOpen this URL in your browser (sign in as Jon):\n\n${authUrl}\n`);
    console.log(`Waiting for callback on http://localhost:${PORT} ...`);
    console.log(`If your browser is on a different machine, either SSH with -L ${PORT}:localhost:${PORT}`);
    console.log(`or re-run with --manual for paste workflow.\n`);
  });
}

# NanoClaw Migration Guide — Power Glove (Jon Melton)

**Generated:** 2026-04-06
**Base version:** v1.2.50 (upstream commit 1d5c38d)
**Fork:** github.com/jonnychesthair-crypto/nanoclaw

This guide documents every customization on this fork. On upgrade, check out clean upstream in a worktree and reapply these changes. Data directories (`groups/`, `store/`, `data/`, `.env`) are never touched.

---

## 1. Agent Identity

**Files:** `groups/global/CLAUDE.md`, `groups/main/CLAUDE.md`

Rename the assistant from "Andy" to "Power Glove" in both files. Search-replace all occurrences.

---

## 2. Formatting Rules

**File:** `groups/main/CLAUDE.md`

Add a "Formatting Rules" section:
- NO em dashes or en dashes -- use hyphens (-)
- Double space after every period

**File:** `src/router.ts`

Add `enforceFormattingRules()` function that:
- Replaces em dashes (U+2014) and en dashes (U+2013) with hyphens
- Enforces double space after periods before capital letters

Call it in `formatOutbound()` after text styling.

Also add unpaired surrogate cleanup in `escapeXml()`:
```ts
.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
```

---

## 3. Channel-Aware Text Styling

**File:** `src/router.ts`

Import `parseTextStyles` and `ChannelType` from `./text-styles.js`. Modify `formatOutbound()` to accept optional `channel?: ChannelType` parameter and call `parseTextStyles(text, channel)`.

**File:** `src/text-styles.ts` (new file, committed)

Channel-specific Markdown-to-native formatting (WhatsApp bold/italic, Telegram Markdown, Slack mrkdwn).

**File:** `src/index.ts`

Pass `channel.name as ChannelType` to `formatOutbound()` in both the main `sendMessage` and the IPC watcher `sendMessage`.

---

## 4. Health Reporting

**File:** `groups/main/CLAUDE.md`

Add "Health Reporting" section instructing the agent to write a JSON health file to `/workspace/extra/health/powerglove.json` after every message/task:
```json
{"agent": "Power Glove", "status": "online", "last_heartbeat": "<UTC>", "last_task": "<desc>", "error": null}
```

Add "jeeevo-bot Health Monitoring" section: read-only access to `/workspace/extra/health/jeeevo.json`, flag if heartbeat > 2 hours old.

---

## 5. File Sending via Telegram

**File:** `src/types.ts`

Add optional `sendFile?` method to `Channel` interface:
```ts
sendFile?(jid: string, filePath: string, fileName: string, caption?: string): Promise<void>;
```

**File:** `src/ipc.ts`

Add `sendFile` to `IpcDeps` interface. Add `'send_file'` case in `processTaskIpc`:
- Validate authorization (isMain or own group)
- Resolve and validate file path is within group workspace
- Call `deps.sendFile()`

**File:** `src/index.ts`

Wire up `sendFile` callback in `startIpcWatcher` deps. Validate channel exists and has `sendFile` method.

**File:** `container/agent-runner/src/ipc-mcp-stdio.ts`

Add `send_file` tool to MCP server:
- Parameters: `file_path`, `file_name`, `caption`
- Validates file exists under `/workspace/group/`
- Writes IPC message to tasks directory

---

## 6. Credential Strategy (No OneCLI)

**File:** `src/container-runner.ts`

Replace OneCLI gateway credential injection with direct env var passing. Pass these to `docker run -e`:
- `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`
- `DROPBOX_CLIENT_ID`, `DROPBOX_CLIENT_SECRET`, `DROPBOX_REFRESH_TOKEN`, `DROPBOX_ACCESS_TOKEN`
- `CALENDAR_IDS`
- `REGRID_API_TOKEN`
- `EBAY_APP_ID`, `EBAY_DEV_ID`, `EBAY_CERT_ID`, `EBAY_USER_TOKEN`, `EBAY_REFRESH_TOKEN`

Add `--network host` flag to container args.

---

## 7. Live Log Streaming

**File:** `src/container-runner.ts`

Add live log stream to `/logs/live.log`:
- Log container activity, output snippets, exit codes
- Append mode, allows `tail -f` monitoring
- Log on stdout data events

---

## 8. IPC Timeout Reset

**File:** `src/container-runner.ts`

Modify `onProcess` callback to accept `resetTimeout` function. Reset timeout when streaming output is received (not just stderr).

**File:** `src/group-queue.ts`

Add `onIpcWrite` field to `GroupState`. New method `setIpcWriteCallback(groupJid, cb)` that fires when IPC messages are written, resetting the container idle timeout. Clean up callback on container exit.

Add orphaned IPC message cleanup: detect unconsumed messages after container exit, delete them, and flag for retry.

**File:** `src/task-scheduler.ts`

Pass `resetTimeout` through `onProcess` callback signature.

**File:** `src/index.ts`

Wire `resetTimeout` through from container-runner to group-queue via `setIpcWriteCallback`.

---

## 9. Memory Kernel Integration

**File:** `src/container-runner.ts`

Add `refreshMemoryKernel()` function that runs `npx mk reflect` and `npx mk render` post-session. Call it in both streaming and non-streaming completion paths. Non-fatal.

---

## 10. MCP Servers (Container Agent)

**File:** `container/agent-runner/src/index.ts`

Add to `allowedTools`: `mcp__calendar__*`, `mcp__gmail__*`, `mcp__drive__*`, `mcp__dropbox__*`, `mcp__regrid__*`, `mcp__memory_kernel__*`

Add explicit `model: 'claude-opus-4-6'`

Add MCP server definitions:

| Server | Command | Key Env Vars |
|--------|---------|-------------|
| calendar | `node calendar-mcp.js` | CALENDAR_IDS |
| gmail | `npx -y @gongrzhe/server-gmail-autoauth-mcp` | HOME=/workspace/group |
| drive | `node drive-mcp.js` | HOME=/workspace/group |
| dropbox | `node dropbox-mcp.js` | DROPBOX_CLIENT_ID, DROPBOX_CLIENT_SECRET, DROPBOX_REFRESH_TOKEN |
| regrid | `node regrid-mcp.js` | REGRID_API_TOKEN |
| memory_kernel | `node memory-kernel/dist/mcp/server.js` | MEMORY_DIR, MCP_AGENT_ID, MCP_SESSION_ID |

---

## 11. Retry Logic for Transient API Errors

**File:** `container/agent-runner/src/index.ts`

Wrap `runQuery()` call in retry loop:
- MAX_RETRIES = 5, BASE_DELAY_MS = 2000
- Exponential backoff with random jitter
- Match transient errors: `/overloaded|529|500|502|503|504|ECONNRESET|ETIMEDOUT|socket hang up/i`
- Non-transient errors throw immediately

---

## 12. New MCP Server Source Files (Untracked)

Copy these into `container/agent-runner/src/`:

| File | Purpose |
|------|---------|
| `calendar-mcp.ts` | Google Calendar integration (multi-calendar, OAuth via ~/.calendar-mcp/) |
| `drive-mcp.ts` | Google Drive file operations (OAuth via ~/.drive-mcp/) |
| `dropbox-mcp.ts` | Dropbox file ops, headless refresh token auth (replaces broken Go binary) |
| `regrid-mcp.ts` | Regrid parcel/real estate data lookup |

---

## 13. Container Dependencies

**File:** `container/agent-runner/package.json`

Add:
```json
"google-auth-library": "^10.6.2",
"googleapis": "^171.4.0",
"memory-kernel": "^1.3.0"
```

**File:** `package.json` (host)

Add:
```json
"google-auth-library": "^10.6.2",
"grammy": "^1.39.3",
"mammoth": "^1.11.0",
"memory-kernel": "^1.3.0",
"pdf-parse": "^2.4.5",
"pino": "^9.6.0",
"pino-pretty": "^13.0.0",
"whisper-node": "^1.1.1",
"yaml": "^2.8.2",
"zod": "^4.3.6"
```

---

## 14. Dockerfile Additions

**File:** `container/Dockerfile`

Add system packages:
```
ffmpeg poppler-utils pandoc libreoffice-nogui
```

Copy custom tools:
```dockerfile
COPY skills/pdf-reader/pdf-reader /usr/local/bin/pdf-reader
COPY dropbox-mcp-server /usr/local/bin/dropbox-mcp-server
```

Note: The Go `dropbox-mcp-server` binary is deprecated but still copied. Can be removed once the Node.js replacement is confirmed stable.

---

## 15. Container Skills

Copy these directories into `container/skills/`:

| Skill | Purpose |
|-------|---------|
| `office-tools/` | SKILL.md defining LibreOffice + pandoc document tools |
| `pdf-reader/` | SKILL.md + bash wrapper for pdftotext/pdfinfo |

---

## 16. Utility Scripts

Copy to `scripts/`:

| Script | Purpose | Cron |
|--------|---------|------|
| `auth-calendar.js` | One-time Google Calendar OAuth setup | N/A |
| `refresh-dropbox-token.sh` | Refresh Dropbox access token | `0 */3 * * *` |
| `security-scan.sh` | Daily security audit | Daily |

---

## 17. Whisper Server

**Binary:** `whisper-server` (compiled whisper.cpp)

Runs as a persistent service for local speech-to-text transcription. Used by Telegram voice message handling. Started separately, listens on port 8178.

**Type definition:** `src/whisper-node.d.ts` -- TypeScript declarations for the `whisper-node` package.

---

## 18. Telegram Channel (Committed)

**File:** `src/channels/telegram.ts`

Full Telegram channel implementation (committed, merged from upstream skill branch). Includes:
- Text messages with @mention translation
- Photo, video, document, audio, voice support
- Voice transcription via local whisper server (port 8178)
- Document text extraction (DOCX via mammoth, PDF via pdftotext)
- Code blocks sent as downloadable file attachments
- Local Bot API server support
- `sendFile()` method for document delivery

---

## Environment Variables (.env)

Required in `.env` for full functionality:
```
CLAUDE_CODE_OAUTH_TOKEN=<token>
TELEGRAM_BOT_TOKEN=<token>
DROPBOX_CLIENT_ID=<id>
DROPBOX_CLIENT_SECRET=<secret>
DROPBOX_REFRESH_TOKEN=<token>
DROPBOX_ACCESS_TOKEN=<token>  # auto-refreshed by cron
CALENDAR_IDS=primary,<additional calendar IDs>
REGRID_API_TOKEN=<token>
EBAY_APP_ID=<id>
EBAY_DEV_ID=<id>
EBAY_CERT_ID=<id>
EBAY_USER_TOKEN=<token>
EBAY_REFRESH_TOKEN=<token>
```

---

## Rollback

Before any upgrade:
1. `git tag pre-upgrade-$(date +%Y%m%d)`
2. `tar czf ~/nanoclaw-snapshot-$(date +%Y%m%d).tar.gz nanoclaw/ nanoclaw-jeeves/ workspace/`
3. Note the codeword: **OVEN MITT**

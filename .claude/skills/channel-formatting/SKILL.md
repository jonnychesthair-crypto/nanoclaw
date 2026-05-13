---
name: channel-formatting
description: Convert Claude's Markdown output to Telegram's native text syntax before delivery. Zero-dependency marker substitution (e.g., `**bold**` -> `*bold*`).
---

# Channel Formatting

This skill wires Telegram-aware Markdown conversion into the outbound pipeline so Claude's
responses render natively on Telegram - no more literal `**asterisks**`.

| Channel | Transformation |
|---------|---------------|
| Telegram | `**bold**` -> `*bold*`, `*italic*` -> `_italic_`, headings -> bold, `[text](url)` links preserved (Markdown v1 renders them natively) |

Code blocks (fenced and inline) are always protected - their content is never transformed.

## Phase 1: Pre-flight

### Check if already applied

```bash
test -f src/text-styles.ts && echo "already applied" || echo "not yet applied"
```

If `already applied`, skip to Phase 3 (Verify).

## Phase 2: Apply Code Changes

### Ensure the upstream remote

```bash
git remote -v
```

If an `upstream` remote pointing to `https://github.com/qwibitai/nanoclaw.git` is missing,
add it:

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch upstream skill/channel-formatting
git merge upstream/skill/channel-formatting
```

If there are merge conflicts on `package-lock.json`, resolve them by accepting the incoming
version and continuing:

```bash
git checkout --theirs package-lock.json
git add package-lock.json
git merge --continue
```

For any other conflict, read the conflicted file and reconcile both sides manually.

This merge adds:

- `src/text-styles.ts` — `parseTextStyles(text, channel)` for marker substitution and
  `parseSignalStyles(text)` for Signal native rich text
- `src/router.ts` — `formatOutbound` gains an optional `channel` parameter; when provided
  it calls `parseTextStyles` after stripping `<internal>` tags
- `src/index.ts` — both outbound `sendMessage` paths pass `channel.name` to `formatOutbound`
- `src/formatting.test.ts` — test coverage for both functions across all channels

### Validate

```bash
npm install
npm run build
npx vitest run src/formatting.test.ts
```

All 73 tests should pass and the build should be clean before continuing.

## Phase 3: Verify

### Rebuild and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# Linux: systemctl --user restart nanoclaw
```

### Spot-check formatting

Send a message through any registered WhatsApp or Telegram chat that will trigger a
response from Claude. Ask something that will produce formatted output, such as:

> Summarise the three main advantages of TypeScript using bullet points and **bold** headings.

Confirm that the response arrives with native bold (`*text*`) rather than raw double
asterisks.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Removal

```bash
# Remove the new file
rm src/text-styles.ts

# Revert router.ts to remove the channel param
git diff upstream/main src/router.ts   # review changes
git checkout upstream/main -- src/router.ts

# Revert the index.ts sendMessage call sites to plain formatOutbound(rawText)
# (edit manually or: git checkout upstream/main -- src/index.ts)

npm run build
```
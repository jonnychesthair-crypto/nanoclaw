# Power Glove migration to nanoclaw 2.0.x

**Drafted:** 2026-04-29 (original, targeting old `/migrate-nanoclaw` flow)
**Refreshed:** 2026-05-16 (full rewrite for the `migrate-v2.sh` + `/migrate-from-v1` flow shipped in upstream 2.0.45 / 2.0.48 / 2.0.63)
**Target:** Power Glove fork at `~/nanoclaw`.  Jeeves migrates separately, later.

> This plan replaces an earlier draft that targeted the old `/migrate-nanoclaw` Extract/Upgrade flow.  Upstream replaced that flow with a two-step migration in 2026-05-08 onward (`migrate-v2.sh` script + `/migrate-from-v1` Claude skill).  This rewrite reflects current upstream as of 2.0.63 (2026-05-15).

---

## Sources of truth (read before executing)

All four live in upstream nanoclaw and can be read locally via `git show upstream/main:<path>`:

- `docs/v1-to-v2-changes.md` — vocabulary doc for what changed between 1.x and 2.x.  Authoritative for entity model, scheduling, credentials, channel model, group folders.
- `migrate-v2.sh` — the entry-point script.  Refuses to run in Claude Code's bash subprocess; requires an interactive terminal.
- `.claude/skills/migrate-from-v1/SKILL.md` — the skill that picks up after `migrate-v2.sh`.  Walks five phases: routing, owner+access, CLAUDE.local.md cleanup, container config, fork customizations.
- `CHANGELOG.md` — release notes.  Key entries for this migration: 2.0.0 (architectural rewrite, 2026-04-22), 2.0.45 (`migrate-v2.sh` shipped, 2026-05-08), 2.0.48 (container config moved to DB, 2026-05-09), 2.0.54 (per-group model/effort, 2026-05-10), 2.0.63 (service-name slugging, 2026-05-15).

This file (`~/nanoclaw/V2_MIGRATION_PLAN.md`) is the only place that captures PG-specific decisions and credential paths.

## State verified 2026-05-16

| | |
|---|---|
| PG version | `1.2.52` (HEAD `7be06a7`, "memory-kernel git#main → ^1.16.1") |
| PG working tree | clean |
| Upstream tip | `2.0.63` (HEAD `975a2f0`, 2026-05-15) |
| 2.x age on trunk | 24 days (2.0.0 landed 2026-04-22) |
| Org rename | `qwibitai/nanoclaw` → `nanocoai/nanoclaw` (2026-05-10).  GitHub redirects; existing `upstream` remote still resolves. |
| Drift | ~50 commits ahead, ~800 commits behind, ~470 files changed.  Numbers drift daily; re-verify before executing. |
| Pre-staged `groups/<folder>/container.json` files | BACKFILL ONLY: 2.0.48 moved per-agent-group config into the `container_configs` DB table.  Files are read once on first start, ignored thereafter.  Post-migration config management is `ncl groups config update`. |
| Pre-existing rollback tag | `pre-upgrade-1.2.35` (~40 days old).  Cut a fresh tag in Phase 1. |

## Phase 0 gate status — all clear

Verified 2026-05-08, no regressions through 2026-05-16:

- [x] Jeeves identity Phase B/C done.  Andrea's fork `andreamelton02-stack/nanoclaw` exists; origin re-pointed; Monday 9am CST drift-check cron in place.
- [x] Andrea Gmail flap stable.  No `invalid_grant` errors in the active log window.
- [x] Wed 8pm CDT auto-delete cron ran (2026-04-30 01:00 UTC).  Verifier failure was unrelated to the archive.
- [x] Option B IPC-pipe gate decided "no go".  Band-aid committed at `0ce6c18`.
- [x] 2.0.x on upstream ≥ 14 days.  Cleared 2026-05-06; day 24 as of 2026-05-16.

Proceed when Jon decides.

## Architectural watch-out

The single most consequential v2 change for PG: in 1.x each group has a writable copy of `agent-runner-src/` where memory_kernel + 4 custom MCPs (calendar, drive, dropbox, regrid) are registered as native code.  In 2.0 all groups mount one shared, read-only agent-runner; per-group customization happens through composed `CLAUDE.md` fragments and per-agent-group config in the `container_configs` DB table.

How the new flow handles this:

1. **The 5 custom MCP servers get replaced**, not ported.  Per upstream's `/migrate-from-v1` skill: *"Source code (`src/*`, `container/agent-runner/src/*`) is NOT portable.  v2's architecture is fundamentally different.  Stash to `docs/v1-fork-reference/` with a README explaining what each file did.  Don't translate."*  The replacements are v2 skills, which PG already has installed: `/add-calendar-tool`, `/add-drive-tool`, `/add-dropbox-tool`, `/add-regrid-tool`.  For what `ipc-mcp-stdio.ts` did, v2 ships a built-in `nanoclaw` MCP server with `schedule_task`, `send_message`, etc.; verify it covers every IPC tool PG's bridge exposed before declaring done.
2. **PG's env-injection divergence dies cleanly.**  In v1, `src/container-runner.ts` forwards third-party credentials (`DROPBOX_*`, `CALENDAR_IDS`, `REGRID_API_TOKEN`, `EBAY_*`) into containers via docker `-e` flags.  v2 routes all credentials through OneCLI vault.  `/init-onecli` migrates `.env` keys to the vault during Phase 5 below.  The container-runner.ts patches go to `docs/v1-fork-reference/` and are not re-applied.

## Customization inventory

Built from `git log upstream/main..HEAD` + filesystem inspection.  Each item must port forward, get re-implemented as a v2 skill, or be deliberately discarded.

| # | Item | v2 destination |
|---|---|---|
| 1 | 5 native MCP server registrations in `agent-runner-src/index.ts` | REPLACED by v2 add-X-tool skills + built-in `nanoclaw` MCP.  Source stashed to `docs/v1-fork-reference/`. |
| 2 | 5 custom MCP source files (calendar / drive / dropbox / regrid / ipc-mcp-stdio) | Same as #1.  Verify the v2 add-X-tool skills cover the multi-calendar list/search/create/update/delete tool surface PG's `calendar-mcp.ts` exposes. |
| 3 | Per-instance container naming + stale reaper + heartbeats + IPC reset + send_file + channel crash protection (commit `835d383`) | VERIFY at Phase 6: v2 has its own container isolation via `messaging_groups.platform_id` + per-session DBs.  PG's `CONTAINER_PREFIX` work may be redundant.  If so, drop it; if not, re-implement at the v2 layer. |
| 4 | Telegram extensions: whisper transcription, attachments, sendFile, document text extraction (commit `137845e`) | RE-INSTALL via `/add-telegram` (v2's `channels` branch), then layer extensions back.  Decision for whisper: PG's Groq-via-whisper-large-v3-turbo (custom port) vs v2's default `/add-voice-transcription` (OpenAI Whisper API).  Memory `project_whisper_transcription` documents the Groq cutover. |
| 5 | Channel-aware text styles, dash + double-space rules (commit `d8ddb4a`) | Layer back via per-group `CLAUDE.local.md` after migration.  v2's composed CLAUDE.md model keeps the user-edit surface at `CLAUDE.local.md`. |
| 6 | Container system tooling + container skills + host utility scripts (commit `1a98dfd`) | Container skills are copied automatically by `migrate-v2.sh` (the `container/skills/` step).  Host utility scripts: dedupe vs v2's `ncl` admin CLI; many may now be `ncl groups *` invocations. |
| 7 | Installable skills: `add-dropbox-tool`, `add-drive-tool`, `add-calendar-tool`, `add-regrid-tool` (own commits each) | ALREADY INSTALLED in v2 form per Jon's skills list.  Re-verify each tool's behavior post-migration; dedupe any v1 leftovers. |
| 8 | `firstReplyClosed` band-aid in v1 `src/index.ts` (committed at `0ce6c18`) | LIKELY OBSOLETE in v2: `src/index.ts` doesn't exist in the v1 shape.  v2 message routing is entity-model-based through `messages_in` / `messages_out`.  Test the failure mode against v2 before re-introducing.  If not reproducible, delete the TODO memory. |
| 9 | `upstream-drift-check.sh` + Monday 9am CST cron (commit `3bebbed`) | KEEP.  Re-point at v2 trunk after migration.  Update the script's version-parsing if needed to handle `2.0.x` properly. |
| 10 | CLAUDE.md upgrade discipline doc (commit `b73472c`) | KEEP, reconcile with v2's composed CLAUDE.md flow.  Edit `CLAUDE.local.md` or fragments, never `groups/<folder>/CLAUDE.md` (which v2 composes at container spawn). |
| 11 | Power Glove env injection docs (commits `06bf5a1`, `f2aba47`) | DELETE after migration.  v2's OneCLI vault is the credential path; the docker `-e` divergence is gone. |
| 12 | Whisper server binary gitignore (commit `f01105d`) | Likely irrelevant if Groq path is kept (no local binary).  Evaluate at Phase 6 item 4 decision. |

### Data and credentials (NOT touched by migration; copied forward by the script)

- `groups/main/`, `groups/telegram_main/` — copied forward by `migrate-v2.sh`.  v1 `CLAUDE.md` becomes v2 `CLAUDE.local.md` per group.
- `.env` — merged into v2 `.env`.  Script never overwrites v2 keys.
- Google OAuth file credentials — NOT in OneCLI's scope.  Per Jon's CLAUDE.md OAuth Lock section:
  - Gmail: `~/.gmail-mcp/` (referenced by `GMAIL_CREDENTIALS_DIR`).  In v2 the container model needs a mount or env equivalent; the v2 `/add-gmail-tool` skill (see CHANGELOG 2.0.63: "gmail/gcal skills aligned with v2") should handle setup but the EXISTING refresh tokens must survive.  Verify path at Phase 4.
  - Calendar: `~/nanoclaw/groups/telegram_main/.calendar-mcp/credentials.json` is the path the v1 container actually reads (HOME=/workspace/group resolution).  Migrating the group folder forward preserves this file in place.
  - Drive: `~/.drive-mcp/` (host-home, like Gmail).
- OneCLI vault contents — carried forward as-is (vault is host-level, not per-version).

---

## Known issues to watch for

Compiled from upstream GitHub issues (state as of 2026-05-16) and Discord transcripts of `#v2-report-issues` + `#nanoclaw-v2-design-and-feedback` (April-May 2026).  Filtered to items with real PG relevance.

### Pre-migration decisions (BEFORE Phase 1)

1. **`/remote-control` is REMOVED in v2.**  Verified by direct file scan: no `remote-control` skill file in `upstream/main`; only v1 CHANGELOG entries (1.2.14, 1.2.15) mention it.  PG's customization inventory item 6 ("host utility scripts") covers this.  Decide before Phase 1: re-implement as a host-side utility outside the container model, or live without.  *Source: upstream file scan; Discord 5/12 (tas) asked, no resolution captured.*
2. **Auth-mode check.**  v2 setup requires `org:create_api_key` scope on Claude Code OAuth tokens.  If the host uses `claude setup-token` OAuth instead of `ANTHROPIC_API_KEY`, that scope may be missing.  Fall back to `ANTHROPIC_API_KEY` for v2.  *Source: Discord 4/20, Zettadata.*

### During migration (Phase 3-4)

3. **`/setup verify` reports success even when an adapter is stuck.**  It only checks env vars + process status, never tails error logs or probes adapter liveness.  Don't trust it in isolation.  Phase 4 Skill Phase 0's real Telegram message test is the verification that matters.  *Source: Discord 4/16, Ethan.*
4. **Channel install skills nudge Claude to ask for secrets in chat.**  10 of 13 v2 channel-install skills use ambiguous ".env:" blocks that, in practice, lead Claude to prompt for tokens via free text (where they land in conversation history).  **Mitigation: paste tokens directly into v2 `.env` (`BOT_TOKEN=...`) BEFORE running `/add-telegram`** so Claude finds them already populated.  *Source: Discord 4/16-19, Ethan; confirmed Discord 4/18 with screenshots.*
5. **OneCLI dashboard accessibility on a host that already has OneCLI.**  Jon's host already runs OneCLI.  `nanoclaw.sh` (and `migrate-v2.sh` via the bootstrap step) may remove/reinstall and rebind to the Docker gateway IP, breaking other host services that talked to OneCLI on loopback.  Fix reported in progress as of 4/22; verify upstream status before Phase 3.  *Source: Discord 4/22, evenisse; Gavriel "implementing a fix for this now."*

### Post-migration operational (Phase 6-9 + the 72h verification window)

6. **`ncl` may not be on PATH after `/update-nanoclaw` past 2.0.45.**  Workaround: add the v2 install's `node_modules/.bin` (or per-install bin) to PATH.  *Source: GitHub #2355.*
7. **`groups/<folder>/CLAUDE.md` is REGENERATED every container spawn.**  The composer overwrites it.  Agents that edit it lose their changes silently.  Persona, preferences, and protocol go in `CLAUDE.local.md` (auto-loaded, not regenerated).  Tell agents this explicitly in `CLAUDE.local.md` so they don't try to save notes that vanish.  *Source: Discord 5/4, sshwarts.*
8. **Scheduled tasks live in per-session `inbound.db`, NOT a central table.**  Tasks are at `data/v2-sessions/<agent_group_id>/<session_id>/inbound.db` with `kind='task'` rows.  **Deleting or rewiring agent groups during cleanup AFTER migration silently blows away the tasks.**  Before any `rm -rf` of session dirs, scan for `kind='task'` rows:  `pnpm exec tsx scripts/q.ts data/v2-sessions/<id>/<session>/inbound.db "SELECT id, content FROM messages_in WHERE kind='task'"`.  *Source: Discord 5/4, sshwarts.*
9. **Attachments dir mount for Telegram.**  GitHub #2047 reports `data/attachments/` not mounted into container post-migration (filed against WhatsApp; same underlying mechanism applies to any attachment path).  At Phase 4 Skill Phase 3, verify that `groups/telegram_main/attachments/` mounts into the v2 container's expected path.  Smoke-test attachments + sendFile in Phase 7.  Issue is OPEN as of 2026-05-16, no PR in flight.  *Source: GitHub #2047.*
10. **Outbound delivery failures are silently swallowed.**  Highest-impact open operational bug for PG.  Agent has no way to know a message was dropped.  During Phase 9 (72h verification), monitor `outbound.db` for `delivery_status='failed'` rows.  *Source: GitHub #2423.*
11. **Double delivery when agent uses `send_message` MCP tool AND `<message>` blocks in the same turn.**  PG agent uses both patterns.  Community fix on `mshirel/nanoclaw` branch `fix/mcp-send-message-dedup` (deduplicate by destination, not content).  *Source: GitHub #2404.*
12. **Telegram 4096-char message truncation.**  chat-sdk-bridge truncates long outbound messages.  PR #1900 added optional `maxTextLength` splitter; the `channels`-branch Telegram adapter factory must pass `maxTextLength: 4000` to engage it.  Verify before relying on long agent responses.  *Source: Discord 4/21, Dave PR #1900.*
13. **`session_mode` auto-promotion may surprise.**  Router auto-promotes `shared` → `per-thread` when `adapter.supportsThreads && messaging_groups.is_group=1`.  Telegram supports threads (topics), so PG groups with topics enabled may end up `per-thread` even if configured `shared`.  Inspect with `ncl groups config get` post-migration.  *Source: Discord 5/4, sshwarts.*
14. **`agent_destinations` is co-managed with `messaging_group_agents`.**  If hand-fixing the DB post-migration, use `createMessagingGroupAgent()` to insert both rows.  Raw SQL `UPDATE` on `mga` without updating destinations throws "unauthorized channel destination."  *Source: Discord 5/4, sshwarts.*

### Rebuild cadence cheat sheet (post-migration iterative fixes)

Three source locations, three different rebuild paths.  Mixing them up wastes the most time during iterative debugging:

| Source location | Rebuild path |
|---|---|
| `container/agent-runner/src/*` | RO-mounted from host; Bun reads at each container start.  Edits → kill running container, next spawn picks up. |
| `src/*` (host code) | `pnpm run build` + restart the host service unit. |
| `Dockerfile` / pinned global pnpm packages | `./container/build.sh`.  Rare; only when changing apt/npm pinned versions. |

*Source: Discord 5/4, sshwarts.*

---

## Phase 1: Snapshot v1 (v1 stays read-only after this)

```bash
cd ~/nanoclaw

# Confirm clean
git status

# Snapshot tags
git tag pre-v2-migration-$(date +%Y%m%d)
git tag -f rollback/powerglove-pre-v2 HEAD

# Backup branch
git branch backup/pre-v2-$(date +%Y%m%d)

# Push tags and backup branch to origin (Jon's fork)
git push origin --tags
git push origin "backup/pre-v2-$(date +%Y%m%d)"

# Snapshot data dirs (defense in depth; migration shouldn't touch them)
tar czf ~/nanoclaw-data-snapshot-$(date +%Y%m%d).tar.gz \
  -C ~/nanoclaw groups data .env

# Snapshot the current Docker image
docker tag nanoclaw-agent:powerglove \
  nanoclaw-agent:powerglove-pre-v2-$(date +%Y%m%d)
```

Verify all five artifacts exist.  The v1 checkout is treated as **read-only** for the rest of the migration; `migrate-v2.sh` is built to never write to it.

## Phase 2: Clone v2 alongside v1

```bash
cd ~
git clone https://github.com/nanocoai/nanoclaw.git nanoclaw-v2
cd nanoclaw-v2
jq -r '.version' package.json   # expect 2.0.63 or higher
```

`migrate-v2.sh` auto-detects v1 by sibling-directory scan.  `~/nanoclaw` (v1) and `~/nanoclaw-v2` (v2) as siblings is the supported layout.  Setting `NANOCLAW_V1_PATH` is only needed if auto-detect picks the wrong directory.

## Phase 3: Run migrate-v2.sh (from a separate terminal, NOT Claude Code)

**The script cannot run inside Claude Code's bash tool.**  It checks `[ -t 0 ]` and `[ -t 1 ]` and aborts if either is false, because it needs interactive prompts (channel selection, service switchover) and streams real-time progress.

Open a separate terminal (or exit Claude Code first):

```bash
cd ~/nanoclaw-v2
bash migrate-v2.sh
```

The script runs these steps, with per-step output at `logs/migrate-steps/<name>.log` and a summary at `logs/setup-migration/handoff.json`:

1. **Bootstrap** (`setup.sh`): installs Node, pnpm, deps.
2. **Find v1**: locates `~/nanoclaw` via sibling scan.
3. **Validate v1 DB**: confirms `registered_groups` table is present in `store/messages.db`.
4. **Env merge**: copies missing keys from v1 `.env` into v2 `.env`.  Never overwrites v2 keys.
5. **DB seed**: migrates `registered_groups` rows into v2's `agent_groups` / `messaging_groups` / `messaging_group_agents` tables.  Maps v1's `trigger_pattern` regex to v2's four orthogonal columns (`engage_mode`, `engage_pattern`, `sender_scope`, `ignored_message_policy`).  JID decomposition: v1's `tg:67890` becomes `channel_type='telegram'`, `platform_id='telegram:67890'`.
6. **Groups copy**: copies group folders.  v1 `CLAUDE.md` becomes v2 `CLAUDE.local.md`.
7. **Sessions copy**: copies session data including Claude Code memory and JSONL transcripts (conversation continuity).
8. **Tasks port**: v1 `scheduled_tasks` rows become v2 `messages_in` rows with `kind='task'` in each session's `inbound.db`.  v1 `schedule_type`+`schedule_value` maps to a single cron string.
9. **Channel select + install**: interactive multi-select (clack) for channels detected in v1.  **For PG, choose Telegram only.**  Skill installs from v2's `channels` branch via `git fetch origin channels && git show channels:src/channels/telegram.ts > src/channels/telegram.ts`.
10. **Channel auth copy**: copies session-state files for installed channels (Telegram session/bot state).
11. **Container skills copy**: ports `container/skills/*` from v1.
12. **Container image build**: builds the v2 agent container.
13. **Service switchover prompt**: offers to stop v1's service and start v2's.  Accept the offer.

The script is idempotent.  If anything fails mid-way, fix the cause and re-run.  For development re-testing, `bash migrate-v2-reset.sh` wipes v2 state back to clean.

When it finishes, the script writes `logs/setup-migration/handoff.json` and exits.

## Phase 4: Resume in Claude Code via /migrate-from-v1

Open Claude Code with cwd at `~/nanoclaw-v2`:

```
/migrate-from-v1
```

The skill reads `logs/setup-migration/handoff.json` and walks five phases.  Each has PG-specific specifics:

### Skill Phase 0: get v2 routing real messages

Triages any failed `migrate-v2.sh` steps that block routing, then completes the service switchover.

Service unit names are now **per-install slugged** (upstream 2.0.63):
- macOS launchd: `com.nanoclaw.<sha1(projectRoot)[:8]>`
- Linux systemd: `nanoclaw-<slug>.service`

Find PG's v2 unit name:

```bash
cd ~/nanoclaw-v2
source setup/lib/install-slug.sh && systemd_unit
```

Send a real test message to the live Telegram group.  Confirm v2 responds.  If it doesn't, **do not proceed** — diagnose from `logs/nanoclaw.log` and fix before deeper steps.

### Skill Phase 1: owner and access

Skill seeds the owner row in `user_roles`.  For Telegram, owner format is `telegram:<numeric_user_id>`.  Jon's Telegram user ID appears in v1's message history; the skill should auto-suggest it.  Confirm via the `AskUserQuestion` prompt.

Access policy: the script defaulted `messaging_groups.unknown_sender_policy='public'` for switchover testing.  Decide whether to tighten:
- `public` — anyone can message the bot (current).  Matches v1's pattern-based trigger if the trigger was permissive.
- `known_users_only` — only `agent_group_members` rows can trigger.  Matches v1 sender allowlist behavior.
- `request_approval` — unknown senders trigger an owner-approval flow.

If picking 2 or 3, the skill auto-seeds known users from v1's `messages` table (distinct senders per group).  Review and deselect any that shouldn't be allowed before committing.

### Skill Phase 2: CLAUDE.local.md cleanup

The skill diffs each `CLAUDE.local.md` (which is v1's old `CLAUDE.md` copied verbatim) against the v1 template it was based on and strips stock boilerplate that v2's composed fragments now handle.  Review each diff before accepting.

**PG-specific**: the v1 root `CLAUDE.md` "OAuth Lock" section is operational policy and must survive the cleanup.  Verify the skill preserves it.  Same for the "Power Glove env injection (fork divergence from upstream)" section, though after Phase 5 (OneCLI migration) the env-injection text becomes obsolete and can be deleted.

### Skill Phase 3: container config

Skill reads `container.json` files (pre-staged from earlier work) and validates `additionalMounts` host paths.  Post-2.0.48 these files matter only for first-start backfill; afterwards, edits go through `ncl groups config update`.

**PG-specific verification**:
- `groups/main/container.json` must mount `~/.gmail-mcp/` and `~/.drive-mcp/` (host-home Google OAuth credentials).
- `groups/telegram_main/container.json` must preserve the calendar credentials path PG actually reads, namely `groups/telegram_main/.calendar-mcp/credentials.json`.  Since the group folder is copied forward as a tree, this should naturally land in `~/nanoclaw-v2/groups/telegram_main/.calendar-mcp/`.
- After both first agent spawns, verify backfill landed in DB: `ncl groups config get main` and `ncl groups config get telegram_main`.  All subsequent management is via the DB-backed CLI; the JSON files are now historical.

### Skill Phase 4: fork customizations

The skill runs `git log upstream/main..HEAD` on v1 to enumerate ahead-commits, presents them, and asks how to handle.  **For PG, choose "Copy portable items + stash source to docs/v1-fork-reference/."**

Portable items (the skill handles the copy):
- `container/skills/*` — also covered by `migrate-v2.sh` Phase 3 step 11.
- `.claude/skills/*` — dedupe against v2's existing copies of `add-calendar-tool`, `add-drive-tool`, `add-dropbox-tool`, `add-regrid-tool`.
- `docs/*` — including this plan file (move/copy this `V2_MIGRATION_PLAN.md` into the v2 checkout as historical record).

Non-portable items (stash only, do not translate):
- 5 custom MCP server files at `data/sessions/telegram_main/agent-runner-src/` (calendar / drive / dropbox / regrid / ipc-mcp-stdio).
- `src/container-runner.ts` env-injection patches.
- `src/index.ts` `firstReplyClosed` band-aid.
- Any other `src/*` or `container/agent-runner/src/*` edits visible in `git log upstream/main..HEAD`.

---

## Phase 5: Migrate credentials to OneCLI vault

```
/init-onecli
```

This skill installs OneCLI Agent Vault (if missing) and migrates `.env` keys into the vault.  Verify:

```bash
# Health
curl -s http://127.0.0.1:10254/health | jq .

# PG-specific keys present
onecli secrets list | grep -E '(DROPBOX|CALENDAR_IDS|REGRID|EBAY)'
```

Then set the auto-created agents' secret mode (they default to `selective`, which means no secrets attached even if matching secrets exist):

```bash
onecli agents set-secret-mode --mode all
```

After this, the PG-specific `src/container-runner.ts` env-injection patches are dead.  Confirm by running PG's MCP tools end-to-end in Phase 7.

## Phase 6: Re-evaluate customizations against v2

Walk the customization inventory items 3, 5, 6, 8, 9, 10, 11, 12.  For each, decide: still needed, redundant under v2, or needs re-implementation.

- **Item 3 (container isolation)**: v2 uses entity-model isolation via per-session DBs and `messaging_groups.platform_id`.  PG's CONTAINER_PREFIX, stale-reaper, heartbeat work is most likely redundant.  Drop it; if a specific scenario isn't covered, re-implement at the v2 layer.
- **Item 4 (Telegram extensions, decision)**: whisper choice — keep Groq via custom skill, or default OpenAI Whisper.  Decide based on cost / latency / accuracy trade-offs.  Memory `project_whisper_transcription` has the original Groq cutover context.
- **Item 5 (text styles)**: layer per-group `CLAUDE.local.md` rules.
- **Item 6 (container skills + host utilities)**: dedupe vs `ncl` admin CLI.  Many v1 host utilities are now `ncl groups *` invocations.
- **Item 8 (firstReplyClosed band-aid)**: test the failure mode against v2; if not reproducible, delete the TODO memory.
- **Item 9 (drift-check cron)**: re-point script at v2 trunk; verify version-parsing handles `2.0.x`.
- **Item 10 (CLAUDE.md upgrade discipline)**: reconcile with v2's composed CLAUDE.md; the rule becomes "edit `CLAUDE.local.md`, never `groups/<folder>/CLAUDE.md`".
- **Item 11 (env-injection docs)**: delete.
- **Item 12 (whisper gitignore)**: irrelevant if Groq path is kept; evaluate.

## Phase 7: Smoke test on Telegram

Send these messages to the live PG group and verify each works.  Each tests a specific subsystem:

| Test | Subsystem |
|---|---|
| Plain message ("hi") | Entity-model routing, `messages_in` → agent → `messages_out` round-trip |
| Voice note | Transcription path (Groq or OpenAI per Phase 6 item 4) |
| Image | image-vision skill (if installed) |
| "What's on my calendar today?" | Calendar via `/add-calendar-tool` skill |
| "Search Drive for X" | Drive MCP |
| "Parcel info for <address>" | Regrid MCP |
| "Save this to Dropbox" | Dropbox MCP |
| "Remind me in 1 minute to test" | Task scheduling (v2 `messages_in` `kind='task'`) |
| Wait for the task to fire | Session resumption + container wake on `process_after` |

If anything fails, diagnose via:
- `~/nanoclaw-v2/logs/nanoclaw.log` (host)
- `data/v2-sessions/<session_id>/inbound.db` + `outbound.db` (SQLite via `pnpm exec tsx scripts/q.ts <db> "<query>"`)
- `ncl sessions get <session_id>` (admin CLI; group-scoped, requires owner role for cross-group reads)
- `ncl groups config get <folder>` to inspect what landed in `container_configs`

## Phase 8: Catch up to current 2.0.x patches

```
/update-nanoclaw
```

Brings PG forward from the v2 base version that `migrate-v2.sh` used to current upstream.  Verify:

```bash
diff \
  <(jq -r '.version' ~/nanoclaw-v2/package.json) \
  <(git -C ~/nanoclaw-v2 show upstream/main:package.json | jq -r '.version')
```

Should be empty (versions match).

## Phase 9: 72-hour verification window

Run for ≥72 hours before touching Jeeves.  Watch:

- `~/nanoclaw-v2/logs/nanoclaw.log` for new error patterns.
- TeeJS dashboard (per memory `reference_nanoclaw_dashboard`).
- The Telegram group itself.
- Drift cron output Monday 9am CST: should report ~0-commit drift now.
- OneCLI vault health: `curl -s http://127.0.0.1:10254/health`.

Bugs in the first 72h: prioritize root-cause analysis over rollback.  Rollback is for showstoppers only (bot down, data loss, credential leak).

---

## Rollback (anytime before Phase 9 completes)

v1 is untouched throughout the migration.  Rolling back is a service restart:

```bash
# Stop v2 (find unit name first)
cd ~/nanoclaw-v2 && source setup/lib/install-slug.sh
V2_UNIT=$(systemd_unit)
sudo systemctl stop "$V2_UNIT"

# Start v1 (older unit name, pre-2.0.63 slugging)
sudo systemctl start nanoclaw   # or whatever v1's unit name actually is on this host
```

Verify v1 resumes: tail `~/nanoclaw/logs/nanoclaw.log`, send a test message to the Telegram group.

Only if `migrate-v2.sh` did something weird and v1 isn't healthy after restart: restore the Phase 1 tarball over `~/nanoclaw`.  This should never be needed because `migrate-v2.sh` never writes to v1.

---

## Phase 10: Jeeves migration (out of scope; separate plan, after PG stable ≥ 1 week)

Jeeves migrates only after Power Glove is stable for at least one week post-migration.  Andrea-facing reliability matters more than catch-up speed.

The Jeeves plan follows the same shape with these substitutions:

- `~/nanoclaw-jeeves` instead of `~/nanoclaw`
- `~/nanoclaw-jeeves-v2` instead of `~/nanoclaw-v2`
- Andrea's GCP project `501488433537` / `jeeves-490713` — DO NOT cross with Jon's `523151035551` per memory `feedback_account_separation`
- Andrea's GitHub fork `andreamelton02-stack/nanoclaw` instead of Jon's
- Jeeves's 3 MCP servers (calendar, gmail, drive — no dropbox, no regrid, no eBay)
- Andrea-scoped OneCLI vault

A separate `V2_MIGRATION_PLAN.md` will live in `~/nanoclaw-jeeves` when it's time.

## Out of scope for THIS plan

- Touching the `channels` branch repo or upstreaming any PRs to nanocoai.
- In-flight feature work (Option B IPC-pipe gate decided "no go").
- Apple Container migration (PG is Docker; v2 keeps Docker as default).
- Anything WhatsApp-related (per memory `feedback_no_whatsapp`).

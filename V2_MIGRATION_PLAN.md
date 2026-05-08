# Power Glove migration to nanoclaw 2.0.x

**Drafted:** 2026-04-29
**Last refreshed:** 2026-05-07
**Target:** Power Glove fork (`~/nanoclaw`).  Jeeves migrates separately, later.

## Sources & verified state (2026-05-07)

- Upstream version: `2.0.33` (trunk, was 2.0.15 on 2026-04-29 — upstream churned 18 patches in 8 days).  Major release `2.0.0` landed `2026-04-22`.
- Power Glove version: `1.2.52` (unchanged).
- Drift vs `upstream/main`: **43 commits ahead, 759 commits behind, 461 files changed** (was 41 / 473 / 431 on 2026-04-29).  Behind-count grew by 286 in 8 days.
- Working tree: dirty.  Changes since last refresh:
  - `src/index.ts` band-aid is now **committed** at `0ce6c18` ("wip(group-queue): firstReplyClosed band-aid (Option B TODO)").
  - New uncommitted edits: `package.json`, `package-lock.json`, `container/agent-runner/package.json`, `container/agent-runner/package-lock.json`.  Origin unknown — investigate before Phase 1.
  - New untracked file: `VOICE_MODE_PLAN.md`.  Side-project document; decide whether to commit, gitignore, or move out before snapshot.
- Existing rollback tag: `pre-upgrade-1.2.35` (now 35 days old; do not reuse).
- Migrate skill installed at `~/nanoclaw/.claude/skills/migrate-nanoclaw/SKILL.md`.  Still **Tier 3 Complex** (759 commits, 461 files, architectural rewrite).
- Channels remote: only `telegram` (no discord/slack/whatsapp to re-add).
- Live custom overlay path that disappears in v2: `data/sessions/telegram_main/agent-runner-src/` containing `calendar-mcp.ts, drive-mcp.ts, dropbox-mcp.ts, regrid-mcp.ts, ipc-mcp-stdio.ts, index.ts` (memory-kernel registration).

---

## Customization inventory (the things that must survive)

Built from `git log upstream/main..HEAD` + filesystem inspection.  This is the freeze list; every item must be re-verified after migrate.

### Code customizations

1. **Native MCP server registrations** in `agent-runner-src/index.ts`: `memory_kernel`, calendar, drive, dropbox, regrid (commits `6531694`, `835d383`).  *Hardest single item* because v2 removes per-group `agent-runner-src/` overlays.
2. **Custom MCP server source files**: `calendar-mcp.ts`, `drive-mcp.ts`, `dropbox-mcp.ts`, `regrid-mcp.ts`, `ipc-mcp-stdio.ts`.
3. **Per-instance container naming + stale reaper + heartbeats + IPC reset + send_file + channel crash protection** (`835d383`).
4. **Telegram extensions**: whisper transcription, attachments, `sendFile`, document text extraction (`137845e`).
5. **Channel-aware text styles** with dash and double-space rules (`d8ddb4a`).
6. **Container system tooling, container skills, host utility scripts** (`1a98dfd`).
7. **Installable skills**: `add-dropbox-tool`, `add-drive-tool`, `add-calendar-tool`, `add-regrid-tool` (own commits each).
8. **The `firstReplyClosed` band-aid in `src/index.ts`** (uncommitted as of 2026-04-29).  Project memory `project_nanoclaw_option_b_todo.md` says this is a band-aid for a real problem; carry it across, do not lose it.
9. **`upstream-drift-check.sh` + Monday 9am CST cron** (`3bebbed`).
10. **CLAUDE.md upgrade discipline doc** (`b73472c`).
11. **Power Glove env injection docs** (`06bf5a1`, `f2aba47`).
12. **Whisper server binary gitignore** (`f01105d`).

### Data / config (NOT touched by migrate, but must be preserved on rollback)

- `groups/main/`, `groups/telegram_main/` (memory-kernel state, mempalace, attachments, transcripts, recipes, conversations).
- `.env` (CONTAINER_IMAGE, CONTAINER_PREFIX, all credentials).
- `~/.gmail-mcp/` AND `groups/telegram_main/.gmail-mcp/` (per memory `project_gmail_dual_path_gotcha.md`, both paths matter).
- `.calendar-mcp/`, `.drive-mcp/`, `.dropbox-mcp-server/`, `.mempalace/` under `groups/`.
- OneCLI vault contents.

---

## Architectural watch-out

The single most consequential v2 change for Power Glove is the loss of `agent-runner-src/` overlays.  In 1.x, each group has a writable copy of the agent-runner source where the memory_kernel + 4 native MCPs are registered.  In 2.0, all groups mount one shared, read-only agent-runner; per-group customization happens in composed `CLAUDE.md` fragments, not source code.  That means the MCP registrations have to either (a) move into the shared agent-runner (good for both bots, requires upstream-PR-or-fork-the-runner), or (b) become an `.mcp.json`-style config the runner reads at startup.  Decide this *before* running migrate, because the migration guide needs to capture the intent, not just the old code.

---

## Phase 0: Pre-conditions (do not start migration until all true)

Status as of 2026-05-07:

- [~] Jeeves identity Phase B/C done.  Phase A complete (git config = Andrea).  Phase B in progress this session — both gh accounts already authed; fork+repoint+push happening today.  Phase C drift-check rollout queued.
- [ ] Andrea Gmail flap stable for 48h.  **Note:** the 02:22 UTC 2026-05-07 reset was a host kernel auto-upgrade reboot (`6.17.0-22` → `6.17.0-23`), not a bot flap.  Treat as external; resume the 48h count from the prior stable window if no bot-internal failures appear.
- [x] Wed 8pm CDT auto-delete cron ran (2026-04-30 01:00 UTC) but failed verifier check #3 (`error log written after archive time`).  Verifier was overly strict — wedge errors are unrelated to the archive.  Archive being removed manually 2026-05-07.
- [x] Option B IPC-pipe gate decision made: "no go" (kept band-aid).  Band-aid committed at `0ce6c18` 2026-05-07.  TODO: package.json dirty edits and `VOICE_MODE_PLAN.md` untracked file still need to be reconciled before Phase 1 snapshot.
- [x] 2.0.x has been on upstream `>= 14 days` from `2.0.0` date (`2026-04-22`).  Cleared 2026-05-06.  Today (2026-05-07) is day 15.
- [ ] Read the nanoclaw Discord for the past 7 days for v2 migration reports from other forks.

If all true, proceed.  Otherwise, defer.

---

## Phase 1: Snapshot and rollback prep

```bash
cd ~/nanoclaw

# Commit or stash the dirty src/index.ts.  Commit is preferred so it appears in the
# customization extract.  Use a message that flags it as a band-aid.
git add src/index.ts
git commit -m "wip(group-queue): firstReplyClosed band-aid (Option B TODO)"

# Snapshot tags -- do BOTH:
git tag pre-v2-migration-$(date +%Y%m%d)         # human-readable
git tag -f rollback/powerglove-pre-v2 HEAD        # canonical name

# Branch backup (so reflog loss can't kill us)
git branch backup/pre-v2-$(date +%Y%m%d)

# Push tags + backup branch to origin
git push origin --tags
git push origin "backup/pre-v2-$(date +%Y%m%d)"

# Snapshot the data dirs that migrate won't touch but a botched rollback could
tar czf ~/nanoclaw-data-snapshot-$(date +%Y%m%d).tar.gz \
  -C ~/nanoclaw groups data/sessions .env

# Snapshot the current Docker image so rollback doesn't require rebuild
docker tag nanoclaw-agent:powerglove nanoclaw-agent:powerglove-pre-v2
```

Verify all five artifacts exist before continuing.

---

## Phase 2: Stop the bot cleanly

Per feedback: stop only, never remove containers.

```bash
# Stop the host service (whatever your nanoclaw service unit is named)
sudo systemctl stop nanoclaw-powerglove   # adjust to actual unit name

# Stop the agent container if running, do not rm it
docker ps --filter "name=powerglove" --format '{{.Names}}' | xargs -r docker stop
```

Wait for any in-flight conversation in the Telegram group to drain.  Confirm by tailing logs for ~2 minutes of silence.

---

## Phase 3: Run the migrate skill (Extract phase)

The skill auto-tiers and produces a migration guide at `.nanoclaw-migrations/guide.md`.  Run it inside `~/nanoclaw`:

```
/migrate-nanoclaw
```

When the skill asks scope questions, answer:

- Tier: **Complex** (do not let it talk you into Tier 2; 431 changed files is Tier 3 territory).
- Existing guide at `.nanoclaw-migrations/guide.md` (per commit `83c1571`, an old pre-v2 snapshot already exists): choose **Re-extract from scratch**.  The old one predates final v2 trunk.
- Skill exploration prompt: let it run haiku sub-agents in parallel.

When the skill produces the draft guide, **do not proceed to Upgrade phase yet**.  Read the guide end-to-end and verify every item from the customization inventory above is captured with enough fidelity that a fresh Claude session could reapply it.  Particularly verify:

- The MCP registrations describe the *intent* (which 5 MCP servers, what tools each exposes, env they need), not just the old `agent-runner-src/index.ts` file.
- The `firstReplyClosed` band-aid is captured with its reason (Option B replacement pending).
- The Telegram extensions are described per-feature, not as a code dump.

If anything is thin, tell the migrate skill what to add.  This is the only artifact that survives, so trade tokens for completeness.

---

## Phase 4: Architecture decision before Upgrade phase

Before running migrate's Upgrade phase, decide how the 5 MCP servers will live in v2.  Options:

**Option A -- composed `CLAUDE.md` + `.mcp.json` per group.**  The MCP servers stay as standalone Node processes spawned by the read-only agent-runner via a per-group MCP config.  Lowest blast radius, no agent-runner fork.  Probably the right call.  Requires confirming v2's agent-runner reads a per-group MCP config (verify against upstream `docs/architecture.md` and `docs/isolation-model.md`).

**Option B -- fork the agent-runner.**  Keep the registrations baked in.  Means maintaining a Power-Glove-specific agent-runner image instead of using upstream's shared one.  Permanent drift cost.  Avoid unless A is impossible.

**Option C -- upstream PRs.**  Submit the 5 MCP registrations to qwibitai/nanoclaw.  Slowest but cleanest long-term.  Realistic only for memory_kernel since the others (calendar/drive/dropbox/regrid) are Jon-specific integrations.

Pick before Phase 5.  If Option A is viable, the migration guide should describe MCP setup as "drop these 5 files into `groups/<g>/mcp/`, register in `groups/<g>/.mcp.json`" rather than "edit agent-runner-src/index.ts."

---

## Phase 5: Run the migrate skill (Upgrade phase)

```
/migrate-nanoclaw   # second run -- choose "Skip to upgrade"
```

The skill creates a worktree at `.upgrade-worktree/`, checks out clean upstream, and reapplies the guide.  Watch for:

- Telegram code: it will not be in trunk.  Skill must call `/add-telegram` (see Phase 6) or note it as a follow-up.
- Bun-incompatible deps: `googleapis`, `google-auth-library`, anything Node-native.  The skill should flag these; if it doesn't, ask it to.
- `.env` keys that no longer exist in 2.0 (e.g. `CONTAINER_IMAGE` may be replaced).

When the worktree validates, the skill swaps it in.  Do not delete `.upgrade-worktree` immediately; keep it for one week as a side-by-side reference.

---

## Phase 6: Re-install Telegram channel

```
/add-telegram
```

Re-add the Telegram channel from the `channels` branch.  Then reapply the Telegram-specific extensions from the customization inventory (whisper, attachments, sendFile, document text extraction) on top of the freshly-installed channel.

---

## Phase 7: Re-integrate native MCP servers (per Phase 4 decision)

Assuming Option A:

- Copy the 5 `.ts` files into the v2-appropriate location for per-group MCP servers.
- Build them (Bun-compatible -- verify `googleapis` works under Bun, fall back to standalone Node spawning if not).
- Register in the per-group MCP config.
- Re-point `MEMORY_DIR` env to the new container path for memory-kernel (was `/workspace/group/memory-kernel`; verify v2's mount path).

---

## Phase 8: Re-apply remaining customizations

Walk the customization inventory items 3, 5, 6, 7, 8, 9, 10, 11, 12 in order.  Each gets re-applied per the migration guide.  Two specifically need attention:

- **Item 3 (per-instance container naming + stale reaper):** v2 may have its own container isolation model now.  Check whether your `CONTAINER_PREFIX` work is redundant.  If yes, drop it.  If no, port it.
- **Item 8 (`firstReplyClosed` band-aid):** the file path may have changed.  If v2 restructured `src/group-queue.ts`, the band-aid may not even apply.  Test this first; if it does not reproduce in v2, *delete the band-aid* and the related TODO memory.

---

## Phase 9: Smoke test (host-side, before re-enabling Telegram)

```bash
# Build the new image
docker build -t nanoclaw-agent:powerglove .   # adjust per v2 build instructions

# Start with a private test channel, NOT the live Telegram group
# Verify:
# - Container starts, Bun runtime healthy
# - memory_kernel MCP responds to mk_recall
# - Each of the 4 other MCPs responds to a basic tool call
# - inbound.db and outbound.db both created
# - OneCLI credentials inject correctly (no API key in container env)
# - send_file works
# - Whisper transcription works on a test voice note
```

Only after all green, point the live Telegram channel at it.

---

## Phase 10: Catch up to current upstream patches

After migrate succeeds, you will be on `2.0.0` (or whatever base the migrate skill used).  Bring forward to current `2.0.x` with the patch path:

```
/update-nanoclaw
```

Verify version: `jq -r '.version' package.json` should match upstream.

---

## Phase 11: Verification window

Run for 72 hours minimum before touching Jeeves.  Watch:

- `~/nanoclaw/groups/telegram_main/logs/` for new error patterns.
- TeeJS dashboard if installed (per memory `reference_nanoclaw_dashboard.md`).
- The Telegram group itself (Jon-facing, so you will see drift fast).
- Drift cron output Monday 9am CST should now report 0-commit drift.

Bugs in the first 72h: prioritize root cause over rollback.  Rollback is for showstoppers only (bot down, data loss, credential leak).

---

## Rollback procedure (if showstopper before Phase 11 ends)

```bash
sudo systemctl stop nanoclaw-powerglove
docker ps --filter "name=powerglove" --format '{{.Names}}' | xargs -r docker stop

cd ~/nanoclaw
git reset --hard rollback/powerglove-pre-v2

# Restore data only if migrate touched it (it shouldn't, but verify)
# tar xzf ~/nanoclaw-data-snapshot-YYYYMMDD.tar.gz -C ~/nanoclaw

docker tag nanoclaw-agent:powerglove-pre-v2 nanoclaw-agent:powerglove
sudo systemctl start nanoclaw-powerglove
```

The `git reset --hard` is the only destructive action; it is safe because of the backup branch and snapshot tag pushed to origin in Phase 1.

---

## Out of scope for this plan

- Touching Jeeves.  Jeeves migrates only after Power Glove is stable for 1+ weeks.  Andrea-facing reliability matters more than catch-up speed.
- Touching the `channels` branch repo or upstreaming any PRs.  Out of scope; can be follow-up after both bots are on 2.x.
- Migrating any in-flight feature work (Option B IPC-pipe gate).  Phase 0 requires it be settled first.

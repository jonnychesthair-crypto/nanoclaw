# NanoClaw (Power Glove)

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## OAuth Lock (Power Glove = Jon)  read before any Google-auth claim

Power Glove is **connected to Google via OAuth**.  The GCP project is **bubbly-mantis-488216-k1** (number `523151035551`, display name `OpenClaw`), owner `jonsmelton@gmail.com`, **PUBLISHED to production 2026-04-16**.  Refresh tokens are **indefinite**.  Do NOT raise the "7-day testing-mode expiry" hypothesis ever again.

Identifier: every Power Glove `gcp-oauth.keys.json` has `client_id` starting with **`523...`**.  That is the only authoritative ownership signal.  The `project_id` STRING in the keys file is decoration; ignore it.

Credential paths (host) - all three live at `~/`:
- Gmail: `~/.gmail-mcp/` (referenced by `GMAIL_CREDENTIALS_DIR=/home/melto007/.gmail-mcp` in `.env`; forwarded into container by `src/container-runner.ts` lines ~192-198)
- Calendar: `~/.calendar-mcp/` (legacy host-home path; **not actually read by the bot**)
- Drive: `~/.drive-mcp/`

Credential paths (the ones the container actually reads via `HOME=/workspace/group` resolution in the calendar MCP subprocess):
- Calendar: `~/nanoclaw/groups/telegram_main/.calendar-mcp/credentials.json` <- THIS is the one that matters for calendar.
- Gmail: container reads via the `GMAIL_CREDENTIALS_DIR` env injection, not via `HOME` resolution.

### Hard rules

1.  Never run `~/.calendar-mcp/reauth*.js` or `scripts/auth-calendar.js`.  They are quarantined (renamed to `.DEAD-PATH-DO-NOT-RUN.txt`) because they write to a path the container does not read.  The PreToolUse hook at `~/.claude/hooks/oauth-guard.sh` also blocks them.
2.  Never `cp` between `~/.{gmail,calendar,drive}-mcp/` and `~/.{gmail,calendar,drive}-mcp-andrea/`.  Jeeves is a separate bot in a separate container with a separate Google account.  Cross-bot ops blocked by the hook.
3.  The only verified-working Calendar reauth helper is `scripts/auth-powerglove-calendar.cjs` (port 3778, login_hint=jonsmelton@gmail.com, identity check).  Do not run it unless `invalid_grant` is verified by curl against `https://oauth2.googleapis.com/token` with the actual refresh_token.
4.  Never edit `credentials.json` or `gcp-oauth.keys.json` directly.  The hook will surface a confirmation prompt if you try.

### When Google integration looks broken

Read in this order: this section, then `~/.claude/projects/-home-melto007/memory/project_gmail_publish_app.md` (diagnostic curl), then `project_calendar_oauth_setup_pattern.md`.  Only then form a hypothesis.  The 2026-05-11 incident cost 2+ hours by skipping that step.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |

## Secrets / Credentials / Proxy (OneCLI)

Upstream nanoclaw uses an OneCLI gateway for secret injection.  **Power Glove diverges from this** (see next subsection) and **Google OAuth credentials are NOT routed through OneCLI** at all -- they live as files on disk per the "OAuth Lock" section above.  When in doubt about a Google integration, the answer is in OAuth Lock, not OneCLI.

### Power Glove env injection (fork divergence from upstream)

Power Glove additionally passes third-party API credentials (`DROPBOX_*`, `CALENDAR_IDS`, `REGRID_API_TOKEN`, `EBAY_*`, etc.) into containers via docker `-e` flags directly from the running service's `process.env`.  The systemd unit (`~/.config/systemd/user/nanoclaw.service`) loads `.env` via `EnvironmentFile=`, and `src/container-runner.ts` (lines ~274-330) chooses which env vars to forward.

This diverges from upstream nanoclaw's pattern, which uses a `data/env/env` file mount.  On Power Glove the `data/env/env` file is unused -- instructions to `cp .env data/env/env` in upstream-inherited skills (`/add-discord`, `/add-emacs`, `/add-slack`, `/add-telegram`, `/add-voice-transcription`, `/add-whatsapp`) are no-ops here and can be ignored.

When adding a new env-var-driven MCP server or channel on Power Glove: edit `src/container-runner.ts` to forward the new var via `args.push('-e', ...)`, NOT `data/env/env`.

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/migrate-nanoclaw` | Major version bumps (1.x → 2.x).  Replays customizations on clean upstream. |
| `/init-onecli` | Install OneCLI Agent Vault and migrate `.env` credentials to it |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

**Major-version upgrades MUST use `/migrate-nanoclaw`, not `git merge upstream/main`** -- the architectural rewrite makes a 3-way merge meaningless and destroys customizations.

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

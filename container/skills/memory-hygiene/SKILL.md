---
name: memory-hygiene
description: Periodic memory pruning and cleanup.  Reviews memory-kernel atoms, conversation archives, and rendered memory files.  Removes stale entries, deduplicates, and reports what changed.  Runs as a scheduled task.
---

# /memory-hygiene — Memory Pruning

Review and clean up accumulated memory across all storage systems.  This skill runs as a weekly scheduled task in isolated context.

## Step 1: Garbage collect memory-kernel

Run memory-kernel garbage collection to remove expired and duplicate atoms:

```bash
cd /workspace/group && npx mk gc -d memory-kernel 2>&1 || echo "mk gc not available, skipping"
```

Then run reflection to consolidate:

```bash
cd /workspace/group && npx mk reflect -d memory-kernel 2>&1 || echo "mk reflect not available, skipping"
```

## Step 2: Review memory-kernel atoms

List all current atoms and identify problems:

```bash
cd /workspace/group && npx mk recall -d memory-kernel --format json 2>&1 | head -200
```

Look for:
- **Stale atoms**: facts that are no longer true (references to old dates, completed tasks, resolved issues)
- **Duplicates**: atoms that say the same thing in different words
- **Contradictions**: atoms that conflict with each other

For each problem found, note the atom ID and what's wrong.  Do NOT delete anything yet in this step.

## Step 3: Prune conversation archives

Check conversation archives for old files:

```bash
ls -la /workspace/group/conversations/ 2>/dev/null | head -30
```

- Archives older than 30 days: summarize the key decisions/outcomes into a single `archive-summary.md`, then delete the individual files
- Keep anything from the last 30 days untouched

## Step 4: Re-render CLAUDE-MEMORY.md

After cleanup, re-render the memory file:

```bash
cd /workspace/group && npx mk render memory-kernel CLAUDE-MEMORY.md 2>&1 || echo "mk render not available, skipping"
```

## Step 5: Report

Send a summary to the main channel using the `send_message` MCP tool.  Format:

```
Memory Hygiene Report

Atoms reviewed: N
- Removed: N (stale: N, duplicate: N, contradictory: N)
- Kept: N

Conversation archives:
- Total: N files
- Pruned: N files older than 30 days
- Summarized to: archive-summary.md (if applicable)

CLAUDE-MEMORY.md: re-rendered (N bytes)
```

If this is the first run or nothing needs cleanup, say so.  Don't make changes for the sake of making changes.

## Important

- Log everything you prune to `/workspace/group/memory-hygiene-log.md` with timestamps before deleting
- When in doubt, keep the atom -- false negatives (keeping junk) are better than false positives (deleting something useful)
- Never touch CLAUDE.md -- that's the identity file, not memory

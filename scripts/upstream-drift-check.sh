#!/bin/bash
# Weekly upstream-drift check for the Power Glove fork.
#
# Compares jonnychesthair-crypto/nanoclaw vs qwibitai/nanoclaw upstream/main.
# Opens a GitHub issue on the fork (label: drift-report) if any of:
#   - drift count > DRIFT_THRESHOLD upstream commits since fork HEAD
#   - any [BREAKING] entry in upstream CHANGELOG version >= 2.0.0
#   - any open setup/install bug on upstream in the last 7 days
# Otherwise prints a short "OK" summary and exits 0.
#
# Usage:
#   upstream-drift-check.sh             # real run
#   upstream-drift-check.sh --dry-run   # build report, print to stdout, do not open issue

set -euo pipefail

FORK="jonnychesthair-crypto/nanoclaw"
UPSTREAM="qwibitai/nanoclaw"
DRIFT_THRESHOLD=10

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# 1. Auth check — capture stderr so cron logs the actual reason instead of failing silent
ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
auth_err=$(gh auth status 2>&1) || {
  echo "$(ts) SKIP: gh auth status failed (config=${GH_CONFIG_DIR:-default})"
  echo "$auth_err" | sed 's/^/  /'
  exit 1
}

# 2. Fork HEAD on main
fork_head_json=$(gh api "repos/$FORK/commits?sha=main&per_page=1" --jq '.[0]')
fork_sha=$(echo "$fork_head_json" | jq -r '.sha[0:7]')
fork_date=$(echo "$fork_head_json" | jq -r '.commit.committer.date')
fork_date_ct=$(TZ=America/Chicago date -d "$fork_date" "+%Y-%m-%d %H:%M %Z")

# 3. Upstream commits since fork HEAD (paginated, single JSON array)
upstream_commits=$(gh api "repos/$UPSTREAM/commits?sha=main&since=$fork_date&per_page=100" --paginate --slurp)
drift_count=$(echo "$upstream_commits" | jq '[.[] | .[]] | length')

# Top 30 by committer date, descending
top30=$(echo "$upstream_commits" | jq '[.[] | .[]] | sort_by(.commit.committer.date) | reverse | .[0:30]')

# 4. Upstream CHANGELOG, [BREAKING] entries in v2.x sections
tmp_changelog=$(mktemp)
trap 'rm -f "$tmp_changelog"' EXIT
gh api "repos/$UPSTREAM/contents/CHANGELOG.md" --jq '.content' | base64 -d > "$tmp_changelog"

# Tag each [BREAKING] line with the version section it lives in.
breaking_with_versions=$(awk '/^## \[/{section=$0} /\[BREAKING\]/{print section " :: " $0}' "$tmp_changelog")
v2_breaking_lines=$(echo "$breaking_with_versions" | grep '## \[2\.' || true)
if [ -z "$v2_breaking_lines" ]; then
  v2_breaking_count=0
else
  v2_breaking_count=$(echo "$v2_breaking_lines" | wc -l | tr -d ' ')
fi

# 5. Hot spots: per customized file, upstream commits since fork HEAD that touched it
hot_spot_files=(
  "src/container-runner.ts"
  "src/container-runtime.ts"
  "src/channels/telegram.ts"
  "container/agent-runner/src/index.ts"
  "src/config.ts"
)
hot_spots_md=""
for f in "${hot_spot_files[@]}"; do
  hits=$(gh api "repos/$UPSTREAM/commits?sha=main&path=$f&since=$fork_date&per_page=20" \
    --jq '.[] | "- \(.sha[0:7]) \(.commit.committer.date | sub("T.*"; "")): \(.commit.message | split("\n")[0])"' \
    2>/dev/null || true)
  if [ -z "$hits" ]; then
    hits="- no upstream changes since fork HEAD"
  fi
  hot_spots_md+=$'\n### '"$f"$'\n\n'"$hits"$'\n'
done

# 6. Setup/install bugs (open, last 7 days, upstream)
seven_days_ago=$(date -u -d '7 days ago' +%Y-%m-%d)
all_recent=$(gh issue list --repo "$UPSTREAM" --state open \
  --search "created:>=$seven_days_ago" --limit 50 \
  --json number,title,createdAt,labels)
setup_bugs=$(echo "$all_recent" | jq '[.[] | select(.title | test("install|setup|docker|systemd|linux|ubuntu|debian|onecli|sudo|node"; "i"))]')
setup_bug_count=$(echo "$setup_bugs" | jq 'length')

# 7. Threshold check
should_open_issue=0
[ "$drift_count" -gt "$DRIFT_THRESHOLD" ] && should_open_issue=1
[ "$v2_breaking_count" -gt 0 ] && should_open_issue=1
[ "$setup_bug_count" -gt 0 ] && should_open_issue=1

today=$(TZ=America/Chicago date +%Y-%m-%d)

if [ "$should_open_issue" -eq 0 ]; then
  echo "OK: drift=$drift_count, breaking=$v2_breaking_count, setup-bugs=$setup_bug_count -- no action needed (as of $today CT)"
  exit 0
fi

# 8. Compose markdown body
commits_table=$(echo "$top30" | jq -r '.[] | "| \(.sha[0:7]) | \(.commit.committer.date | sub("T.*"; "")) | \(.commit.message | split("\n")[0] | gsub("\\|"; "\\\\|")) |"')
bugs_table=$(echo "$setup_bugs" | jq -r '.[] | "| \(.number) | \(.title | gsub("\\|"; "\\\\|")) | \(.createdAt | sub("T.*"; "")) | \(.labels | map(.name) | join(", ")) |"')

if [ "$v2_breaking_count" -gt 0 ]; then
  recommendation="**Wait.**  New [BREAKING] entries upstream and the v1 -> v2 migration is on hold."
elif [ "$drift_count" -gt 100 ]; then
  recommendation="**Migrate via /migrate-nanoclaw.**  Drift is large; consider replay-on-clean-base instead of merge."
elif [ "$setup_bug_count" -gt 0 ]; then
  recommendation="**Run /update-nanoclaw selectively.**  Skip commits affected by the open setup bugs."
else
  recommendation="**Run /update-nanoclaw.**  Drift looks mergeable."
fi

body=$(cat <<EOF
## Summary

$drift_count upstream commits since fork HEAD ($fork_sha, $fork_date_ct).  $v2_breaking_count new [BREAKING] entries.  $setup_bug_count open setup/install bugs (last 7 days).

## Commits Behind (top 30)

| sha | date (UTC) | message |
|-----|------------|---------|
$commits_table

## Breaking Changes (upstream v2.x, unmerged)

$v2_breaking_lines

## Hot Spots in Customized Files
$hot_spots_md

## Setup/Install Bugs (open, last 7 days)

| # | title | created | labels |
|---|-------|---------|--------|
$bugs_table

## Recommended Action

$recommendation
EOF
)

title="weekly drift report $today: $drift_count commits behind, $v2_breaking_count breaking, $setup_bug_count setup-bugs"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "=== DRY RUN: would create issue on $FORK ==="
  echo ""
  echo "TITLE: $title"
  echo ""
  echo "BODY:"
  echo "----"
  echo "$body"
  echo "----"
  exit 0
fi

# 9. Real run: create the issue
url=$(gh issue create --repo "$FORK" --title "$title" --body "$body" --label drift-report)
echo "ISSUE: $url"

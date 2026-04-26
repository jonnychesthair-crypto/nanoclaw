#!/usr/bin/env bash
# NanoClaw Daily Security Scan
# Checks container isolation, credential exposure, mount security,
# dependency vulnerabilities, and runtime state.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

NANOCLAW_DIR="/home/melto007/nanoclaw"
ALLOWLIST="/home/melto007/.config/nanoclaw/mount-allowlist.json"
LOGFILE="/home/melto007/nanoclaw/logs/security-scan.log"
ISSUES=0

mkdir -p "$(dirname "$LOGFILE")"

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
  echo -e "$msg"
  echo -e "$msg" >> "$LOGFILE"
}

pass() { log "${GREEN}[PASS]${NC} $1"; }
warn() { log "${YELLOW}[WARN]${NC} $1"; ISSUES=$((ISSUES + 1)); }
fail() { log "${RED}[FAIL]${NC} $1"; ISSUES=$((ISSUES + 1)); }

log "========================================="
log "NanoClaw Security Scan - $(date '+%Y-%m-%d %H:%M:%S')"
log "========================================="

# -------------------------------------------------------------------
# 1. Mount allowlist integrity
# -------------------------------------------------------------------
log ""
log "--- Mount Allowlist ---"

if [[ -f "$ALLOWLIST" ]]; then
  # Check it hasn't been modified in the last 24h (unexpected change)
  if [[ $(find "$ALLOWLIST" -mmin -1440 -newer "$NANOCLAW_DIR/package.json" 2>/dev/null) ]]; then
    warn "Mount allowlist was modified more recently than package.json -- review changes"
  else
    pass "Mount allowlist unchanged"
  fi

  # Verify nonMainReadOnly is true
  if jq -e '.nonMainReadOnly == true' "$ALLOWLIST" > /dev/null 2>&1; then
    pass "nonMainReadOnly is enabled"
  else
    fail "nonMainReadOnly is NOT true -- non-main groups may have write access"
  fi

  # Check blocked patterns include critical paths
  for pattern in ".ssh" ".gnupg" ".env" "credentials" ".netrc"; do
    if jq -e ".blockedPatterns | any(test(\"$pattern\"))" "$ALLOWLIST" > /dev/null 2>&1; then
      pass "Blocked pattern covers: $pattern"
    else
      fail "Missing blocked pattern for: $pattern"
    fi
  done
else
  fail "Mount allowlist not found at $ALLOWLIST"
fi

# -------------------------------------------------------------------
# 2. Credential proxy binding
# -------------------------------------------------------------------
log ""
log "--- Credential Proxy ---"

if pgrep -f "credential-proxy" > /dev/null 2>&1; then
  # Check it's only listening on 127.0.0.1
  PROXY_LISTEN=$(ss -tlnp 2>/dev/null | grep ":3001" || true)
  if [[ -n "$PROXY_LISTEN" ]]; then
    if echo "$PROXY_LISTEN" | grep -q "0.0.0.0:3001"; then
      fail "Credential proxy is bound to 0.0.0.0 -- should be 127.0.0.1 only"
    elif echo "$PROXY_LISTEN" | grep -q "127.0.0.1:3001"; then
      pass "Credential proxy bound to 127.0.0.1:3001"
    else
      warn "Credential proxy listening on unexpected interface: $PROXY_LISTEN"
    fi
  else
    pass "Credential proxy running but port 3001 not detected (may use different port)"
  fi
else
  pass "Credential proxy not currently running (normal if nanoclaw is stopped)"
fi

# -------------------------------------------------------------------
# 3. Secrets leaked into group folders or logs
# -------------------------------------------------------------------
log ""
log "--- Secret Leak Scan ---"

SECRET_PATTERNS='(sk-ant-|ANTHROPIC_API_KEY=(?!placeholder)|private_key|BEGIN RSA PRIVATE|BEGIN OPENSSH PRIVATE|BEGIN EC PRIVATE)'

# Scan group folders (exclude expected credential store and session logs)
LEAK_HITS=$(grep -rPl "$SECRET_PATTERNS" \
  --exclude-dir="sessions" \
  --exclude-dir="env" \
  "$NANOCLAW_DIR/groups/" \
  "$NANOCLAW_DIR/logs/" \
  "$NANOCLAW_DIR/data/" \
  2>/dev/null || true)

if [[ -n "$LEAK_HITS" ]]; then
  fail "Possible secret leak found in:"
  echo "$LEAK_HITS" | while read -r f; do log "  - $f"; done
else
  pass "No secrets detected in groups/logs/data folders"
fi

# Check .env is not world-readable
if [[ -f "$NANOCLAW_DIR/.env" ]]; then
  ENV_PERMS=$(stat -c '%a' "$NANOCLAW_DIR/.env")
  if [[ "$ENV_PERMS" =~ [0-7][0-7][4-7] ]]; then
    warn ".env file is world-readable (perms: $ENV_PERMS) -- run: chmod 600 $NANOCLAW_DIR/.env"
  else
    pass ".env file permissions OK ($ENV_PERMS)"
  fi
fi

# -------------------------------------------------------------------
# 4. Unexpected running containers
# -------------------------------------------------------------------
log ""
log "--- Container State ---"

if command -v docker &> /dev/null; then
  RUNNING=$(docker ps --filter "ancestor=nanoclaw-agent:latest" --format '{{.ID}} {{.Names}} {{.Status}} (running {{.RunningFor}})' 2>/dev/null || true)
  if [[ -n "$RUNNING" ]]; then
    CONTAINER_COUNT=$(echo "$RUNNING" | wc -l)
    if [[ "$CONTAINER_COUNT" -gt 5 ]]; then
      warn "$CONTAINER_COUNT agent containers running (max recommended: 5)"
    else
      pass "$CONTAINER_COUNT agent container(s) running"
    fi
    echo "$RUNNING" | while read -r line; do log "  $line"; done
  else
    pass "No agent containers running"
  fi

  # Check for containers running as root
  ROOT_CONTAINERS=$(docker ps --filter "ancestor=nanoclaw-agent:latest" -q 2>/dev/null | \
    xargs -r docker inspect --format '{{.Id}} {{.Config.User}}' 2>/dev/null | \
    grep -E '(root| $)' || true)
  if [[ -n "$ROOT_CONTAINERS" ]]; then
    fail "Agent container(s) running as root: $ROOT_CONTAINERS"
  else
    pass "No agent containers running as root"
  fi

  # Check container image integrity
  IMAGE_ID=$(docker images nanoclaw-agent:latest --format '{{.ID}}' 2>/dev/null || true)
  if [[ -n "$IMAGE_ID" ]]; then
    IMAGE_AGE=$(docker images nanoclaw-agent:latest --format '{{.CreatedSince}}' 2>/dev/null || true)
    pass "Container image: $IMAGE_ID (created $IMAGE_AGE)"
  else
    warn "nanoclaw-agent:latest image not found"
  fi
else
  warn "Docker not available -- cannot check container state"
fi

# -------------------------------------------------------------------
# 5. npm audit (dependency vulnerabilities)
# -------------------------------------------------------------------
log ""
log "--- Dependency Audit ---"

if [[ -f "$NANOCLAW_DIR/package-lock.json" ]]; then
  AUDIT_OUTPUT=$(cd "$NANOCLAW_DIR" && npm audit --json 2>/dev/null || true)
  CRITICAL=$(echo "$AUDIT_OUTPUT" | jq '.metadata.vulnerabilities.critical // 0' 2>/dev/null || echo "0")
  HIGH=$(echo "$AUDIT_OUTPUT" | jq '.metadata.vulnerabilities.high // 0' 2>/dev/null || echo "0")
  MODERATE=$(echo "$AUDIT_OUTPUT" | jq '.metadata.vulnerabilities.moderate // 0' 2>/dev/null || echo "0")

  if [[ "$CRITICAL" -gt 0 ]]; then
    fail "$CRITICAL critical vulnerability(ies) in dependencies"
  fi
  if [[ "$HIGH" -gt 0 ]]; then
    warn "$HIGH high vulnerability(ies) in dependencies"
  fi
  if [[ "$MODERATE" -gt 0 ]]; then
    warn "$MODERATE moderate vulnerability(ies) in dependencies"
  fi
  if [[ "$CRITICAL" -eq 0 && "$HIGH" -eq 0 && "$MODERATE" -eq 0 ]]; then
    pass "No known vulnerabilities in dependencies"
  fi
else
  warn "No package-lock.json found -- skipping npm audit"
fi

# -------------------------------------------------------------------
# 6. File permission checks
# -------------------------------------------------------------------
log ""
log "--- File Permissions ---"

# Check critical config files aren't world-writable
for f in "$ALLOWLIST" "$NANOCLAW_DIR/.env" "$NANOCLAW_DIR/store/nanoclaw.db"; do
  if [[ -f "$f" ]]; then
    PERMS=$(stat -c '%a' "$f")
    if [[ "$PERMS" =~ [0-7][0-7][2367] ]]; then
      fail "$f is world-writable (perms: $PERMS)"
    else
      pass "$f permissions OK ($PERMS)"
    fi
  fi
done

# Check .calendar-mcp credentials
if [[ -f "/home/melto007/.calendar-mcp/credentials.json" ]]; then
  PERMS=$(stat -c '%a' "/home/melto007/.calendar-mcp/credentials.json")
  if [[ "$PERMS" =~ [0-7][0-7][4-7] ]]; then
    warn "Calendar credentials world-readable (perms: $PERMS)"
  else
    pass "Calendar credentials permissions OK ($PERMS)"
  fi
fi

# -------------------------------------------------------------------
# 7. Stale containers (running > 2 hours)
# -------------------------------------------------------------------
log ""
log "--- Stale Container Check ---"

if command -v docker &> /dev/null; then
  STALE=$(docker ps --filter "ancestor=nanoclaw-agent:latest" --format '{{.ID}} {{.RunningFor}}' 2>/dev/null | \
    grep -E '(hours|days|weeks|months)' || true)
  if [[ -n "$STALE" ]]; then
    warn "Stale agent containers detected (running > 1 hour):"
    echo "$STALE" | while read -r line; do log "  $line"; done
  else
    pass "No stale containers"
  fi
fi

# -------------------------------------------------------------------
# Summary
# -------------------------------------------------------------------
log ""
log "========================================="
if [[ "$ISSUES" -eq 0 ]]; then
  log "${GREEN}SCAN COMPLETE: All checks passed${NC}"
else
  log "${YELLOW}SCAN COMPLETE: $ISSUES issue(s) found${NC}"
fi
log "========================================="
log "Full log: $LOGFILE"

exit "$ISSUES"

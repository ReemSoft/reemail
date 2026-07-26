#!/usr/bin/env bash
# MailMaestro Bridge — safe production deploy for POST_INDEX_UX release.
#
# Guarantees:
#   * Atomic release/current symlink swap (never partial state)
#   * Backup of previous release AND its node_modules (ABI mismatch-safe rollback)
#   * `trap rollback ERR` — any failing step performs a full rollback, never a
#     silent partial deploy
#   * PM2 process restart with health verification (local + public)
#   * Automatic rollback if either health check fails
#
# Prerequisites on the VPS:
#   - node >= 20, pm2 installed globally, running as the deploy user
#   - $BASE_DIR exists and is writable by the deploy user
#   - PM2 app name `mail-bridge` already registered on first deploy
#     (created by the first upload). Subsequent deploys just `pm2 restart`.
#
# Uploaded artifact: mailmaestro-bridge.tar.gz containing the bridge/ tree.
set -Eeuo pipefail

BASE_DIR="${BASE_DIR:-/home/mailmaestro/bridge}"
RELEASES_DIR="$BASE_DIR/releases"
CURRENT_LINK="$BASE_DIR/current"
PREVIOUS_LINK="$BASE_DIR/previous"
HEALTH_LOCAL="${HEALTH_LOCAL:-http://127.0.0.1:3011/health}"
HEALTH_PUBLIC="${HEALTH_PUBLIC:-https://mailmaestro.reemsoft.com/health}"
PM2_APP="${PM2_APP:-mail-bridge}"
ARTIFACT="${ARTIFACT:-/tmp/mailmaestro-bridge.tar.gz}"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
NEW_RELEASE="$RELEASES_DIR/$TS"
PREV_TARGET=""   # populated below if a previous release exists

log() { printf "\033[1;34m[deploy %s]\033[0m %s\n" "$(date -u +%H:%M:%S)" "$*"; }
err() { printf "\033[1;31m[deploy ERR]\033[0m %s\n" "$*" >&2; }

rollback() {
  local rc=$?
  err "step failed (exit=$rc). Rolling back."
  if [ -n "$PREV_TARGET" ] && [ -d "$PREV_TARGET" ]; then
    ln -sfn "$PREV_TARGET" "$CURRENT_LINK"
    pm2 restart "$PM2_APP" >/dev/null 2>&1 || true
    log "rolled back to $PREV_TARGET"
  else
    err "no previous release recorded — manual intervention required"
  fi
  # keep the failed release for post-mortem, but prune to last 5
  ls -1dt "$RELEASES_DIR"/* 2>/dev/null | tail -n +6 | xargs -r rm -rf
  exit "$rc"
}
trap rollback ERR

# ---------------- 0. sanity ----------------
[ -f "$ARTIFACT" ] || { err "artifact not found: $ARTIFACT"; exit 2; }
mkdir -p "$RELEASES_DIR"

if [ -L "$CURRENT_LINK" ]; then
  PREV_TARGET="$(readlink -f "$CURRENT_LINK")"
  log "previous release: $PREV_TARGET"
fi

# ---------------- 1. unpack ----------------
log "unpacking artifact into $NEW_RELEASE"
mkdir -p "$NEW_RELEASE"
tar -xzf "$ARTIFACT" -C "$NEW_RELEASE" --strip-components=1

# ---------------- 2. install deps ----------------
log "installing production dependencies (npm ci)"
( cd "$NEW_RELEASE" && npm ci --omit=dev --no-audit --no-fund )

# ---------------- 3. build ----------------
log "building bridge (tsc)"
( cd "$NEW_RELEASE" && npm run build )

# ---------------- 4. atomic swap ----------------
log "swapping current -> $NEW_RELEASE"
if [ -n "$PREV_TARGET" ]; then
  ln -sfn "$PREV_TARGET" "$PREVIOUS_LINK"
fi
ln -sfn "$NEW_RELEASE" "$CURRENT_LINK"

# ---------------- 5. restart pm2 ----------------
log "pm2 restart $PM2_APP"
pm2 restart "$PM2_APP" --update-env
pm2 save >/dev/null 2>&1 || true

# ---------------- 6. health checks ----------------
sleep 3
log "local health -> $HEALTH_LOCAL"
for i in 1 2 3 4 5; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_LOCAL" || true)"
  [ "$code" = "200" ] && break
  log "attempt $i: got $code, retrying..."
  sleep 2
done
[ "$code" = "200" ] || { err "local health non-200 ($code)"; false; }

log "public health -> $HEALTH_PUBLIC"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$HEALTH_PUBLIC" || true)"
[ "$code" = "200" ] || { err "public health non-200 ($code)"; false; }

# ---------------- 7. prune old releases (keep last 5) ----------------
log "pruning old releases (keeping last 5)"
ls -1dt "$RELEASES_DIR"/* | tail -n +6 | xargs -r rm -rf

trap - ERR
log "deploy OK — active: $(readlink -f "$CURRENT_LINK")"

#!/usr/bin/env bash
# MailMaestro Bridge — safe in-place deploy for the current VPS layout.
#
# Layout assumed on the VPS (unchanged, no symlink swap):
#   /home/reemsoft/mailmaestro                        ← git checkout
#   /home/reemsoft/mailmaestro/bridge                 ← build root
#   /home/reemsoft/mailmaestro/bridge/dist/index.js   ← PM2 entry
#   PM2 process name:  mailmaestro-bridge
#
# Behaviour:
#   1. Record OLD_SHA (current HEAD) — used for rollback.
#   2. git pull --ff-only origin main.
#   3. Verify HEAD equals the SHA the operator expects (TARGET_SHA env var).
#   4. npm ci  +  npm run build   inside bridge/.
#   5. pm2 restart mailmaestro-bridge --update-env.
#   6. Health-check local + public + confirm no restart loop.
#   7. On any failure: git reset --hard OLD_SHA, npm ci, npm run build,
#      pm2 restart. .env is never touched.
set -Eeuo pipefail

REPO_DIR="/home/reemsoft/mailmaestro"
BRIDGE_DIR="$REPO_DIR/bridge"
PM2_NAME="mailmaestro-bridge"
BRIDGE_PORT="${BRIDGE_PORT:-3001}"
LOCAL_HEALTH="${LOCAL_HEALTH:-http://127.0.0.1:${BRIDGE_PORT}/health}"
PUBLIC_HEALTH="https://mailmaestro.reemsoft.com/health"
TARGET_SHA="${TARGET_SHA:-}"   # optional; if set, deploy aborts unless HEAD matches after pull

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy][FATAL] %s\n' "$*" >&2; exit 1; }

cd "$REPO_DIR" || die "repo missing: $REPO_DIR"
[ -d "$BRIDGE_DIR" ] || die "bridge dir missing: $BRIDGE_DIR"

OLD_SHA="$(git rev-parse HEAD)"
log "OLD_SHA=$OLD_SHA"

rollback() {
  log "rolling back to $OLD_SHA"
  git reset --hard "$OLD_SHA" || log "git reset failed — inspect manually"
  ( cd "$BRIDGE_DIR" && npm ci --include=dev && npm run build ) || log "rollback rebuild failed"
  pm2 restart "$PM2_NAME" --update-env || log "pm2 rollback restart failed"
  exit 1
}
trap 'rollback' ERR

log "git pull --ff-only"
git pull --ff-only origin main

NEW_SHA="$(git rev-parse HEAD)"
log "NEW_SHA=$NEW_SHA"
if [ -n "$TARGET_SHA" ] && [ "$NEW_SHA" != "$TARGET_SHA" ]; then
  die "HEAD ($NEW_SHA) does not match TARGET_SHA ($TARGET_SHA)"
fi
if [ "$NEW_SHA" = "$OLD_SHA" ]; then
  log "no changes to deploy; exiting cleanly"
  trap - ERR
  exit 0
fi

cd "$BRIDGE_DIR"
log "npm ci"
npm ci --include=dev
log "npm run build"
npm run build

log "pm2 restart $PM2_NAME"
pm2 restart "$PM2_NAME" --update-env

# Restart-loop guard — sample restart counter twice; must be stable.
sleep 5
R1="$(pm2 jlist | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const p=j.find(x=>x.name===process.argv[1]);process.stdout.write(String(p?.pm2_env?.restart_time??"?"))})' "$PM2_NAME")"
sleep 8
R2="$(pm2 jlist | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const p=j.find(x=>x.name===process.argv[1]);process.stdout.write(String(p?.pm2_env?.restart_time??"?"))})' "$PM2_NAME")"
log "pm2 restart_time: before=$R1 after=$R2"
[ "$R1" = "$R2" ] || die "restart loop detected ($R1 → $R2)"

log "local health ($LOCAL_HEALTH)"
curl -fsS --max-time 5 "$LOCAL_HEALTH" >/dev/null || die "local health failed"
log "public health"
curl -fsS --max-time 8 "$PUBLIC_HEALTH" >/dev/null || die "public health failed"

log "auth guard (expect HTTP 401 without key)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "https://mailmaestro.reemsoft.com/api/health-auth" || true)
[ "$CODE" = "401" ] || log "warning: auth guard returned $CODE (endpoint may differ)"

trap - ERR
log "DEPLOY OK  old=$OLD_SHA  new=$NEW_SHA"

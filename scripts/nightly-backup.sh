#!/usr/bin/env bash
# Nightly backup for the DHT portal — run as root from cron, e.g.:
#   30 2 * * *  bash /home/DHT/dht-app/scripts/nightly-backup.sh
#
#  1. Database → $BACKUP_ROOT/db/ (scripts/backup-db.js, keeps the last 14).
#  2. Sundays (or first run): uploads + activity log → $BACKUP_ROOT/files/uploads-YYYY-MM-DD.tar.gz
#     (keeps 2 — full copies of every photo are large, so not kept daily on this disk).
#  3. Sundays (or first run): .env + nginx/Hestia config → $BACKUP_ROOT/config/ (secrets, mode 600, keeps 8).
#  4. If the rclone remote $RCLONE_REMOTE exists (use an rclone *crypt* remote so
#     everything is encrypted), copies off the server:
#       $BACKUP_ROOT (db + config) → $RCLONE_REMOTE:backups
#       $APP_DIR/uploads    → $RCLONE_REMOTE:uploads   (incremental, nightly; never deletes remotely)
#
# Paths can be overridden with environment variables (used for testing).
set -uo pipefail

APP_DIR="${APP_DIR:-/home/DHT/dht-app}"
DATA_DIR="${DATA_DIR:-/home/DHT/data}"
BACKUP_ROOT="${BACKUP_ROOT:-/home/DHT/backups}"
RCLONE_REMOTE="${RCLONE_REMOTE:-dhtbackup-crypt}"
NGINX_PROXY_CONF="${NGINX_PROXY_CONF:-/home/DHT/conf/web/app.deserthottubsaz.com/nginx.ssl.conf_proxy}"
HESTIA_TPL_DIR="${HESTIA_TPL_DIR:-/usr/local/hestia/data/templates/web/nginx/php-fpm}"
NODE_BIN="${NODE_BIN:-$(command -v node || echo /usr/bin/node)}"
WEEKLY="${FORCE_WEEKLY:-}"

LOG="$BACKUP_ROOT/backup.log"
TODAY="$(TZ=America/Phoenix date +%F)"
FAILED=0

mkdir -p "$BACKUP_ROOT/db" "$BACKUP_ROOT/files" "$BACKUP_ROOT/config"
chmod 700 "$BACKUP_ROOT/config"
[ "$(TZ=America/Phoenix date +%u)" = "7" ] && WEEKLY=1

log()  { echo "$(TZ=America/Phoenix date '+%F %T') $*" | tee -a "$LOG"; }
fail() { log "ERROR: $*"; FAILED=1; }

log "=== Backup started ==="

# 1. Database (online backup — safe while the portal is running)
if (cd "$APP_DIR" && DB_PATH="$DATA_DIR/dht-app.db" DB_BACKUP_DIR="$BACKUP_ROOT/db" "$NODE_BIN" scripts/backup-db.js >>"$LOG" 2>&1); then
  log "Database backup OK"
else
  fail "database backup failed"
fi

# 2. Uploads (photos, signatures, PDFs) + activity log — weekly local archive
if [ -n "$WEEKLY" ] || ! ls "$BACKUP_ROOT"/files/uploads-*.tar.gz >/dev/null 2>&1; then
  UPLOADS_ARCHIVE="$BACKUP_ROOT/files/uploads-$TODAY.tar.gz"
  TAR_ITEMS=(-C "$APP_DIR" uploads)
  [ -f "$DATA_DIR/activity.log" ] && TAR_ITEMS+=(-C "$DATA_DIR" activity.log)
  if tar -czf "$UPLOADS_ARCHIVE.tmp" "${TAR_ITEMS[@]}" 2>>"$LOG"; then
    mv "$UPLOADS_ARCHIVE.tmp" "$UPLOADS_ARCHIVE"
    log "Uploads archive OK: $(du -h "$UPLOADS_ARCHIVE" | cut -f1)"
  else
    rm -f "$UPLOADS_ARCHIVE.tmp"
    fail "uploads archive failed"
  fi
  ls -1t "$BACKUP_ROOT"/files/uploads-*.tar.gz 2>/dev/null | tail -n +3 | xargs -r rm -f
fi

# 3. Configuration (secrets) — weekly
if [ -n "$WEEKLY" ] || ! ls "$BACKUP_ROOT"/config/config-*.tar.gz >/dev/null 2>&1; then
  CONFIG_ARCHIVE="$BACKUP_ROOT/config/config-$TODAY.tar.gz"
  CONFIG_ITEMS=()
  [ -f "$APP_DIR/.env" ] && CONFIG_ITEMS+=("$APP_DIR/.env")
  [ -f "$NGINX_PROXY_CONF" ] && CONFIG_ITEMS+=("$NGINX_PROXY_CONF")
  for f in "$HESTIA_TPL_DIR"/dht-node.*; do [ -f "$f" ] && CONFIG_ITEMS+=("$f"); done
  if [ "${#CONFIG_ITEMS[@]}" -gt 0 ] && (umask 077 && tar -czPf "$CONFIG_ARCHIVE" "${CONFIG_ITEMS[@]}" 2>>"$LOG"); then
    chmod 600 "$CONFIG_ARCHIVE"
    log "Config archive OK (${#CONFIG_ITEMS[@]} files)"
  else
    fail "config archive failed or nothing to archive"
  fi
  ls -1t "$BACKUP_ROOT"/config/config-*.tar.gz 2>/dev/null | tail -n +9 | xargs -r rm -f
fi

# 4. Off-server copy (encrypted rclone remote)
if command -v rclone >/dev/null 2>&1 && rclone listremotes 2>/dev/null | grep -qx "$RCLONE_REMOTE:"; then
  if rclone copy "$BACKUP_ROOT" "$RCLONE_REMOTE:backups" --exclude 'backup.log' --exclude '*.tmp' --exclude 'files/**' >>"$LOG" 2>&1 \
     && rclone copy "$APP_DIR/uploads" "$RCLONE_REMOTE:uploads" --exclude 'tmp/**' >>"$LOG" 2>&1; then
    log "Off-server copy OK ($RCLONE_REMOTE)"
  else
    fail "off-server copy to $RCLONE_REMOTE failed"
  fi
else
  log "WARNING: rclone remote '$RCLONE_REMOTE' not configured — backups are on this server only"
fi

if [ "$FAILED" -ne 0 ]; then
  log "=== Backup finished WITH ERRORS ==="
  exit 1
fi
log "=== Backup finished OK ==="

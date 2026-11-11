#!/usr/bin/env bash
# Nightly: pg_dump -Fc of `althingi` to ~/althingi/backups, keep 14 locally, then rclone to R2 if configured.
# Alerts via ops/alert.sh on any failure. Restore test: ops/restore-test.sh
set -euo pipefail
export PATH=/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:$PATH
DIR=$(cd "$(dirname "$0")" && pwd)
[ -f "$HOME/althingi/.env" ] && { set -a; . "$HOME/althingi/.env"; set +a; }
OUT=$HOME/althingi/backups; mkdir -p "$OUT"
F=$OUT/althingi-$(date +%F).dump
trap '"$DIR/alert.sh" "backup FAILED"' ERR
pg_dump -Fc "$DATABASE_URL" -f "$F.tmp" && mv "$F.tmp" "$F"
pg_restore --list "$F" >/dev/null                      # the dump must at least be readable
ls -1t "$OUT"/althingi-*.dump | tail -n +15 | xargs -I{} rm -f {}
if command -v rclone >/dev/null 2>&1 && [ -n "${R2_BACKUP_REMOTE:-}" ]; then
  rclone copyto "$F" "$R2_BACKUP_REMOTE/$(basename "$F")"
fi
echo "ok $(basename "$F") $(du -h "$F" | cut -f1)"

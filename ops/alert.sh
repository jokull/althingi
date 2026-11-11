#!/usr/bin/env bash
# ops/alert.sh "message" — alert via Telegram (openclaw gateway on the mac-mini), mail as fallback.
# Config in ~/althingi/.env:  ALERT_TELEGRAM_TARGET=<chat id>   ALERT_MAIL=<address>
set -uo pipefail
export PATH=/opt/homebrew/bin:$HOME/Library/pnpm:$PATH
[ -f "$HOME/althingi/.env" ] && { set -a; . "$HOME/althingi/.env"; set +a; }
MSG="althingi: ${1:-alert} ($(hostname -s), $(date '+%F %H:%M'))"
if [ -n "${ALERT_TELEGRAM_TARGET:-}" ] && command -v openclaw >/dev/null 2>&1; then
  openclaw message send --channel telegram --target "$ALERT_TELEGRAM_TARGET" -m "$MSG" && exit 0
fi
if [ -n "${ALERT_MAIL:-}" ] && command -v mail >/dev/null 2>&1; then
  printf '%s\n' "$MSG" | mail -s "althingi alert" "$ALERT_MAIL" && exit 0
fi
echo "$MSG" >&2   # last resort: stderr ends up in the launchd log
exit 1

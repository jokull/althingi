#!/usr/bin/env bash
# Every 15 min (launchd). Alerts via ops/alert.sh, at most once per 6 h per problem kind.
#   crawler: pending speeches exist but nothing was fetched for 25 min  -> stalled/blocked/dead
#   web:     /healthz not OK
#   disk:    < 8 GB free
set -uo pipefail
export PATH=$HOME/.bun/bin:/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:$PATH
DIR=$(cd "$(dirname "$0")" && pwd)
set -a; . "$HOME/althingi/.env"; set +a
STATE=$HOME/althingi/watchdog; mkdir -p "$STATE"
now=$(date +%s)
alert() {  # kind, message
  local f="$STATE/$1"; local last=0; [ -f "$f" ] && last=$(cat "$f")
  if [ $((now - last)) -ge 21600 ]; then "$DIR/alert.sh" "$2" && echo "$now" > "$f"; fi
}
clear() { rm -f "$STATE/$1"; }

q() { psql "$DATABASE_URL" -Atc "$1" 2>/dev/null; }
pending=$(q "select count(*) from speeches where text_state='pending'" || echo "")
age=$(q "select coalesce(extract(epoch from now() - (select max(fetched_at) from raw_fetch))::int, 999999)" || echo "")
if [ -z "$pending" ]; then alert db "database unreachable from the watchdog"
elif [ "$pending" -gt 0 ] && [ -n "$age" ] && [ "$age" -gt 1500 ]; then
  alert crawler "crawler stalled: $pending speeches pending, last fetch $((age/60)) min ago. tail: $(tail -c 300 "$HOME/althingi/logs/chain157.log" | tr '\n' ' ')"
else clear crawler; fi

# layered ingest (ops/ingest.sh): a blocked/rate-limited run, or the crawler paused after one
blocked=$(q "select count(*) from ingest_runs where status in ('blocked','rate-limited') and started > now() - interval '24 hours'" || echo 0)
paused=$(q "select value #>> '{}' from ingest_state where key = 'crawl_paused_until' and (value #>> '{}')::timestamptz > now()" || echo "")
if [ "${blocked:-0}" -gt 0 ] || [ -n "$paused" ]; then alert ingest "ingest blocked/rate-limited in the last 24 h; crawler paused until ${paused:-?}"; else clear ingest; fi

code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' http://127.0.0.1:3050/healthz || echo 000)
if [ "$code" != "200" ]; then alert web "web /healthz returned $code"; else clear web; fi

free_gb=$(df -g "$HOME" | awk 'NR==2{print $4}')
if [ "${free_gb:-99}" -lt 8 ]; then alert disk "disk low: ${free_gb} GB free"; else clear disk; fi

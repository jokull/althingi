#!/usr/bin/env bash
# Monthly: restore the newest dump into a scratch database, run smoke queries, drop it. Alerts on failure.
set -euo pipefail
export PATH=/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:$PATH
DIR=$(cd "$(dirname "$0")" && pwd)
[ -f "$HOME/althingi/.env" ] && { set -a; . "$HOME/althingi/.env"; set +a; }
trap '"$DIR/alert.sh" "restore test FAILED"; psql -d postgres -qc "drop database if exists althingi_restore" || true' ERR
F=$(ls -1t "$HOME"/althingi/backups/althingi-*.dump | head -n1)
psql -d postgres -qc "drop database if exists althingi_restore" -c "create database althingi_restore"
pg_restore --no-owner -d althingi_restore "$F"
q() { psql -d althingi_restore -Atc "$1"; }
[ "$(q 'select count(*) from speeches')" -gt 0 ]
[ "$(q "select count(*) from paragraphs")" -gt 0 ]
[ "$(q "select count(*) from paragraphs where search_vector @@ to_tsquery('simple','forseti')")" -gt 0 ]
[ "$(q 'select count(*) from members')" -gt 0 ]
[ "$(q 'select count(*) from schema_migrations')" -ge 3 ]
psql -d postgres -qc "drop database althingi_restore"
echo "ok restore of $(basename "$F")"

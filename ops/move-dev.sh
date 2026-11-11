#!/usr/bin/env bash
# Move Phase 0 state from the laptop's dev Postgres (docker althingi-dev-pg) to the mac-mini. Run ON THE LAPTOP.
# Moves the DB (pg_dump -Fc -> pg_restore into the mini's EMPTY `althingi` database) and rsyncs the raw XML,
# so nothing is ever fetched twice. Refuses to touch a non-empty target. Home paths are identical on both machines
# (/Users/jokull), so raw_fetch.path stays valid.
set -euo pipefail
SRC_DB=${SRC_DB:-althingi_phase0}
RAW=$HOME/althingi/raw
DUMP=/tmp/althingi-move.dump
# every remote step: env + psql on PATH, no local expansion (quoted heredoc)
rsh() { ssh mac-mini "bash -s"; }   # usage: rsh <<'X' ... X   (script body from stdin)
PRE='export PATH=/opt/homebrew/opt/postgresql@17/bin:$PATH; set -a; . ~/althingi/.env; set +a;'

echo "== target must be empty"
n=$(rsh <<REMOTE
$PRE
psql "\$DATABASE_URL" -Atc "select count(*) from information_schema.tables where table_schema = 'public'"
REMOTE
)
echo "tables in target: $n"; [ "$n" = "0" ]

echo "== dump (consistent snapshot, does not block the crawler)"
docker exec althingi-dev-pg pg_dump -U postgres -Fc --no-owner "$SRC_DB" > "$DUMP"
ls -lh "$DUMP"
scp -q "$DUMP" mac-mini:/tmp/althingi-move.dump

echo "== restore as althingi_rw"
rsh <<REMOTE
$PRE
pg_restore --no-owner --exit-on-error -d "\$DATABASE_URL" /tmp/althingi-move.dump && echo restored
REMOTE

echo "== raw XML"
rsync -a --stats "$RAW/" mac-mini:althingi/raw/ | grep -E "Number of (regular )?files|Total file size"

echo "== verify"
Q="select (select count(*) from speeches) speeches, (select count(*) from speeches where text_state='done') done, (select count(*) from paragraphs) paragraphs, (select count(*) from paragraph_tokens) tokens, (select count(*) from raw_fetch) fetches"
echo "laptop: $(docker exec althingi-dev-pg psql -U postgres -d "$SRC_DB" -Atc "$Q")"
echo "mini  : $(rsh <<REMOTE
$PRE
psql "\$DATABASE_URL" -Atc "$Q"
REMOTE
)"
echo "raw files on mini: $(ssh mac-mini 'find ~/althingi/raw -type f | wc -l')  laptop: $(find "$RAW" -type f | wc -l)"

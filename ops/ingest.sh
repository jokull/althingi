#!/usr/bin/env bash
# launchd entry for the layered ingest (docs/INGEST.md §5). Run kinds:
#   poll       sitting-day poll (Mon–Fri 09:00–23:30, every 30 min): day speech list → texts → derive → post --quick
#   nightly    03:10: current-session lists, touched matters, new members' seats, derive, post (vocab MV)
#   weekly     Sun 02:00: non-terminal current-session matters, previous session's lists, per-member reconcile, laws, derive, post
#   dump-drop  manual, after a person downloaded + unpacked xmlfiles.zip:  ops/ingest.sh dump-drop ~/althingi/xml-dump/<date>
# One run per kind at a time (lockf on ~/althingi/run/<kind>.lock); network steps additionally share the crawl advisory lock
# in Postgres, so a poll never overlaps the nightly run or the backfill. Exit 4/5 (403/429) → Telegram alert via alert.sh;
# the step itself has set crawl_paused_until (+24 h), so no network run starts until a human looks.
set -uo pipefail
export PATH=$HOME/.bun/bin:/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:$PATH
DIR=$(cd "$(dirname "$0")/.." && pwd)
kind=${1:?usage: ingest.sh poll|nightly|weekly|dump-drop [PATH]}
set -a; . "$HOME/althingi/.env"; set +a
mkdir -p "$HOME/althingi/run" "$HOME/althingi/logs"
LOG=$HOME/althingi/logs/ingest-$kind.log
LOCK=$HOME/althingi/run/$kind.lock

if [ -z "${INGEST_LOCKED:-}" ]; then
  # re-exec under lockf: -t 0 = give up at once if the previous run of this kind is still going
  INGEST_LOCKED=1 exec /usr/bin/lockf -t 0 "$LOCK" "$0" "$@" >>"$LOG" 2>&1
fi

cd "$DIR"
echo "=== $(date '+%F %T') $kind"
step() {  # run one ingest step; stop the run (and alert on a block) when it fails
  bun scripts/ingest.ts "$@"
  local rc=$?
  if [ $rc -eq 4 ] || [ $rc -eq 5 ]; then "$DIR/ops/alert.sh" "althingi ingest $kind: blocked/rate-limited (exit $rc) at '$*' — crawler paused 24 h"; exit $rc; fi
  if [ $rc -eq 6 ]; then echo "crawler paused; skipping the rest of $kind"; exit 0; fi
  if [ $rc -eq 3 ]; then echo "lock held (another run or the backfill); skipping '$*'"; return 0; fi
  if [ $rc -ne 0 ]; then "$DIR/ops/alert.sh" "althingi ingest $kind failed (exit $rc) at '$*'"; exit $rc; fi
}

case "$kind" in
  poll)
    dow=$(date +%u)   # 1 = Monday
    [ "$dow" -le 5 ] || { echo "weekend: no poll"; exit 0; }
    step service poll
    step derive
    step post --quick    # speech_index for the current session + corpus_state (no vocab MV): docs/PERFORMANCE.md §3.3
    ;;
  nightly)
    step service lists
    step service matters --touched
    step service members
    step derive
    step post
    ;;
  weekly)
    cur=$(psql "$DATABASE_URL" -Atc "select max(lthing) from sessions")
    step service matters --weekly
    step service lists --from $((cur - 1)) --to $((cur - 1))
    step service index
    step laws
    step derive
    step post
    ;;
  dump-drop)
    drop=${2:?usage: ingest.sh dump-drop PATH}
    step dump drop --drop "$drop"
    ;;
  *) echo "unknown kind: $kind" >&2; exit 2 ;;
esac
echo "=== $(date '+%F %T') $kind done"

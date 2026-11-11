# Runbook (state as of 2026-11-10)

## Where things run
| What | Where | How |
|---|---|---|
| Postgres 17 (`althingi` db, roles `althingi_rw` / `althingi_ro`) | mac-mini, shares the Homebrew cluster with planitor | creds in `~/althingi/.env` (mode 600); created by `ops/mini-setup.sh` |
| Crawler (one at a time, 5 s, XML only) | mac-mini, tmux session `althingi-crawl` | chain: `seats` → `matters --lthing 157` → `text --lthing 157`; logs `~/althingi/logs/chain157.log` |
| Web + MCP (`/mcp`) | mac-mini, launchd `com.jokull.althingi-web`, **127.0.0.1:3050 only**, read-only DB role | `ops/deploy-web.sh` (rsync + launchctl); log `~/althingi/logs/web.log` |
| Raw XML (replayable) | `~/althingi/raw` on both machines | never refetched; `raw_fetch` table is the index |
| Dev corpus (680 speeches, 8–19 Jun 2026) | laptop, docker `althingi-dev-pg` :5433 db `althingi_phase0` | the evaluation set; judged by an independent reviewer (docs/EVAL-phase0.md) |

Nothing is exposed to the internet. Public exposure = Cloudflare tunnel + Access policy, a separate deliberate step.

## Everyday commands
```bash
bun test                                   # 90 tests incl. Postgres (TEST_PG, default laptop docker :5433)
DATABASE_URL=… bun scripts/eval.ts         # Phase 0 gate (--show prints hits, --dump FILE for judging)
DATABASE_URL=… bun scripts/reindex.ts      # after ANY change to indexing rules (bump INDEX_REV in src/lemma.ts) or lemma-is
DATABASE_URL=… bun scripts/crawl.ts status # queue, ETA
./ops/deploy-web.sh                        # ship code to the mini and restart the web service
ssh -f -N -L 3051:localhost:3050 mac-mini  # look at the mini's site from the laptop
```

## Rules that must not be broken
- One crawler at a time, ever (the 5 s budget is global to the IP). `crawl.ts` takes a Postgres advisory lock; the laptop and the mini have *different* databases, so the lock does not protect across machines — only run the crawler on the mini.
- Crawl XML endpoints only. `src/fetcher.ts` refuses everything else (HTML/sgml/pdf sit behind a bot challenge; not circumvented). 403/HTML body = stop.
- Migrations that rewrite `paragraphs` (0002, 0005) need no crawler running; then `scripts/reindex.ts`.
- Pages of a session still being ingested must stay on short TTLs (`sessionState` in `src/queries.ts`); only complete sessions are immutable.
- Party is always a seat on the date (`partyAt` / `partiesFor`), never by session; seat kind `með varamann` = on leave.

## Backups (scripts ready, not yet scheduled)
`ops/backup.sh` (nightly pg_dump), `ops/restore-test.sh` (monthly), `ops/alert.sh` (Telegram via openclaw; needs `ALERT_TELEGRAM_TARGET` in `~/althingi/.env`).

## Public edge (live since 2026-11-11)

- `https://althingi.solberg.is` → named tunnel `9f7a5ed9…` on the mini (also serves lemma.solberg.is), ingress in
  `~/.cloudflared/config.yml` → `http://localhost:3050`. The tunnel runs from `~/Library/LaunchAgents/com.jokull.cloudflared-tunnel.plist`
  (`cloudflared tunnel run 9f7a5ed9…`). Do NOT use `brew services restart cloudflared`: brew's plist starts cloudflared
  without arguments and the tunnel goes down (happened once, ~1 min outage of both hosts).
- Zone solberg.is, cache rule (phase http_request_cache_settings): host althingi.solberg.is, not /mcp, not /healthz →
  cache eligible, edge + browser TTL respect origin (our `s-maxage` rules in src/web.tsx decide).
- Rate limit (phase http_ratelimit): /leit* and /mcp*, 40 req / 10 s per IP+colo, block 10 s.
- Rollback: remove the althingi ingress line and restart via `launchctl kickstart -k gui/$(id -u)/com.jokull.cloudflared-tunnel`; delete the CNAME.

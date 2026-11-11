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
- Agent surfaces (2026-11-11, docs/AGENTS.md), deploy notes:
  - `/mcp` stays excluded from the cache rule (GET in a browser = connect page, `no-store`). The rule's exclusion must be
    the exact path `/mcp`, NOT a `/mcp*` prefix, so `/mcp/server-card` (1 h `max-age`) and `/mcp.md` are cache-eligible; if it is a prefix, that is harmless (they are just uncached).
  - Rate-limit rule: add `http.request.method ne "OPTIONS"` so CORS preflights from browser clients do not eat the budget.
    The app limits `/mcp` POSTs to 60/min per `cf-connecting-ip` with 429 + Retry-After.
  - New cache-eligible paths (origin sets TTLs): `*.md`, `/llms.txt`, `/llms-full.txt`, `/sitemap.xml`, `/sitemaps/*`,
    `/openapi.json`, `/.well-known/ai-catalog.json`. Purge `/llms.txt` and `/sitemap.xml` after a session is added.
  - The edge does not key on `Accept`: HTML URLs answer `Accept: text/markdown` with a 302 to `.md` (no inline negotiation),
    so no cache-key change is needed. Leave Cloudflare "Markdown for Agents" off (we serve our own Markdown).
  - Do NOT add any `/.well-known/oauth-*` route or a WAF challenge on `/mcp`: a 401/403 makes Claude/ChatGPT start OAuth.
  - Registry publish (not done): serve `/.well-known/mcp-registry-auth` (Ed25519 pubkey), then `mcp-publisher login http --domain althingi.solberg.is` + `publish` with `server.json`. The registry fetches from its cloud: no bot challenge on that path.
- Rollback: remove the althingi ingress line and restart via `launchctl kickstart -k gui/$(id -u)/com.jokull.cloudflared-tunnel`; delete the CNAME.

## Layered ingest (docs/INGEST.md; code in scripts/ingest.ts, src/{dump-ingest,derive,service,laws-ingest}.ts)

| Step | Network | Lock | Command |
|---|---|---|---|
| Dump drop (manual, ≈ monthly) | 0 | `dump` | `ops/ingest.sh dump-drop ~/althingi/xml-dump/<date>` (= `ingest.ts dump drop --drop PATH`: hash → speeches → misc → sittings → derive → post) |
| Derive | 0 | `derive` | `bun scripts/ingest.ts derive [--replay-raw]` (`--replay-raw` re-reads cached matter details / speech lists for member ids, 0 requests) |
| Laws | 0 with `--zip`, else 1 conditional GET | `laws` | `bun scripts/ingest.ts laws [--zip PATH]` |
| Service | XML, 5 s | `crawl` | `bun scripts/ingest.ts service lists\|members\|matters [--weekly\|--touched]\|texts [--provisional]\|poll\|index\|days` |
| Status | 0 | — | `bun scripts/ingest.ts status` |

- Dump, derive and laws never take the crawl lock: they may run while the crawler runs. Every run writes an `ingest_runs` row.
- Re-running any dump step over an unchanged drop writes nothing (per-file sha in `dump_files`; equal speech sha = no-op).
  `PARSER_REV` in `src/dump-ingest.ts` forces a reparse of one directory type without a new drop.
- A 403/429 exits 4/5, sets `ingest_state.crawl_paused_until` (+24 h), and `ops/ingest.sh` alerts. Network steps refuse
  (exit 6) while paused. To resume after looking: `psql "$DATABASE_URL" -c "delete from ingest_state where key like 'crawl_paused%'"`.
- `ALTHINGI_OFFLINE=1` makes the fetcher refuse every request (use on the laptop).
- Schedules (templates in `ops/`, not installed by deploy): `com.jokull.althingi-ingest-poll` (Mon–Fri 09:00–23:30 every
  30 min), `-nightly` (03:10), `-weekly` (Sun 02:00). Logs: `~/althingi/logs/ingest-<kind>.log`. Install only after the
  backfill chain has finished (service steps skip with "lock held" while it runs, so early install is harmless but noisy):
  `cp ops/com.jokull.althingi-ingest-*.plist ~/Library/LaunchAgents/ && for k in poll nightly weekly; do launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jokull.althingi-ingest-$k.plist; done`
- `/healthz` reports `last_poll_at`, `last_dump_drop`, `unresolved_speakers`, `pending_texts`, `blocked_runs_24h`.
- Session pages become immutable only when no text is pending AND ≥ 95 % of the session's A-mál have matter detail.

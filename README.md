# althingi-search

Lemma-aware search over Alþingi speeches (matters, votes, members as filters), served as a fast
server-rendered site and a remote MCP. Postgres + Bun, runs on the mac-mini. See `docs/STRUCTURE.md` for the
data model and `docs/` for decisions.

```bash
bun test                                   # parser, lemma and fetcher tests (db tests need Postgres at TEST_PG)
export DATABASE_URL=postgres://…/althingi
bun scripts/crawl.ts reference --from 157 --to 157
bun scripts/crawl.ts index     --from 157 --to 157
bun scripts/crawl.ts text      --from-date 2026-10-26 --to-date 2026-11-06
bun scripts/crawl.ts status
```

Crawler rules (robots.txt + llms.txt of althingi.is): XML service only, 5 s between requests, identifying
User-Agent, each document fetched once, stop on 403/429. HTML under `/altext/` is unreachable by construction
(`src/fetcher.ts` allowlist).

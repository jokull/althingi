# Performance model and strategy (2026-11-11)

Measured on the mini (Postgres 17.8, 10 cores, 16 GB, `shared_buffers` 128 MB — not ours to change; the OS page cache
does the real caching) with the real data: 254,928 speeches with text (sessions 131–158), 1,011,984 `paragraphs`
rows (4.7 GB: 1.6 GB heap + 2.4 GB TOAST + 0.6 GB GIN), 2.5 GB `paragraph_tokens`, 297 MB `speeches`. Disk 94 % full,
28 GB free. Every number below is `EXPLAIN (ANALYZE, BUFFERS)` or `\timing` on that database, run serially while the
matter-detail crawler was writing. `scripts/bench.ts` replays the fixed query set (§6) and prints p50/p95/max.

## 1. Where the time goes

| Path | Cost driver (measured) |
|---|---|
| Search ranking | GIN candidate ids for `veiðigjald` (7,190 paragraphs): **8 ms**. Ranking those paragraphs (`ts_rank_cd`, which detoasts each `search_vector`, avg 1.2 KB): **~100 ms** = ~15 µs/paragraph. The per-paragraph joins to `speeches` (pkey, 7,190 loops) + `matters` for the title boost + window functions: another **~400 ms** (46k buffer hits). Cold cache: 868 ms. |
| Search with a date range | `speeches.speech_date` is only reachable through the join, so all 7,190 candidates were joined and then 5,890 thrown away. The id **is** the date (`rad20170101T…`), and `paragraphs.speech_id` correlation is −0.9998: a pkey range `speech_id >= 'rad20170101' and < 'rad20200101'` makes the planner `BitmapAnd` GIN ∧ pkey — **18 ms**, 1,300 candidates, zero schema. |
| Totals (`count(distinct speech_id) … limit 10001`) | Fine for rare words (46 ms). For `forseti` (370k paragraphs, 37 % of the corpus) the LIMIT makes the planner pick an ordered pkey index scan with `@@` as a *filter*: that detoasts every tsvector it passes — **1.2 s**; the same filter on a seq scan is **8–13 s** (whole TOAST, 2.4 GB). This is the plan behind the `/leit?q=forseti` 500 (statement timeout) seen live. Rule: `search_vector @@ q` may only ever be an index condition, never a heap filter. |
| Aggregates (`aggregate` MCP tool) | `group_by=member q=sjávarútvegur`: hash join of 13,754 matching speech ids against a **seq scan of `speeches`** (25k pages, 197 MB): 1.58 s cold, 0.69 s warm. `words by party` (no q): seq scan + a lateral seats lookup per speech (memoized): 0.66 s. `random_page_cost=1.1` only moves it to 13,754 pkey loops (0.85 s): the table is simply too wide to touch per request. |
| Corpus/session state | `corpusStats`, `sessionState`, `corpusBlock`, `corpusFacts` all aggregate the whole `speeches` table (87 ms warm, 2 s+ under load). `corpusBlock` runs on **every** MCP response (twice on some tools); `corpusStats` on `/`, `/healthz`, `/leit`; `sessionState` once a minute per process. These caused the 500s on `/healthz` and the statement timeouts in web.log (2026-11-11 20:22). |
| first_use | earliest 5: 43 ms (bitmap + top-N sort, 7,190 pkey loops); per-year strip: 46 ms (same join again). |
| Entity search | member counts `count(*) from speeches where member_id = … and text_state = 'done'` per candidate (8 members: 29 ms); party speeches via a seats-exists over all its members' speeches: **124 ms** for Sjálfstæðisflokkur. Runs on every `/leit` and `/leit/forslag`. |
| Matter / member / day pages | 1–60 ms, all pkey/btree lookups. Fine. |
| Sitemaps | `/sitemaps/157.xml` 15 ms in SQL, 0.75 s live (45k URLs of XML generation + transfer); immutable at the edge for complete sessions. Fine. |
| Snippets | tokens join for ≤ 20 output rows: ≤ 1 ms. In-process snippet building negligible. |
| `suggest.ts` | `select 1 … @@ … limit 1` (the deployed revision) hits the filter-on-heap trap above; already replaced by `count(*)` in this tree. |

| **Cold cache** | The decisive measurement. `shared_buffers` is 128 MB and the OS page cache is churned by the other tenants (OrbStack VM, planitor, Plex): the identical candidate scan for `verðbólga` (11,959 paragraphs on 8,791 heap pages of the 1.6 GB `paragraphs` heap) took **4.0 s cold and 18 ms warm**, back to back. Every heap page a GIN bitmap scan has to visit is a random disk read at 100–450 µs. The old search read ~14k pages per query. |

Model: **a request costs (GIN probe ≈ free) + (heap pages visited for candidates × 100–450 µs when cold) + (ranked
candidates × 15 µs warm, ~1 page each cold) + (per-candidate joins to wide tables) + (any whole-table pass over
`speeches`)**. The design makes the candidate heap tiny enough to stay in shared_buffers, removes the joins and the
whole-table passes, and bounds the ranked set.

## 2. Targets

Server time (SQL + render), warm cache, measured by `scripts/bench.ts` on the mini:

- web pages and entity/browse search: **p50 < 20 ms, p95 < 100 ms**
- keyword search (`/leit`, `search_speeches`): **p50 < 60 ms, p95 < 200 ms** (ranking ≤ 5,000 paragraphs at 15 µs is the floor: ~75 ms worst case before the cap; below that needs a leaner ranking vector = a reindex, out of scope)
- aggregates, totals, first_use, corpus/session state: **p50 < 30 ms, p95 < 150 ms**
- nothing over **500 ms**, ever, for a single request; no request may scan `speeches` or `paragraphs` whole.

## 3. One strategy

### 3.1 Physical design

Two **narrow tables whose GIN indexes are built over functions**, so the vectors are stored nowhere but `paragraphs`
and the heap a bitmap scan has to visit is a few tens of MB (sql/0008):

```
paragraph_index(speech_id, seq)                       -- 50 MB heap; GIN over para_vec(speech_id, seq) = 157 MB
speech_index(id pk, lthing, speech_date, started, year, member_id, member_name, party_id /* seat on the date */,
             type, debate, substantive bool, word_count, matter_cls, matter_nr, title_vec, built_at)
                                                      -- 40 MB heap; GIN over speech_vec(id) = 140 MB; btrees 50 MB
```

`para_vec` returns the paragraph's stored `search_vector`; `speech_vec` the stripped union of a speech's lemmas
(2.4 KB / 225 lexemes per speech on average). Both are `IMMUTABLE` SQL functions reading `public.paragraphs`: Postgres
evaluates them when a row is inserted or updated, and otherwise only on a lossy-bitmap recheck, which needs a TID
bitmap larger than `work_mem` (1M TIDs ≈ 6 MB against 32 MB) — never in practice. Rows are deleted and re-inserted on
refresh, so the indexes follow a reindex. Why not a stored vector column: TOAST only moves a value out of line when the
whole row exceeds 2 KB (`toast_tuple_target` cannot lower that trigger), so the first build with an inline `vec`
column measured 9 rows per page — 217 MB of heap for 255k rows, five times the facts.

Measured on the narrow tables (cold → warm): `verðbólga` candidates 8 ms → 2 ms (was 4.0 s → 18 ms);
`veiðigjald` 2017–2019 8.8 ms; aggregate by member for `sjávarútvegur` 17 ms (was 690–1580 ms); `forseti` by year
24 ms (was 1.6 s). Total added ≈ 520 MB of the 8 GB budget; `paragraphs_fts` (310 MB) can be dropped once nothing
deployed reads it (follow-up).

`paragraph_index` serves candidate sets and totals. `speech_index` serves aggregates (any `group_by` is a column,
party included), first_use's earliest and per-year strip, entity counts per member/party (index-only), browse mode,
every boost in search ranking, and the member/party pages. For multi-word AND queries the speech-level vector
over-includes (words in different paragraphs): aggregates and first_use add an `exists` recheck on `paragraphs`
for those candidates, so counts stay "same paragraph" exact.

No column is added to `paragraphs`: an `UPDATE` over 1M rows would leave 1.6 GB of dead heap on a 94 %-full disk and
re-insert every GIN posting. The id-as-date pkey range (§1) gives date/session filters for free on both tables.

**`corpus_state`** — one row: speeches with text, date range, last ingest, per-session `{done, pending, unavailable,
complete}` and a `version` that changes on every refresh. Written by `corpus_state_refresh()` from the ingest `post`
step (after every poll, nightly, weekly, dump drop). The request path reads one row; `version` keys the in-process caches.

**Planner guard.** Both pools connect with `enable_seqscan = off` and `jit = off` (src/server.ts). A seq scan with
`tsvector @@ q` as its filter detoasts every row — 1.6 s on the old `speech_index`, 8–13 s on `paragraphs` — and the
planner chooses it for near-stopword lexemes (`forseti` is in 37 % of paragraphs); with it off the GIN is always used
(`forseti` by year: 70 ms on the old table, 24 ms on the new). No index-less table of ours is big enough for the
penalty to matter (`words by party` with no query: 175 ms via the party index vs 63 ms seq scan, and it is memoized).
`statement_timeout = 2s` and `work_mem = 32MB` stay on the role; `work_mem ≥ 16 MB` is what keeps the function-backed
bitmaps exact. `random_page_cost = 1.1` was measured and rejected: it turned the aggregate's seq scan into 13,754 pkey
loops (0.85 s), the real fix was the table.

### 3.2 Query shapes

**Search** (`src/search.ts`), one SQL statement:

1. `cand`: `materialized` CTE of `(speech_id, seq)` from `paragraph_index` (recall words) — ids only, no detoast —
   ANDed with the pkey range derived from `dateFrom/dateTo/lthing` and, when member/party/type/office/debate/capacity
   filters are set, with `speech_id in (select id from speech_index where …)`. Phrase and number-proximity conditions
   recheck `paragraphs.seq_vector` for those candidates only; a phrase-only query uses the sequence GIN on
   `paragraphs` directly. Materializing the CTE keeps the planner from ever evaluating `@@` as a heap filter.
2. **Candidate cap**: before the query, the lemmas' document counts (`vocab.ndoc`, cached in-process) estimate the
   candidate set; when it exceeds `RANK_CAP` (5,000 paragraphs) the range is narrowed to the newest sessions that fit
   (from `corpus_state`'s per-session paragraph counts), and the result says so (`rankedFrom` / `ranked_within`).
   Ranking among old mentions of a very common word is lost on page 1 — that is the trade; filters (date, member)
   restore it. Near-stopwords (`forseti`, in 37 % of paragraphs) thus rank within the current session only.
3. `scored`: join `cand` back to `paragraphs` by pkey (detoast only what is ranked) and to `speech_index` for every
   boost (type, debate, recency, title match via `title_vec`): no `speeches`, no `matters` join.
4. Window functions over ≤ RANK_CAP rows: best 2 paragraphs per speech, keyset page of 11 speeches; tokens for ≤ 20 rows.
5. `total` = `count(distinct speech_id)` over `cand` in the same statement (exact within the ranked window; capped at
   10,000 as before).

Browse (filters only) runs on `speech_index` with `order by started desc` and keyset paging.

**Aggregates** (`src/aggregate.ts`): one `group by` over `speech_index` with `vec @@ q` and the filters; party and
member names come from the row. **first_use**: earliest speeches from `speech_index`, then the first matching paragraph
of each; the per-year strip from `speech_index`. **Entity search**: member/party counts from `speech_index` indexes.

### 3.3 Precomputation and freshness

- `speech_index` rows are written inside `saveSpeechText`'s transaction (`speech_index_refresh(ids)`): a speech is
  searchable in both layers in the same commit. `post --quick` (every poll) re-derives the current session's rows
  (party/office/member fixes from `derive`, ~2.5k rows, < 2 s) and any speech whose `speeches.fetched_at` is newer than
  its `built_at`; closed sessions are built once by `scripts/backfill-index.ts` (serial, one session per transaction).
- `corpus_state_refresh()` runs at the end of every `post`. Freshness ≤ one poll (30 min) for counts; the
  `complete` flags only change in `post` anyway. The **current session is never `complete`**: a running session must
  not be cached as immutable even when nothing is pending at that moment.
- `vocab` (MV) stays nightly; `ndoc` is only an estimate for the cap.

### 3.4 Caching layers

- Cloudflare: unchanged (`s-maxage` from the origin; complete sessions immutable; `/leit*` 60 s; `/mcp` no-store).
- In-process: `corpus_state` is read every 30 s **off the request path** (timer, stale on error) and backs
  `corpusStats`, `sessionState`, `corpusBlock`, `corpusFacts`, `/healthz`. An LRU (500 entries) keyed by
  `(kind, params, corpus_state.version)` holds search pages, aggregates and first_use results: identical agent calls
  (the log shows them repeated within seconds) cost nothing, and a version bump on ingest invalidates everything at once.
- HTTP validators: strong ETags already; unchanged.

### 3.5 Connections

Web pool 8 (2 s timeout), MCP pool 6 (8 s) — unchanged; 10 cores. With no whole-table passes left, concurrency stops
mattering: the 2 s timeout is a safety net, not a budget.

### 3.6 What it costs

| Item | Disk | Write amplification | Staleness |
|---|---|---|---|
| `paragraph_index` + `speech_index` | 276 MB + 240 MB (heaps 50 + 40 MB; GINs 157 + 140 MB; btrees) | one row per paragraph and per speech (+ GIN postings) per ingested speech, in the same transaction; `speech_vec` re-aggregates the speech once | none for new text; party/member fixes ≤ 1 poll |
| `corpus_state` | 1 row | one statement per `post` | ≤ 30 min on sitting days (counts only) |
| In-process LRU | ≤ 500 results in RAM | — | until the next `post` (version bump) |
| Candidate cap | — | — | semantic: common words rank within recent sessions unless filtered |

## 4. Migration mechanics

`migrate()` runs each `sql/*.sql` in one transaction. A file whose first line is `-- migrate: no-transaction` is split
into statements (`splitStatements`, quote/dollar-quote/comment aware) and run outside a transaction (`create index
concurrently` needs that); its `schema_migrations` row is written after the last statement, so a failed file re-runs
(every statement in it is idempotent: `if not exists`, `create or replace`). Functions used in index expressions
schema-qualify their tables: index expressions are evaluated with a bare `search_path`.

Deploy order for 0008 on a populated database: the migration creates empty tables and their indexes in seconds; then
`bun scripts/ingest.ts backfill-index` fills them (45 s for 255k speeches / 1M paragraphs, ids only, 500 per
statement), during which the function-backed GINs grow incrementally. On the mini the GINs were instead dropped before
the backfill and rebuilt `concurrently` afterwards (3 min, `maintenance_work_mem = 512MB` for the session), which is
faster; both end in the same state. `ops/ingest.sh poll` now ends with `post --quick`.

## 5. Bench (scripts/bench.ts)

Replays, serially, 3 rounds each: web search shapes (`/leit` queries from the golden set, date-filtered, newest-first,
phrase, browse), the agent's `veiðigjald` 2017–2019 and 2020–2024 searches, `search_speeches` limit 50 with a 2005–2026
range, `aggregate` member/`sjávarútvegur`, words by party, by year with q, `first_use`, entity search, matter/member/day
pages, corpus/session state. Prints per-query p50/p95/max and the overall distribution. Run against the mini:
`DATABASE_URL_RO=… bun scripts/bench.ts`.

The bench sets `ALTHINGI_CACHE=0` so it measures the queries, not the LRU (with the LRU on, every repeated query is 0 ms).

### Before (deployed main, 2026-11-11 20:40, after a warm-up round, crawler writing)

```
query                                                   p50    p95    max
web search veiðigjald                                   332    351    351
web search sjávarútvegur                               1314   1323   1323
web search verðbólga                                    998   1288   1288
web search húsnæðislán vextir                           179    181    181
web search loftslagsmál                                 445    723    723
web search Landspítali biðlistar                        165    174    174
web search phrase "hér á landi"                       12646  12906  12906
web search fjárlög 2026                                 161    172    172
web search forseti (near-stopword)                     8158   8166   8166   timeout
web search hælisleitendur newest                        309    367    367
web search veiðigjald 2017-2019 (agent)                3103   3166   3166
web search veiðigjald 2020-2024 (agent)                4136   5552   5552
web search veiðigjald party 35                          199    204    204
web search veiðigjald member 690                         42     53     53
web browse member 690                                   202    271    271
web search page 2 veiðigjald                            343    494    494
mcp search_speeches veiðigjald 2005-2026 limit 50      8705   8797   8797   timeout
mcp search_speeches veiðigjöld sjávarútvegur limit 50    422    493    493
mcp aggregate member sjávarútvegur                      863    924    924
mcp aggregate words party                               713    721    721
mcp aggregate words party kvóti                         394    426    426
mcp aggregate words year veiðigjald                     202    209    209
mcp aggregate speeches year                             118    119    119
mcp aggregate speeches party veiðigjald 2005-2026       170    170    170
mcp first_use veiðigjald                                163    166    166
mcp first_use kvótakerfi                                115    115    115
mcp get_matter 157/A/300                                 92     93     93
mcp get_member 690                                       98    100    100
mcp get_speech                                          115    120    120
mcp list_sessions                                       121    123    123
entities katrín                                          50     52     52
entities sjálfstæðisflokkur                             144    145    145
entities veiðigjald                                      27     30     30
page matter 157/a/300                                     3      4      4
page member 690                                          12     14     14
page day 2024-03-05                                       2      2      2
page speech                                               2      2      2
state corpusStats                                        30     30     30
state sessionState                                       42     48     48
state corpusBlock                                        80     84     84
ALL                                                     167   8560  12906  errors=8 (8 s statement timeouts)
```

### After (this branch, same bench, same conditions)

(see the final table below)

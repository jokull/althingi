# althingi-search — decisions and build plan (2026-11-10)

Design lead's calls. Every item is decided; "revisit when …" names the only trigger that reopens it. Evidence: repo + fixtures, dev DB (session 157: 11,974 index rows, 952 texts), lemma-is source, read-only look at the mac-mini and the `cf` CLI. **UNVERIFIED** = stated from docs/memory, confirm in the named package.

## Corrections to earlier docs (newer evidence wins)

- Design doc §2/§8: web port **3004 is taken** on the mini (OrbStack `media-olivertumi-1`; 3000–3004, 3010, 3080, 8000, 5432 in use). Use **3050**.
- Design doc §1 "planitor on Render?": **planitor's production DB is the mini's Homebrew Postgres 17** (`planitor` 372 MB, `planitor_test`, also `orflaedi`); spiders run via launchd → `docker compose exec`, app at `:8000`. althingi **shares the cluster** as database `althingi` (ops/mini-setup.sh). `shared_preload_libraries` is empty; `pg_textsearch`/`pgvector` absent; `pg_trgm 1.6` + `pg_stat_statements` available.
- Design doc §9 "Phase 0 = 6k speeches, 8 h": 157 is **11,974 speeches ≈ 17 h**. Phase 0 exits on the 952 texts now in the DB plus projections; "157 complete" is a Phase 1 package.
- STRUCTURE §3 debate codes: add **`T`** (60 speeches in 157). STRUCTURE §4 root attributes: add **`nefnd`** (46/278 texts: `fl`, `am`, `ev`, `forsn`); parse.ts drops it today.
- STRUCTURE §5 matter detail "≈28k": **A-mál only** (`bmal/` = title + speeches, already covered by stubs). 157 = 729 A-mál ≈ 1 h; 131–157 ≈ 20–24k requests ≈ 1.3 days. Matter detail also carries **vote summaries with counts**, documents, `efnisflokkar`+`lýsing`, `breytingaráLögum`, `tengdMál`, `umsagnabeiðnir`, `staðamáls` — one request buys all of it.
- Matter URLs carry the class, lowercase: `/mal/157/a/300`, `/mal/157/b/307` (IDEAS §2.1 wins over the design doc).
- Raw XML (952 files) and the DB live on the laptop only; `~/althingi` does not exist on the mini. Moving = rsync + `pg_dump`, never re-fetch.
- Two cloudflared processes exist (Homebrew `config.yml` → lemma:3003; token-run `…cloudflared.claw`). Neither is edited (see §6).

## Persona-driven revisions (ADOPTED 2026-11-10 — docs/PERSONAS.md, test/golden/personas.json)

Ten personas x ten tasks scored the plan: 27 served, 46 partial, 27 gap; the weight-3 professionals (reporter, party-group assistant) were served worst (2/10). These deltas are part of the plan; WP numbers refer to the table below.

1. **WP8**: crawl **157 ballots** (electronic votes, ~1.5k req ≈ 2 h) right after the votes list and *before* the remaining 157 texts; `/atkvaedagreidsla/<id>` grid ships in WP5; WP11 then covers 156→131 only.
2. **WP8 cadence**: sitting-day poll of `raedulisti?dagur=today` every 30 min (≈ 20 req/day, still 5 s spacing) + the nightly pass. Freshness bar: speeches visible ≤ 60 min after publication.
3. **WP5**: Atom feeds (search, matter, member, global), `/leit.csv|.json` (≤ 500 rows), cite string + "afrita" + text-only OG card + `?q=` highlight, `/efni/<id>`, `/nefnd/<abbr>`, `/kjordaemi/<id>`, `/um/ordskyringar` glossary, `/en` structural glossary; acceptance adds Lighthouse a11y ≥ 95, keyboard-only pass, vote grid readable without colour. Cite format: `Nafn (Flokkur), ræða 12.6.2026 kl. 14:19, 300. mál á 157. lþ., mgr. 4 — <url>#mgr-4`.
4. **WP3** (DONE in code): `party` (seats on the speech date, `með varamann` excluded), `office`, `debate`, `capacity` filters; matter-title cards for title-matching queries; numbers in a query filter on surface text instead of vanishing. Still open: `scripts/eval.ts` also prints served/partial/gap per persona from `personas.json` (reported, not gated).
5. **WP6**: add `get_vote`, `get_matter_timeline`, `list_documents`, `first_use`; `search_speeches` gets party/office/debate/capacity, `limit ≤ 100`, `total` (exact ≤ 10k else "10000+"); every response carries `corpus: {text_from: 2005, sessions, ingested_to}` and `derived`/`inferred` flags; zero hits carry a structured `why` (boundary, interjections_not_indexed, numbers).
6. **New WP8b** (after the soak, before WP10): þingskjöl text for the current session (~1.5k req ≈ 2 h), `documents.text/lemma_text/search_vector`, `/thingskjal` becomes a page; written answers searchable.
7. **WP8 sql/0003 matters**: `matter_sponsors` from the matter-detail request (no extra crawl).
8. **WP12**: first-use + year strip, `/ord/<l>?vs=`, speaking minutes by party/week, KWIC from `paragraph_tokens` offsets.
9. **WP13**: pre-2005 index counts also in the MCP (counts + link + boundary block).
10. **New Phase 2 WP**: weekly open dumps on R2 (`/gogn`: speeches, paragraph text, votes, ballots, seats, matters; lemma columns excluded because of BÍN) to drain bulk traffic off the MCP.
11. Kept out, now evidenced: morphology facets, compound browser, gender stats (no source), embeddings, pre-2005 text; topic lens stays Phase 3.

Persona-driven quality bars (§e of PERSONAS.md) are acceptance criteria for WP5/6: `/leit` p95 ≤ 120 ms; Atom/CSV ≤ 500 ms for 500 rows; MCP search ≤ 300 ms; lawyers' pages contain no inferred links; every first/total reads "frá 2005".

## Phase 0 outcome (2026-11-10) — what changed against this plan, and why

Evidence: `docs/EVAL-phase0.md` (five independent judgments of the same 20 golden queries, slice of 680 speeches), `test/golden/judged.json`.

**Gate result.** Routing 4/4, member routing, typo suggestion, auto-MRR 0.90, DB p95 ≤ 20 ms (measured 8–11 ms), property 99.98 % (≥ 99.9 %), size 7.6 GB at 250k (≤ 8 GB) all PASS. **P@5 = 10/13 = 0.77 (needs 0.80): NOT MET on this slice**, 0.91 on the queries the slice can answer. The judge showed the remaining misses (q07, q11, q13) are capped by the 8-day slice itself (e.g. only three substantive police paragraphs exist, so q13's ceiling is 3/5). **Decision: the P@5 gate is re-run on the full session 157 corpus (~12k speeches, crawl in progress) with the same golden set plus a refreshed query list, before Phase 1's public flip.** Not waived.

**Indexing rules that changed (index revision r3, `INDEX_REV` in `src/lemma.ts`; reindex is `scripts/reindex.ts`, no recrawl):**
1. Compound constituents are indexed in `paragraphs.lemma_parts` at tsvector weight **D** (0.3 in `ts_rank_cd`), whole-word lemmas at **A**. Evidence: `lýðræði → ræða`, `niðurstaða → staða` polluted precision. Confidence of the splitter does not separate good from junk splits, weighting does.
2. `lemma_seq` keeps **all tokens including stopwords**: quoted phrases are exact (`"ekki er allt sem sýnist"` → 0 hits when absent). Exact surface form gets a 1.5× boost over lemma-folded matches.
3. `lemma_text`/`lemma_parts` are **multisets** (one entry per occurrence): lemma-is returns a Set, which erased term frequency. Test asserts the lexeme set equals lemma-is's own, so recall is unchanged.
4. Query side: a dictionary-known compound is never split; an unknown compound searches `whole | (part1 & part2)` with one OR-group per part.
5. A number must be within **8 tokens** of a query word (sequence vector), not anywhere in the paragraph (4 was too tight: judge found a true hit at gap 5).
6. Ranking: `ts_rank_cd(weights, …, 1)` × speech-type × debate-stage × matter-title match × recency × a short-paragraph factor `least(1, ln(1+chars/6)/ln(44))`. **Tried and rejected: normalisation flag 0** (judged a net regression: fewer relevant hits, q02/q19 lost precision).

**Known open defects (ranked, from the judge):** (a) recursive compound splitting is missing (`lögreglustjóraembættin` yields one `lögregla` position instead of several); (b) term frequency can lift a repetitive non-relevant paragraph to rank 1 (cap per-lexeme positions, ~2–3); (c) candidate-lemma noise (`bankar → banka|banki`). All three are cheap to test once the full corpus gives a bigger judged set.

**Size.** The 11.8 GB figure seen mid-way was dead rows after the reindex rewrite; after `VACUUM FULL` it is 29 KB/speech → 7.6 GB at 250k (the original 8 GB bar holds; no gate was relaxed).

**Matter detail corrections to §4:** `umsagnabeiðnanúmer` is a consultation *round*, shared by all recipients (not a row id); consultations are keyed by (matter, round, recipient). `framsögumenn` are committee rapporteurs, not sponsors, so `matter_sponsors` is still open.

**Bugs found by tests/judging and fixed (regression tests exist):** CDATA text was dropped by the shared text helper (seat constituencies came back empty); session pages were cached as immutable while the session was still being ingested (rule now: immutable only for *complete* sessions, "current" = latest session with data); a deploy script could leave the web service unloaded (now waits for unload and fails unless `/healthz` answers).

## 1. Token stream (phrases, counts, trends, word pages)

**No row-per-token table.** Measured 114 words/paragraph, 355 words/speech → ≈ 4.3 M tokens for 157, ≈ 90 M for 250k speeches; a row per token keyed on 18-char ids is 8–12 GB. Instead, one `processText(text, {includeOffsets:true})` call per paragraph feeds two things:

```
paragraph_tokens(speech_id, seq, PK(speech_id,seq) → paragraphs,
  surface text[], lemma text[], pos text[] /*nullable entries*/, conf real[], start int[], len int2[],
  lemma_is_version text)                      -- ALL word tokens in order, stopwords + numbers kept
paragraphs.lemma_seq text                     -- best lemma per token, stopwords dropped, numbers kept, lowercase
paragraphs.seq_vector tsvector generated always as (to_tsvector('simple', lemma_seq)) stored
create index paragraphs_seq on paragraphs using gin (seq_vector);
```

- `lemma` = `disambiguated ?? lemmas[0]`; `pos` from `lemmatizeWithMorph(surface)` filtered to that lemma, null when absent; no case/gender column (facets are skipped per IDEAS; add later from the same call if ever needed).
- **Phrase/proximity**: quoted query → `seqLemmas(q)` (same function as index side) → `'a' <-> 'b'` / `<N>` tsquery against `seq_vector`, ANDed with the recall tsquery; 0 hits → `paragraphs.text ILIKE` fallback. Both sides drop stopwords identically, so `"hér á landi"` matches adjacency of `hér landi` — documented in the expanded-query chip.
- **Trends/word pages**: MVs `lemma_stats(lemma, year, party_id, member_id, is_substantive, n)` and `lemma_forms(lemma, surface_lc, n)` from `unnest` over `paragraph_tokens`, party via `seats` on the speech date; refreshed `CONCURRENTLY` nightly 03:10 (not per ingest).
- Cost: arrays ≈ 24 B/token → ≈ 2 GB raw (TOAST ≈ 1.2 GB) at 250k; seq GIN ≈ 0.9 GB; recall GIN ≈ 0.9 GB; paragraphs 14 KB/speech → 3.6 GB. **Total ≈ 7–8 GB**; 38 GB free. Revisit when a single session exceeds 1 GB.
- Scope: 157 first (WP2), then produced at ingest for everything (backfill gets it free). Version coupling: `paragraph_tokens.lemma_is_version` = `speeches.lemma_is_version`; `scripts/reindex.ts` rewrites `lemma_text`, `lemma_seq`, `paragraph_tokens` from `paragraphs.text` for paragraphs whose `paragraph_tokens` row is **missing or** stale (version ≠ current), newest first, 2k paragraphs/transaction; MVs refreshed at the end; no recrawl ever.
- Migration safety: `lemma_seq text not null default ''` (old crawler inserts keep working); the stored generated column rewrites `paragraphs` under lock → **run 0002 only after the tmux crawl has exited** (`crawl.ts` holds the advisory lock; wait for it, never kill it).

## 2. BÍN licence → word pages

lemma-is README (the only licence text; MIT code, data CC BY-SA 4.0 per `BINARY_DATA_MANIFEST.json`): credit Árnastofnun, no raw-data redistribution, **no inflection paradigms without permission**. Rules: `/ord/<lemma>` shows only forms **observed in Alþingi speeches** with counts (corpus facts, not BÍN data), never a case/number grid, never unobserved forms, never a form→lemma dump or an export endpoint of the lemma mapping; "unknown word" and did-you-mean come from the corpus vocabulary. Footer on every page and in `/um` and `llms.txt`: *"Lemmun byggir á Beygingarlýsingu íslensks nútímamáls (BÍN), © Stofnun Árna Magnússonar í íslenskum fræðum, CC BY-SA 4.0, um lemma-is."* Revisit only if Árnastofnun objects.

## 3. Undecoded speech attributes (from 278 texts + 22 fixtures)

| attr | values → meaning | confidence | store |
|---|---|---|---|
| `tegr` | R ræða, A andsvar, K um atkvæðagreiðslu, G grein fyrir atkvæði, U um fundarstjórn, F flutningsræða, S svar — identical to index `tegundræðu` | high | keep raw; never read |
| `tegflm` (speaker capacity) | Þ þingmaður, R ráðherra (=`embætti` present, 17/17), F forseti (=role forseti 18/18), S fyrirspyrjandi (sponsor of a fsp.), N framsögumaður nefndarálits (`nefnd` = committee abbr) | high | `speaker_capacity` enum column via a decode map |
| | 1 / 2 / M / 0 — only with role framsögumaður + `nefnd="fl"` or a committee: 1./2. flutningsmaður, M meðflutningsmaður or minnihluta-framsögumaður, 0 unnumbered | medium | decoded, label "giskað" in UI |
| | L (2018 flutningsræða on vantraust) | low | raw only |
| `nefnd` | `fl` = flutningsmaður marker; else committee short abbr (`am`, `ev`, `forsn`) — strong committee link | high | `speeches.nefnd text` + join to `committees.abbr` |
| `frhr` | "0" in all 300 — "framhald ræðu" (continuation after an interruption) | medium | `speeches.continued bool` (= `frhr<>'0'`); acceptance test counts non-zero after 157 completes |
| `skst`, `embætti` | speaker abbreviation (= `members.abbr`), minister portfolio | high | kept; test: ≥ 99% of `skst` match `members.abbr` |

## 4. Matter detail, votes, committees

- **In v1, A-mál only, 157 first** (729 req ≈ 1 h) **before** the remaining 157 texts: one hour buys status text, documents, vote summaries, efnisflokkar, law numbers, related matters for every 157 page. Thereafter per session, **texts N → matter detail N → next session**, newest first.
- Tables (`sql/0003`): `matters` + `status_text`, `efnisflokkar` + `matter_efnisflokkar`, `matter_laws(lthing,cls,nr, law_year, law_nr)`, `matter_links(from, to, kind)`, `documents(lthing, nr, type, title, url, date)` (ids only, no text — v2), `votes(id, lthing, cls, nr, time, fundur, kind, doc_nr, method, result, yes, no, abstain)`, `ballots(vote_id, member_id, choice)` with the five choices verbatim, `committees(id, lthing, name, abbr, abbr_long)`, `consultation_requests`.
- Votes: `atkvaedagreidslur/?lthing=N` = **one request per session** (Phase 1). **Ballots** (`atkvaedagreidsla/?numer=`) only for `aðferð='atkvæðagreiðslukerfi'`, newest session first, Phase 2 (≈ 1.5k/session, ≈ 40k total ≈ 2.3 days, interleaved after each session's texts).
- Committees: `nefndir/?lthing=N` one request/session (Phase 1); `nefndarmenn` deferred to Phase 2 (member profile only).

## 5. Enrichment layer, models, residency

- Phase 3 only: `annotations` + `annotation_runs` exactly as IDEAS §6 (`sql/0004`), created empty; source tables never get a derived column; MCP/UI mark `derived:true, model, confidence`.
- **Jev eval: run it, Phase 3, cap $5** (corpus 157 ≈ 12 M tokens ≈ $0.50 at the vendor price). Ground truth = matter `efnisflokkar` from §4. Set: 1,000 first-substantive paragraphs of 157 A-mál speeches (types ræða/flutningsræða/andsvar, single-efnisflokkur matters), closed set = efnisflokkur ids (+ "none"). **Pass** = top-1 ∈ matter's set ≥ 70 % **and** ≥ TF-IDF-centroid baseline + 10 pts. Pass → label B-mál/`ft` paragraphs of 157 (< $3) as "líklega um". Fail → annotations stay empty, no topic lens. Jev early access unavailable → same rubric on Gemini Flash (key already on this machine for the translate skill), same cap. **Total hosted spend ≤ $20** tracked in `annotation_runs.cost_usd`.
- **Residency rule** (stated on `/um`): text and metadata in source tables are the public parliamentary record and may be sent to any hosted model; user queries, IPs, MCP request bodies, logs never leave the mini.

## 6. Hosting and ops (verified read-only on the mini unless marked)

- Host **`althingi.solberg.is`**, MCP at `/mcp` on the same host (one rate-limit rule covers both). Bun process `althingi-web` on **127.0.0.1:3050**, launchd `com.jokull.althingi-web` (KeepAlive, `taskpolicy -b` not used for the server).
- **Tunnel: a third, dedicated, remotely-managed tunnel** `althingi` (`cf tunnels create`, token in `~/althingi/.env`, plist `com.jokull.althingi-tunnel`, ingress via `cf tunnels config update` (verified to exist), CNAME via the DNS record create command (confirm the exact name with `cf cli search "create dns record"`; my list call returned no JSON). Additive, no restart of the two existing tunnels. Goes live **behind Cloudflare Access** (policy: `jokull@solberg.is` only) until the public flip (human go).
- **Alerts: Telegram via openclaw** — `openclaw message send --channel telegram --target 461214887 -m "…"` (channel enabled + allowlisted on the mini); fallback `mail jokull@solberg.is` (postfix present, delivery UNVERIFIED). `ops/alert.sh` wraps both. Triggers: ingest exit ≠ 0, ingest age > 36 h, backup failure, 403/429 from Alþingi, `/healthz` red.
- **pg_textsearch: skip in v1** (absent, needs `shared_preload_libraries` + a restart that bounces planitor and orflaedi, macOS arm64 build UNVERIFIED). Ranking = `ts_rank_cd(vector, q, 1)` + boosts (§9). Revisit only if WP3 fails the P@5 gate after boosts: bake-off first in the local docker Postgres, install on the mini only if it wins by ≥ 0.1 P@5, in an announced minute.
- Cloudflare (zone `solberg.is`, **Free**): Cache Rules 10/zone (verified docs); `stale-while-revalidate` honoured when the origin sends it (verified docs); `stale-if-error` listed as a supported directive, behaviour on origin 5xx **UNVERIFIED** → test in WP7 by stopping the web process; rate limiting rules on Free: **1 rule, 10 s period, block** (legacy table verified; new-WAF matrix UNVERIFIED) → 100 req/10 s per IP; in-process token bucket `/mcp` 60/min, `/leit` 30/min on `cf-connecting-ip`. `cf cache purge` exists (purge by URL list after ingest). R2 buckets `althingi-raw`, `althingi-backups` (`cf r2 buckets create`).
- **MCP SDK**: `@modelcontextprotocol/sdk` 1.32.2 + `@hono/mcp` 0.3.5 (`StreamableHTTPTransport`), stateless, mounted in the same Hono app on Bun. Acceptance = `initialize` + `tools/list` over curl. Fallback: SDK node HTTP server on 3051 behind the same tunnel.
- Backups: nightly 04:10 `pg_dump -Fc` → `~/althingi/backups` → `rclone` to R2 (30-day lifecycle); weekly raw-XML rsync to R2 (kept forever); monthly restore-test launchd job (`pg_restore` into `althingi_restore`, 5 smoke queries, drop) that alerts on failure. No partitioning (≤ 10 GB; revisit at 50 GB). Retention: everything forever; upstream text changes = new `raw_sha256` + `paragraphs` rewrite with `revised_at`.

## 7. URLs, SEO, crawlers, caching, visibility

Routes: `/` · `/leit?q=` (+ filters in the URL) · `/leit/rows?…` (htmx partial, own URL) · `/raeda/<id>#mgr-<seq>` · `/mal/<lthing>/<a|b>/<nr>` · `/thingmadur/<id>` · `/flokkur/<party_id>` · `/dagur/YYYY-MM-DD` · `/thing/<lthing>` · `/ord/<lemma>` · `/atkvaedagreidsla/<id>` · `/log/<year>/<nr>` (matters amending that law) · `/thingskjal/<lthing>/<nr>` (302 to althingi.is until v2) · `/um` · `/healthz` · `/mcp` · `/robots.txt` · `/sitemap.xml` + `/sitemaps/<lthing>.xml` · `/llms.txt`. `r2025-…` ids 301 to `rad…`. Upper-case class 301s to lower.
SEO/LLM: JSON-LD (`Person` on members, `Legislation` on `l`-type matters, `CreativeWork`+`author` on speeches); robots allow all agents (incl. GPTBot/ClaudeBot/PerplexityBot — public data we want cited), `Disallow: /leit /mcp`; sitemaps per lthing (past sessions immutable, `lastmod` = max `fetched_at`); `llms.txt` = corpus boundary, URL scheme, MCP tools, attribution. No `llms-full` (hundreds of MB).
Caching: past sessions `public, s-maxage=31536000, stale-while-revalidate=86400, stale-if-error=604800` + strong ETag; current session and lists `s-maxage=300, stale-while-revalidate=3600, stale-if-error=86400`; `/leit*` `s-maxage=60`; `/mcp` `no-store`. Visibility: **public read-only site and MCP, no auth, rate-limited** once flipped; Access-gated before.

## 8. Pre-2005 text

- Out of v1 text. **Index rows are stored anyway**: the per-member lists already return SGML-era entries (1999 fixture: every entry has `ræðahófst`, 39/43 have `<sgml>`); `upsertSpeechIndex` keeps them with `text_state='unavailable'`, `era='sgml'`, id = `sgml<lthing>_<dir>_<stem>` from the `<sgml>` path (`/altext/123/03/r02133209.sgml` → `sgml123_03_r02133209`; the bare stem is day+time and repeats across months). Schema: `speeches.xml_url` becomes nullable, new `source_url text` (sgml/html link); `text_state` check gains `'unavailable'`; entries without a start time or link are skipped. Zero extra requests. Member/matter/day pages then show *"N ræður 1991–2004: texti ekki í þessu safni"* with the althingi.is link; every "first/total" reads *"frá 2005 (XML-öld)"*; search filters have no pre-2005 option; `/um` states the boundary and why (bot challenge, not circumvented).
- Alþingi's reply (email already sent): if they offer an XML/SGML export, ingest as `era='sgml'` with the same ids. IGC Alþingi subcorpus: licence **UNVERIFIED** (believed CC BY 4.0) → not used; revisit when Alþingi says no and the CLARIN licence page is read as CC BY.

## 9. Search quality

- **Ranking**: paragraph `ts_rank_cd(search_vector, q, 1)` (log-length normalised) × type factor (flutningsræða/ræða 1.0, svar 1.0, andsvar 0.8, grein/um atkvæðagreiðslu 0.6, um fundarstjórn 0.4) × debate factor (1/2/3 1.0, `*`/E/F/S/T 0.9) × 1.3 when the matter-title tsvector (`matters.title_vector`, generated) matches × recency 1.1 for the current session. **Group by speech** (lateral: best 2 paragraphs, "+N fleiri"), sort `score desc, started desc`. "Nýjast fyrst" is a sort option.
- **Routing** (before FTS, regex on the raw query): `lög nr. 46/2016`, `46/2016` → `/log/2016/46`; `þskj. 421`, `þingskjal 421` → document (current lthing unless `157/421`); `300. mál`, `mál 300`, `157/300` → matter (class a; b if `b/`); member name via `pg_trgm` on `members.name` (unique match → `/thingmadur`, else chip). Numbers never reach FTS.
- **Expanded-query chip**: "leitað að: (húsnæði | húsnæðislán) & vextir" from `queryGroups`; each group removable (`-g=húsnæðislán`); unknown words and phrase skips listed; `explain_query` MCP tool returns the same JSON.
- **Measurement** (`scripts/eval.ts`, `test/golden/queries.json`): (a) judged set = 25 queries below, implementer-judged top 5 after the first run, stored as `{q, intent, expect: route|lemmas|speech_ids}`; (b) automatic = 100 random 157 A-mál titles (distinctive lemmas as query), relevant = speeches on that matter, MRR. Queries: húsnæðislán vextir · verðbólga · veiðigjald · strandveiðar · kvótakerfi · hælisleitendur · loftslagsmál · orkuskipti · vindorka · Landspítali biðlistar · leikskólar · kennarar kjarasamningar · lögreglan · Evrópusambandið aðildarviðræður · bankar einkaleyfi · rafmagn Reykjanes · fjárlög 2026 · "hér á landi" · "virðulegi forseti" · "ekki er allt sem sýnist" · lög nr. 34/1991 · þskj. 421 · 300. mál · 157/300 · Kristrún Frostadóttir · húsnæðsilán (typo) — 19 FTS/phrase, 5 routing, 1 did-you-mean.
- **Phase 0 exit**: P@5 ≥ 0.8 over the 19 FTS/phrase queries (≥ 16 with ≥ 4 of top 5 relevant; a query with < 5 hits in the 952-text corpus passes when all its hits are relevant and the expanded query is correct), routing 5/5 land on the right entity, typo query shows the suggestion, auto MRR ≥ 0.6, property test (query finds own paragraph) ≥ 99.9 %, DB time p95 ≤ 20 ms on the local DB, size projection ≤ 8 GB, `bun test` green incl. db tests.

## 10. Other data-model decisions

- `speeches.era text` (`xml`|`sgml`), `speeches.reply_to_id text` + `reply_to_inferred bool default true`: andsvar → previous non-andsvar speech in the same (fundur, matter) by `started` within 15 min; `svar` → the fyrirspurn's `flutningsræða` (strong). Shown as "líklega andsvar við …".
- Speech → document: via matter; `flutningsræða` links the matter's first document (inferred flag). Member ids are source ids, no merges; `party_lineage(from_id, to_id, note, since)` curated, Phase 2. Party-at-time always via `seats` (kind in þingmaður, varamaður) on the speech/vote date; no `lthing` joins.
- `matters.title_vector` generated from `lemma_text` of the title (filled at upsert). `is_substantive` = type in (ræða, flutningsræða, andsvar, svar) and role ≠ forseti, used for trend denominators and member profiles.
- **Crawler never idles**: the moment the tmux run exits, start `bun scripts/crawl.ts text --lthing 157` on the laptop (resumable, 0 extra cost) and let it run while WP1–3 are built; WP1's migration waits for the window between runs. Dev→mini move (WP4) happens at the next natural stop: `rsync ~/althingi/raw` + `pg_dump althingi_phase0 | pg_restore` into `althingi`; `raw_fetch.path` rewritten to the mini path; crawling resumes on the mini (WP8) with the same lock discipline.

## Build plan (one crawler at a time, 5 s, XML only; mini changes additive only)

| # | Package | Files | Acceptance | Crawl req | Deps / parallel |
|---|---|---|---|---|---|
| **Phase 0 — exit gate** | | | | | |
| 1 | Schema 0002: `paragraph_tokens`, `lemma_seq`/`seq_vector`, `speeches.nefnd/continued/speaker_capacity/era/reply_to_*/source_url`, nullable `xml_url`, `matters.title_vector`; parse.ts reads `nefnd`/`frhr`; SGML-era index rows kept | `sql/0002_tokens.sql`, `src/parse.ts`, `src/db.ts`, `test/parse.test.ts`, `test/db.test.ts` | `bun test` green; db test asserts 2018-03-06 fixture yields `nefnd`, the 1999 list yields 39 `unavailable` rows with `sgml123_03_…` ids | 0 | apply to dev DB only between crawl runs |
| 2 | `seqLemmas()` + `tokenStream()` in lemma.ts; ingest writes both; `scripts/reindex.ts`; run on the 952 texts; measure | `src/lemma.ts`, `src/ingest.ts`, `src/db.ts`, `scripts/reindex.ts`, `test/lemma.test.ts` | reindex of 952 texts < 2 min; `pg_total_relation_size` printed; projection ≤ 8 GB; phrase test: `"hér á landi"` finds its paragraph | 0 | 1 |
| 3 | Search v2: group by speech, boosts, phrase, routing, explain; `scripts/eval.ts` + `test/golden/queries.json`; judge; gate | `src/search.ts`, `src/route.ts`, `src/explain.ts`, `scripts/eval.ts`, `test/golden/` | §9 thresholds printed as PASS | 0 | 2 ∥ 4 |
| 4 | Mini prep: `ops/mini-setup.sh` run, rsync raw, dump/restore, `althingi_ro` smoke, lsof confirms 3050 free | `ops/mini-setup.sh`, `ops/move-dev.sh` | `psql -U althingi_ro` returns 952 done speeches; raw count matches `raw_fetch` | 0 | after crawl ends; ∥ 3 |
| **Phase 1 — live on the mini** | | | | | |
| 5 | Web: Hono + JSX pages for all §7 routes, htmx partials, caching headers, ETag, sitemaps, robots, llms.txt, JSON-LD, `/um` with boundary + attribution + residency rule | `src/web.ts`, `src/pages/*.tsx`, `src/cache.ts`, `public/app.css` | `oha -n 200 -c 10 /leit?q=veiðigjald` p95 ≤ 120 ms local; HTML ≤ 50 KB; Lighthouse SEO 100 | 0 | 3; ∥ 6 |
| 6 | MCP: `search_speeches`, `get_speech`, `get_context`, `get_matter`, `get_member`, `list_votes`, `aggregate`, `explain_query`, `list_sessions`, resource URIs; 8 KB default payload | `src/mcp.ts`, `test/mcp.test.ts` | curl `initialize`+`tools/list`+one search over Streamable HTTP; Claude Code connects | 0 | 3; ∥ 5 |
| 7 | Deploy: launchd web + tunnel plists, `cf tunnels create/config update`, DNS CNAME, Access policy, 3 cache rules, 1 rate-limit rule, R2 buckets, backups + restore-test jobs, `ops/alert.sh`, `/healthz` | `ops/*.plist`, `ops/deploy.sh`, `ops/alert.sh`, `ops/backup.sh` | `https://althingi.solberg.is/healthz` 200 via Access; stale-if-error test (stop web → cached page served); alert.sh posts to Telegram; restore test green | 0 | 4, 5, 6 |
| 8 | Crawl on the mini: 157 A-mál detail (`sql/0003` tables, parsers), votes list 157, nefndir 157, then remaining 157 texts; incremental `scripts/ingest.ts` launchd 06:10/12:10/16:10/22:10 + purge | `sql/0003_matters.sql`, `src/parse.ts`, `scripts/crawl.ts` (`matters`, `votes`, `committees`), `scripts/ingest.ts` | `crawl.ts status` shows 157 pending = 0; `/mal/157/a/300` shows status, 36 votes, 43 docs; `frhr`/`skst` tests from §3 | ≈ 731 + ≈ 11,000 (≈ 17 h) | 4; ∥ 5–7 |
| 9 | Soak: 7 unattended days, freshness vs `?dagur` counts, p95 from Reykjavík, MCP used from Claude Code; then public flip | `docs/RUNBOOK.md` | 7/7 days ingest age < 12 h; no alert false-positives | ≈ 100/day | 7, 8 → **human go** |
| **Phase 2 — backfill 156 → 131** | | | | | |
| 10 | Per session newest first: texts N → A-mál detail N → votes list N → nefndir N; weekly checkpoint; `member_terms` check on 3 party-switchers | `scripts/backfill.ts` | each session: pending 0, matters with status ≥ 95 % | ≈ 230k + 22k + 54 | 8 |
| 11 | Ballots for electronic votes, newest session first | `scripts/crawl.ts ballots` | `/atkvaedagreidsla/<id>` grid by party-at-date; rebels view | ≈ 40k | 10 (interleaved per session) |
| 12 | MVs `lemma_stats`, `lemma_forms`, `mv_speech_counts`; `/ord/<lemma>`, ngram viewer, member profiles, `aggregate` on the MVs; `party_lineage` | `sql/0005_mv.sql`, `src/pages/ord.tsx`, `scripts/refresh-mv.sh` | refresh < 10 min at 157+156; `/ord/lán` loads < 50 ms; observed forms only | 0 | 2, 8; ∥ 10 |
| 13 | SGML-era rows in UI (member/day counts, boundary copy); Alþingi reply handling | `src/pages/*` | member page shows pre-2005 count + link | 0 | 1, 5 |
| **Phase 3 — enrichment** | | | | | |
| 14 | `sql/0004_annotations.sql`; `scripts/eval-topic.ts` (TF-IDF baseline + hosted model under $5); report | `sql/0004`, `scripts/eval-topic.ts`, `docs/EVAL-topic.md` | §5 pass/fail printed; `annotation_runs.cost_usd` ≤ 5 | 0 | 8 → **human go** for a paid key if Jev |
| 15 | If 14 passes: topic lens on B-mál/`ft` paragraphs of the current session; `get_annotations`; "rangt?" feedback | `scripts/annotate.ts`, `src/pages/*` | labels render with model + confidence; fallback renders without | 0 | 14 |

Parallel lanes: {3} ∥ {4}; {5} ∥ {6} ∥ {8}; {12} ∥ {10}. Crawl lane is strictly serial: current text run → 8 → 10/11.

## Needs human go (everything else: decide and proceed)

1. **Public flip** (WP9): remove the Access policy on `althingi.solberg.is` (site + MCP become public).
2. **Paid/early-access model key** (WP14): Jev signup, or confirm using the existing Gemini key under the $5/$20 caps.
3. Optional: an external uptime monitor account (UptimeRobot free) for `/healthz` — only meaningful after item 1, since Access blocks external probes; until then alerts come only from the mini itself.
(Alþingi email: already sent — await the reply, no action.)

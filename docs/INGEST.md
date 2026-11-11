# Ingest redesign: dumps first, service for gaps and freshness (2026-11-11)

Design only. Nothing here is implemented; `src/`, `scripts/` and the databases are untouched. Evidence: the unpacked bulk
export at `~/Downloads/xmlfiles/` (1.9 GB, 250,788 `raedur/` files, sessions 130–158, built up to 2026-11-10 14:29),
the raw service cache on the mini (`~/althingi/raw`: 292 lists, 1,052 matter details, 13,672 speeches), the lagasafn zip
on the mini, the code and docs in this repo, and read-only `psql` on the mini (157: 11,974 done; 158: 2,319 done; 153:
not indexed; `vod_url` NULL on all 14,293 rows, `audio_url` set on all). **UNVERIFIED** marks claims not checked against a
file.

Principle: **the dump is the ground floor**. Every entity that exists in the dump is ingested from the dump, in bulk, with
zero requests. The XML service is used only for (a) entities no dump carries, (b) the gap between the last dump drop and
now, (c) ids the dump lacks (member ids, matter detail). Today's crawler inverts this (service index → dump for text);
the inversion is the root of the DMK gap, the ballot backlog and the 1.5-day matter crawl.

## 1. Inventory: source × entity

Sessions: dump = 130 (fragments) and 131–158. Service XML era = 131→. Request cost at 5.3 s/request.

| Entity | Bulk dump (`xmlfiles.zip`) | XML service | Lagasafn zip | Fidelity / notes |
|---|---|---|---|---|
| Speech **text** (final) | `<l>/raedur/rad<ts>.xml`, 250,788 files 131–158; byte-identical to the service file | `/xml/<l>/raedur/rad….xml`, 1 req/speech | — | Dump wins (same bytes). Only speeches newer than the drop come from the service. |
| Speech text (provisional) | `raedur_bradabirgda/`: 153 has **3,663 speeches that exist only as provisional** (53 overlap with final); 156: 458 (11 overlap); others ≤ 27 | not offered | — | Lowest precedence; shown with a "bráðabirgðatexti" flag; replaced when a final appears in any later source. Whether the service has finals for the 3,663 of 153: UNVERIFIED (153 not indexed yet). |
| Speech **index** (who/when/type/matter) | **The speech file itself** carries `skst`, `tími`, `tegr`, `tegflm`, `embætti`, `nefnd`, `frhr`, `lgþ`, `fundur`, `<mál nr málsflokkur málstegund><málsheiti>`. Complete for every text in the dump, including non-MP ministers (DMK: 301 files in 157) | per-member `thingmadur/raedur/?nr=` (whole career, misses non-MP ministers); `raedulisti/?dagur=` (per day, reaches everyone); matter detail `<ræður>` (carries `þingmaður='1448'` ids even for DMK) | — | Dump index lacks the **member id** (skst only), the html/audio links and the service's type label. Join rule in §2. |
| Speech order inside an agenda item, vote flag | `lidaskjol/lid<ts>.xml`: per item `<þingræða skst tími tegr tegflm frhr>` in order, `atkvæðagreiðsla="true|false"`; 36k files | implicit in time order | — | Measured on 157: 12,590 `þingræða` rows; 10,324 match a speech file stem exactly; of the 2,266 others only 269 have a file by the same `skst` within ±120 s (median gap 12 s) — the remaining ≈ 2,000 rows (16 %) have **no text file at all** (presumably presiding-officer remarks, `tegflm="F"` = 776 rows; breakdown UNVERIFIED). Join: exact stem, else `(skst, Δt ≤ 120 s)`, else a `sitting_items` row with no speech. lidaskjol is therefore the sitting record, not the text index. |
| Sittings (þingfundir) | `fundir/fun<nnn>.xml`: `fundarheiti`, `fundurhefst`, `fundiSlitið`, per item `<þingmál id="lid…" tími>` with `<mál>`, `umræðuLokið`, `umræðuOgAtkvæðagreiðsluFrestað`, `frvAfgreittSemLög`, `samantekt` prose; 3,000 files | `dagskra/thingfundur/` (next sitting only, llms.txt) | — | Dump-only entity. Timeline events (debate closed, passed as law) come from here. |
| Agendas | `dagskra/dag<nnn>.xml`: ordered `dagskrárliður` with `<mál>`, `<þskj>`, `<flm skst>`, `utanDagskrár` | next sitting only | — | Dump-only (history). |
| Document distribution (útbýting) | `utbyting/utb<ts>.xml`: `<skjal nr tegund embætti><flm skst embætti/><mál nr/><titill>`; document type census for 157: fsp. 399, svar 271, stjfrv. 120, nál. m. brtt. 108, nál. 86, þáltill. 78, frv. 69… | `thingskjol/?lthing=` (1 req/session: all document ids+types); matter detail `<þingskjöl>` (ids, type, issued, html/pdf/xml urls) | — | Dump gives `(nr, type, matter, sponsors, distributed-at)` per document; service adds URLs. Document **text** (`thingskjal/?lthing&skjalnr`, 1 req/doc) is in neither dump. |
| **Sponsors** (flutningsmenn) | `<flm skst embætti>` in `lidaskjol/<mál>`, `utbyting`, `dagskra`, `fundir` — ordered as served (1. flm first: UNVERIFIED, plausible) | matter detail has **no** sponsor element (grep `flutningsm` over 1,052 cached details → 0). `framsögumenn` are rapporteurs. | — | Dump-only entity. Closes PERSONA gap #6. |
| Votes (summaries) | `lidaskjol`: `<atkvæðagreiðsla nr þskj tegskjals tími birtaatkvæði aðferð nefnd><um tegatkvgr/><niðurstaða já nei fjarverandi greiðaekkiatkvæði samfel samhljóða/>`; 157: 1,693 distinct vote nrs | matter detail `<atkvæðagreiðslur>` (per matter; counts, method label, result); `atkvaedagreidslur/?lthing|?dagur|?dagar` (1 req) | — | Same vote ids (`nr` = `atkvæðagreiðslunúmer`). Service has the human labels (`aðferð` text, `afgreiðsla`); dump has codes (`S G K N E Y`, `tegatkvgr`). Decode table in §3. |
| **Ballots** (per member) | `lidaskjol`: `<atkv skst gildi>`; 157: **76,947 ballots on 1,185 votes** (all `aðferð="S"` except 2 `N`; `G`/`K`/`E`/`Y` votes carry none). Verified back to 2004: 131 = 85,550 ballots / 1,625 votes, 135 = 108,496 / 2,416, 140 = 60,921 / 1,777, 145 = 81,207 / 1,946, 150 = 78,390 / 2,186, 154 = 72,666 / 1,635, 156 = 19,007 / 560 | `atkvaedagreidsla/?numer=` 1 req/vote (≈ 40k for 131–156) | — | Dump covers electronic votes for every session → the 40k-request ballot crawl (DECISIONS WP11) is **deleted**. Values: `já nei fjarverandi greiðir_ekki_atkv`; stored normalised to the service's verbatim strings already documented on `ballots.choice` (`greiðir ekki atkvæði`); `boðaði fjarvist` exists only on the service side. Vote-summary counts differ slightly: service 1,740 summaries for 157 (incl. "kom ekki til atkvæðagreiðslu") vs 1,693 in lidaskjol — the service list is the superset for summaries, the dump for ballots. |
| Absences / leave | `fjarvist/` (131–153, 156–157) and `fjarvistir/` (154→): `<þm skst embætti>` per sitting | not offered | — | Dump-only. Names differ by era; same schema. |
| Members returning (`inn/`), reading-room filings (`lestrarsalur/`), government bill plan (`thingmalaskra/` 135–146) | per sitting; `inn`: `<þm skst>`; `lestrarsalur`: prose; `thingmalaskra`: `<þingmálalisti embætti><boðaðÞingmál>` | — | — | Ingest `inn` (seat-return events, helps `með varamann` edges); the other two: store raw, no table (v2). |
| `spoluskjol/` (131–142) | tape transcripts containing `<ræða>` blocks; 140: 14,346 ids vs 14,163 `raedur/` files, **185 only in spoluskjol** | — | — | Gap-fill source for 131–142 after `raedur/`. Mark `text_source='dump-spola'`. |
| Members (id, name, born, abbr) | skst only | `thingmenn/?lthing=` (1 req/session; MPs only); speech lists carry `(id, nafn)` for anyone who spoke incl. ministers | — | Service-only for ids. Non-MP speakers enter `members` from speech-list entries. |
| Seats, parties, constituencies | — | `thingmadur/thingseta/?nr=` (1 req/member) | — | Service-only. |
| Matters (list) | titles in every speech/lid/utb file (A and B) | `thingmalalisti/?lthing=` (1 req/session) | — | Service list = canonical titles/type labels; dump titles are stubs. |
| **Matter detail**: status, documents w/ URLs, consultations, submissions, links, laws amended, topics, rapporteurs, **`<ræður>` speech list with member ids and `vod` links** | — | `thingmalalisti/thingmal/?lthing&malnr` 1 req/A-matter: 157 = 729, **131–156 = 17,654 A-matters (sum of the `matters` table on the mini) ≈ 26 h** | — | Service-only and the single biggest cost. Item 1 of the ask to Alþingi (§7). `parseMatterDetail` ignores the `<ræður>` block today; it gains it (ids for non-MP ministers, `vod`). |
| Sittings/sponsors in 2004-era files | `131/fundir`: `þingmál` 1,555, `flm` 3,010, `umræðuLokið` 241, `umræðuOgAtkvæðagreiðsluFrestað` 353; `131/utbyting`: 3,678 `flm` | | | Same structure as 157 (`frvAfgreittSemLög` not seen in the 131 census top-14; UNVERIFIED whether it exists before the `ns:` era). |
| Committees | `nefnd` attr on speeches; `nefnd="atvvrh."` on votes | `nefndir/?lthing=` (1 req/session); `nefndarmenn` (v2) | — | Service. |
| Laws (text, structure) | — | — | `lagasafn/zip/nuna/allt.zip` (8.9 MB, 1,799 files, ISO-8859-1 HTML): `YYYYNNN.html` per law with title, in-force date, **"Ferill málsins" link (`ltg`, `mnr`)**, "Breytt með L. nn/yyyy (tóku gildi …)" amendment list, chapters/articles with `id="G1"` anchors; `01.html…` chapter indexes with the edition ("158a") | Invited by llms.txt. Edition per file. Twice-yearly editions (`<edition>/allt.zip`). Gives law↔matter and the amendment graph, not only text. |
| Pre-2005 text | — (dump starts at 130 fragments) | SGML links 403 | — | unchanged (DECISIONS §8). |

Parser invariants found while sampling: (1) dump files are **NFD**, service responses **NFC** — every skst/abbr join
normalises to NFC first (without it 0 of 113 abbreviations matched; with it 111/113, the two misses are DMK and HallT,
non-MPs); (2) `ns:` prefix appears on some files within a session (157 lidaskjol: 581 of 12,590 speech rows), so all dump
parsers match local names; (3) zip extraction preserved mtimes (spread over real dates) — usable as a cheap pre-filter,
never as the change signal; (4) `tegr="B"`, `tegflm="I"` (þingsetning), `tegflm="3"` exist in lidaskjol and are not in
DECISIONS §3: raw-only.

## 2. Layer model

```
L0  dump          zero requests   speeches(text+index by skst), sittings, agendas, lid order, sponsors, votes, ballots,
                                  absences, documents(nr,type,matter,sponsors), laws (lagasafn zip)
L1  session lists ≤ 10 req/session  sessions, members(ids), matter list, document list, votes list, committees
L2  per-item fill 1 req/item     matter detail (A-mál), seats per member, [document text v2]
L3  live          1 req/poll     raedulisti/?dagur=today, atkvaedagreidslur/?dagur=today, new speech files
```

**Precedence (when two sources describe the same key):**

| Entity | Rule |
|---|---|
| Speech text | `service-final` = `dump-final` (identical bytes; whichever arrived first stays, sha compared) > `dump-spola` > `dump-provisional`. A later source with a *different* sha than the stored final → rewrite paragraphs, set `revised_at`, keep the old sha in `speech_revisions`. |
| Speech index fields | member id, type label, audio/html/vod urls: service (day list and matter detail carry `vod`, the per-member list does not); `skst`, `tegr`, `tegflm`, `embætti`, `nefnd`, `frhr`: dump file (the service does not carry them). Start time: file stem is canonical (existing rule). Matter: dump `<mál>` and service agree; on disagreement service wins and the row is flagged `conflict`. |
| Vote summary | counts from the dump `niðurstaða`; labels (`aðferð`, `afgreiðsla` text) from the service when present; `doc_nr` from either. |
| Ballots | dump. Service `atkvaedagreidsla/?numer=` only for `S`-method votes whose lid file has no `<atkv>` (157: 7 votes) or for votes after the drop. |
| Sponsors | dump (`lidaskjol` first, then `utbyting`, `dagskra`, `fundir` — same data; first file that has it wins, order kept). |
| Matter title/type | service list > matter detail > dump stub. |
| Laws | newest edition wins; prior editions kept as rows keyed by edition. |

**Provenance**: every ingested row carries `source text` with values `dump`, `dump-provisional`, `dump-spola`, `service`,
`lagasafn`, `derived`; plus `source_ref text` (dump: `<lthing>/<dir>/<file>`; service: the URL; lagasafn: `<edition>/<file>`).
Pages and MCP already expose `derived`/`inferred`; `source` joins that vocabulary (`text_source` shown on speech pages when
not `dump`/`service` final).

## 3. Entity-by-entity plan

Identity keys are the existing ones; nothing is re-keyed.

**Speeches.** Key `rad<ts>` = file stem. Ingest from `raedur/` directly: the file yields the index row *and* the text in one
pass (new `upsertSpeechFromFile`: insert index row with `member_id = null` when unknown, `speaker_abbr`, `text_state='done'`,
`index_source='dump'`). Idempotent by `raw_sha256`: same sha → skip parse and lemmatization entirely (no-op). Member id
resolution runs as a derive step: `speaker_abbr` → `speaker_aliases(abbr → member_id)`; aliases are **learned**, not
curated: whenever a service speech-list entry (`þingmaður` id + `ræðahófst`) and a dump file (`skst` + stem) share a speech
id, record `(abbr, member_id, first_seen, last_seen, n)`. MPs resolve via `members.abbr` on day one; DMK resolves the moment
one matter detail or one day list that mentions him is ingested (1448 is already in `raw/matters/157`). Unresolved rows are
visible (speaker shown as `skst` + `embætti`, "ráðherra utan þings") and counted in `/healthz`. `reply_to_id`: derive step
per (fundur, matter) over `lidaskjol` order (andsvar → nearest preceding non-andsvar by the same item), `reply_to_inferred=false`
when the lid order gives it, `true` for the 15-min fallback. `vod_url`: the per-member list has **no `<vod>` element**
(census of `raedur_member_1417.xml`: 840 `hljóð`, 0 `vod`) — the column is empty because the index was built from that
list, not because of a parser bug. The **day list** (`fixtures/d20180306.xml`: 84 `<vod>`) and the **matter-detail
`<ræður>` block** (`fixtures/r157_1.xml`: 818) do carry
`https://vod.althingi.is/player/?type=vod&file=<ts>&start=<s>&duration=<s>`. So `vod_url` fills from the sitting-day poll
(day lists) and from matter detail; the backfill gets it as matter details arrive. Not an ask for Alþingi.

Dump filename irregularities (157 `raedur/`): a few files are named `<ts>.xml` without the `rad` prefix or carry a
leading space (` rad20250911T110053.xml`); the dump parser takes the id from the file's `tími` attribute when the name
does not match `rad\d{8}T\d{6}\.xml`, and the stem rule (`ingest.ts`: same day) stays.

Dump-only speech rows meet four `not null`/semantic gaps in `speeches`: `member_name` (dump has skst → filled from
`speaker_aliases`/`members` in `derive`, placeholder = abbr until then), `type` (dump has `tegr` code → decode
`R ræða, A andsvar, K um atkvæðagreiðslu, G grein fyrir atkvæði, U um fundarstjórn, F flutningsræða, S svar` per DECISIONS
§3; `B` undecoded → `'óþekkt (B)'`), `debate` (not in the speech file → from `lidaskjol <mál umr>` when linked, else `''`),
`xml_url` (constructed from the stem with the pattern in `fetcher.ts` so the service fallback still works). §4 lists the
column changes.

**Speakers / non-MP ministers.** `members` gets rows for anyone with a service id (speech lists, matter detail). New
`speaker_aliases` as above. The `office` string (`embætti`) is kept on the speech; a `ministries(office_abbr, name)` decode
table is curated (13 values in 157).

**Sittings and agendas.** `sittings(lthing, fundur)` from `fundir/` (name, start, end, source file); `sitting_items(lthing,
fundur, seq, lid_id, cls, nr, started, debate, kind, vote_flag)` from `fundir/<þingmál>` ∪ `lidaskjol`; `sitting_events`
(`umræðuLokið`, `frvAfgreittSemLög`, `umræðuOgAtkvæðagreiðsluFrestað`, `fundurhefst`, `fundiSlitið`) with timestamps.
Agendas: `agenda_items(lthing, fundur, seq, cls, nr, title, doc_nr, off_agenda)`. Idempotent by file sha; a changed file
replaces that sitting's children in one transaction.

**Matters.** List from the service (unchanged). Stubs from dump `<mál>` blocks (A and B). Detail from the service, A-mál only,
queue ordered newest session first; **re-fetch policy** in §5. `matter_sponsors(lthing, cls, nr, seq, abbr, member_id,
office, source)` from the dump. `matter_documents` ← dump `utbyting` (nr, type, distributed_at, sponsors) merged into
`documents` (service adds URLs/issued).

**Votes and ballots.** `votes` upsert by id from both sources; new columns `method_code`, `kind_code2` (`tegatkvgr`),
`unanimous`, `source`. Decode (from 157 counts, label mapping UNVERIFIED until joined to the service labels on the same ids):
`S` = atkvæðagreiðslukerfi (1,190; ballots present), `G` = yfirlýsing forseta / mál gengur (495), `K` (3), `N` = nafnakall (2,
ballots present), `E` (2), `Y` (1). `ballots(vote_id, member_id, choice)` from `<atkv skst gildi>` via `speaker_aliases`;
rows whose abbr is unresolved are parked in `ballots_unresolved(vote_id, abbr, choice)` and promoted by the derive step.
Service ballot fetch only as in §2.

**Committees.** Unchanged (service, 1 req/session). `speeches.nefnd` and `votes.nefnd` join on `committees.abbr`.

**Documents.** Ids/types/matter/sponsors from dump; URLs from matter detail; `thingskjol/?lthing=` once per session as the
reconciliation list (1 req). Text: v2 (service, 1 req/doc) — not in any dump; item 2 of the ask (§7).

**Laws.** New pipeline `ingest-laws`: fetch `nuna/allt.zip` (conditional; §5), unzip into `~/althingi/data/lagasafn/<edition>/`,
parse each `YYYYNNN.html` (iconv ISO-8859-1→UTF-8): `laws(year, nr, edition, title, in_force, ministry, html, text,
matter_lthing, matter_nr)` (PK `(year, nr, edition)`, `current` view = max edition), `law_amendments(year, nr, by_year,
by_nr, effective_text)` from the "Breytt með" list, `law_articles(year, nr, edition, article_id, heading, text)` from `G<n>`
anchors (lemmatized later, same analyzer). `/log/<year>/<nr>` then has text + history; `matter_laws` already links the
other direction.

**Absences, returns.** `absences(lthing, fundur, date, abbr, member_id, office, source)` from `fjarvist(ir)/`; `seat_returns`
from `inn/`. Display on member pages; used by nothing else.

**Change detection per source.** Dump: `dump_files(drop_id, lthing, dir, name, sha256, bytes, mtime, parsed_at,
parser_rev)` — a new drop is hashed (~330k files, minutes), diffed against the last drop, and only new/changed files are
parsed; `parser_rev` bumps force a reparse of one directory type without a refetch. Service: `raw_fetch` already records
sha256; a re-fetched list whose sha is unchanged is a no-op; a changed list is parsed and the diff (new ids, changed status)
feeds the per-item queue. Speech texts: `speeches.raw_sha256` (exists) — equal sha → skip. Lemma index: unchanged version
string `lemma-is@<ver>+<binsha>/r<INDEX_REV>`; ingest writes it as today, reindex keys on it as today. Nothing in this
design changes `lemma_text`/`lemma_seq`/`paragraph_tokens` semantics.

## 4. Schema: additive migrations (sketch, `sql/0006_ingest_layers.sql` …)

```sql
-- provenance
alter table speeches  add column text_source text, add column index_source text, add column source_ref text,
                      add column revised_at timestamptz, add column provisional boolean not null default false;
alter table votes     add column source text, add column method_code text, add column kind_code2 text, add column unanimous boolean;
alter table ballots   add column source text;
alter table documents add column distributed_at timestamp, add column source text;
alter table raw_fetch add column etag text, add column last_modified text, add column headers jsonb;

create table dump_drops (id serial primary key, zip_sha256 text, downloaded_at timestamptz not null, max_speech_ts timestamp, note text);
create table dump_files (drop_id int references dump_drops, lthing int, dir text, name text, sha256 text not null, bytes int,
  mtime timestamptz, parsed_at timestamptz, parser_rev int, primary key (lthing, dir, name));
create index dump_files_unparsed on dump_files (dir) where parsed_at is null;

create table speaker_aliases (abbr text, member_id int, n int not null default 0, first_seen date, last_seen date,
  primary key (abbr, member_id));
create table ministries (office_abbr text primary key, name text);
create table sittings (lthing int, fundur int, name text, starts timestamp, ends timestamp, source_ref text, primary key (lthing, fundur));
create table sitting_items (lthing int, fundur int, seq int, lid_id text, cls text, nr int, started timestamp, debate text,
  vote_flag boolean, primary key (lthing, fundur, seq));
create table sitting_events (lthing int, fundur int, at timestamp, kind text, cls text, nr int, primary key (lthing, fundur, at, kind, cls, nr));
create table agenda_items (lthing int, fundur int, seq int, cls text, nr int, title text, doc_nr int, off_agenda boolean,
  primary key (lthing, fundur, seq));
create table matter_sponsors (lthing int, cls text, nr int, seq int, abbr text, member_id int, office text, source text,
  primary key (lthing, cls, nr, seq));
create table ballots_unresolved (vote_id int, abbr text, choice text, primary key (vote_id, abbr));
create table absences (lthing int, fundur int, date date, abbr text, member_id int, office text, primary key (lthing, fundur, abbr));
create table seat_returns (lthing int, fundur int, date date, abbr text, member_id int, primary key (lthing, fundur, abbr));
create table speech_revisions (speech_id text, raw_sha256 text, seen_at timestamptz, source text, primary key (speech_id, raw_sha256));

create table laws (year int, nr int, edition text, title text, in_force text, ministry text, matter_lthing int, matter_nr int,
  html text, text text, lemma_text text not null default '', primary key (year, nr, edition));
create table law_amendments (year int, nr int, by_year int, by_nr int, effective_text text, primary key (year, nr, by_year, by_nr));
create table law_articles (year int, nr int, edition text, article_id text, heading text, text text, primary key (year, nr, edition, article_id));

create table ingest_runs (id bigserial primary key, kind text, started timestamptz default now(), finished timestamptz,
  requests int default 0, files int default 0, status text, note text);
```

`speeches.member_id` and `member_name` are `not null` today; the dump path needs unknown speakers → `alter table speeches
alter column member_id drop not null, alter column member_name drop not null` (pages fall back to `speaker_abbr`);
`type` and `debate` stay `not null` and are filled by the decode/`''` rules in §3; `xml_url` is constructed. `speeches.xml_url` is already nullable (0002). The `text_state` check stays.
All migrations are plain `alter/create`: no table rewrite, no lock on `paragraphs`, safe while the site serves.

## 5. Pipeline shape, cadence, re-runs

Commands (one script `scripts/ingest.ts <step>`, each step idempotent and resumable; `crawl.ts` steps survive as thin
aliases until removed):

| Step | Source | Lock | What it does |
|---|---|---|---|
| `dump hash [--drop PATH]` | disk | `dump` | hash every file into `dump_files` for a new `dump_drops` row; diff vs previous drop |
| `dump speeches` | disk | `dump` | parse unparsed/changed `raedur/`, then `spoluskjol/` (131–142) and `raedur_bradabirgda/` for ids still missing; sha no-op |
| `dump sittings` | disk | `dump` | `fundir`, `dagskra`, `lidaskjol` → sittings, items, events, agendas, votes, ballots, sponsors |
| `dump misc` | disk | `dump` | `utbyting`, `fjarvist(ir)`, `inn` |
| `service lists --from --to` | XML | `crawl` | sessions, members, matter list, document list, votes list, committees per session (≤ 6 req/session) |
| `service members` | XML | `crawl` | seats per member not yet fetched / stale (1 req each) |
| `service matters --lthing` | XML | `crawl` | matter detail queue (newest session first) |
| `service texts` | XML | `crawl` | speech files for `pending` rows not in any dump (post-drop speeches) |
| `service poll` | XML | `crawl` | `raedulisti/?dagur=today` (+ `atkvaedagreidslur/?dagur=today`) → new index rows → texts |
| `laws` | zip | `laws` | conditional GET of `nuna/allt.zip`; unzip; parse new edition |
| `derive` | DB | `derive` | aliases, member ids on speeches/ballots/sponsors, `reply_to_id`, timeline events |
| `post` | DB | — | `refresh materialized view concurrently vocab`, sitemaps regenerated, `cf cache purge` for touched URLs, `ingest_runs` closed |

Three advisory locks: `crawl` (746100, exists: one network client ever), `dump`, `derive`. Dump steps make no requests and
**must not** take the crawl lock, so a dump ingest and the service crawler run concurrently.

**Freshness rules.** A session is `closed` when `sessions.ends` is set and a dump drop newer than `ends` has been parsed:
nothing is refetched for it unless a later dump changes a file hash (then only that file). The current session is `hot`:
its lists are refetched nightly (sha compared, no-op when unchanged), its open A-matters' details weekly, its speeches
within the hour on sitting days. Matter detail re-fetch for the current session: nightly only for matters that appeared
in today's day list, votes list or `utbyting`; weekly for every A-matter whose `status_text` is not terminal
(`Samþykkt sem lög`, `Fellt`, `Vísað til ríkisstjórnar`, `Kallað aftur` — list to be confirmed from data); never for terminal
ones unless the matter list's sha changed.

**Conditional requests.** UNVERIFIED: `raw_fetch` stores no headers and `src/fetcher.ts` sends none, so there is no
evidence either way about ETag/Last-Modified on the XML service. Plan: record response headers (`headers jsonb`) from the
next run; send `If-None-Match`/`If-Modified-Since` on list endpoints when a stored validator exists; the first observed 304
confirms support, and until then sha comparison is the no-op mechanism (costs the request, saves the parse). Lagasafn
zip: same — a HEAD/conditional GET weekly, ≤ 1 req.

**Schedule (launchd on the mini, bash wrappers like `ops/watchdog.sh`; every run writes an `ingest_runs` row, logs to
`~/althingi/logs/ingest-<kind>.log`, exits ≠ 0 on 403/429 which the watchdog turns into a Telegram alert and which also sets
`ingest_state.crawl_paused_until` so no further network run starts for 24 h):**

| Run type | Cadence (launchd) | Steps | Expected requests | Expected duration |
|---|---|---|---|---|
| Sitting-day poll | every 30 min 09:00–24:00 on days where `dagskra/thingfundur/` listed a sitting (checked once at 08:30, 1 req) or a speech arrived in the last 24 h | `service poll` → `service texts` (new ids only) → `derive` (touched speeches) → `post` (purge day/matter pages) | 1 list + 0–60 new texts per poll; ≈ 20 list req + 100–400 text req per sitting day | 10 s – 6 min per poll; speeches visible ≤ 35 min after publication |
| Nightly | 03:10 | `service lists` (current session; sha no-op), `service matters` for matters touched today, `service members` for new members, `derive`, `post` (vocab MV, sitemaps) | 6 lists + 10–60 details + 0–5 seats ≈ 20–70 | 2–7 min network + ≤ 10 min MV refresh |
| Weekly | Sun 02:00 | `service matters` for non-terminal A-matters of the current session; `service lists` for the previous session (catches late edits); `laws` (conditional zip) | 300–700 + 6 + 1 ≈ 0.5–1 h | ≤ 1 h |
| Dump drop (manual trigger: human downloads zip, `rsync` to `~/althingi/xml-dump/<date>/`, runs `ingest dump-drop`) | ad hoc (ask Alþingi for monthly; §7) | `dump hash` → `dump speeches` → `dump sittings` → `dump misc` → `derive` → `post` | **0** | hash 330k files ≈ 5–10 min; first full drop ≈ 250k speeches at the measured ≈ 42 speeches/s from disk ≈ **1.7 h** of lemmatization; a later drop touches only changed files: minutes |
| Backfill (one-off, until done) | continuous in tmux, serial with the nightly/poll runs via the `crawl` lock | `service lists 131–156` → `service members` → `service matters 156→131` | 17,654 details + ≈ 450 seats + ≈ 150 lists ≈ 18k | ≈ 27 h of requests, spread over ~2 days because polls/nightly take the lock first |
| Reindex (only on `INDEX_REV`/lemma-is bump) | manual | `scripts/reindex.ts` | 0 | unchanged |

Request budget check: steady state ≈ 100–500 req/day on sitting days, ≈ 30/day otherwise, all at ≥ 5 s spacing from one
process; the sitting-day poll stays under the 20 list req/day already decided (DECISIONS persona revision 2).

**Idempotency and no-op detection, per layer:** dump file sha (`dump_files`) → speech sha (`speeches.raw_sha256`) → list sha
(`raw_fetch.sha256`) → matter detail sha (skip `upsertMatterDetail` when unchanged) → `derive` only over rows touched in
this run (`ingest_runs.id` stamped on touched rows via `updated_run_id`, or simply `fetched_at >= run.started`). Relemmatize
only when text sha changed; reindex never from ingest.

**Run driver on the mini.** `ops/ingest.sh <kind>` (bash; loads `~/althingi/.env`, `flock` on `~/althingi/run/<kind>.lock`
against double-start by launchd, then `bun scripts/ingest.ts …`), plists `com.jokull.althingi-ingest-{poll,nightly,weekly}`
(StartCalendarInterval), logs under `~/althingi/logs/`, watchdog gains: `ingest_runs` with `status='blocked'` → alert; no
successful poll on a sitting day for 2 h → alert; `crawl_paused_until` set → alert once.

**Post-ingest hooks** (`post`): `refresh materialized view concurrently vocab` (nightly and after a dump drop; not per poll),
sitemap files for touched sessions, `cf cache purge` by URL list (speech, matter, day, member pages touched; `/` and
`/nyjast/atom` always), `/healthz` reports `last_poll_at`, `last_dump_drop`, `unresolved_speakers`, `pending_texts`.

## 6. The running chain and the migration path

Chain now (tmux `althingi-crawl`, `backfill.log`): `text 158` (from mirror, done) → `reference 131–156` (in progress, ~1 min
per session) → committees/seats/index 131–156 → `text` from mirror → `matters 156→131`.

- **Keep running**: `reference`, `committees`, `seats` (cheap, their raw files are exactly L1 and are reused as-is: the
  new `service lists` step reads `raw_fetch` and skips anything with a fresh 200 on disk). `matters 156→131` is still
  required (not in the dump) and the new design's queue is the same `detail_fetched_at is null` queue — let it run.
- **Stop before it starts, or let it finish harmlessly**: `index 131–156` (≈ 450 per-member list requests ≈ 40 min) is
  made redundant by `dump speeches`, but its output is useful for `speaker_aliases` (member ids) and costs little; the
  decision is to let it run — it is the cheapest way to get ids for 131–156 and the dump pass is idempotent on top of it.
  The chain's `text` step from the mirror is also idempotent with `dump speeches` (same sha); whichever runs first wins,
  the other is a no-op per speech.
- Nothing in the raw cache is discarded. `~/althingi/xml-mirror` (raedur only) is superseded by a full dump copy at
  `~/althingi/xml-dump/2026-11-10/` (rsync 1.9 GB); the mirror path stays valid for the old `text` step until it is removed.

Migration without downtime (the web service reads with `althingi_ro`; all steps additive):

1. Apply `0006` (adds only; seconds). Deploy code that *writes* the new columns but pages that tolerate NULLs (they already
   do for `source`-less rows).
2. rsync the dump; run `dump hash` + `dump speeches` for 157/158 first (hours of zero-request work; `paragraphs` rows are
   only added for the ~320 missing speeches since existing shas match → no visible change except the DMK speeches appearing).
   Then `dump sittings`/`dump misc` for 157/158 → ballots, sponsors, sittings appear on pages that are already coded to
   render when rows exist (vote grid, sponsors) or in the next UI pass.
3. `derive` → DMK resolves to 1448, `reply_to_id` fills for 157/158.
4. Run `dump speeches` for 156→131 while the service chain continues on matter detail. `sessionState()` already keeps a
   session on short TTLs until `pending = 0`; dump-ingested sessions arrive with `text_state='done'` immediately, so the
   "complete" rule needs one more condition: `matters` detail coverage ≥ 95 % *or* the session is older than the last drop
   — otherwise sessions flip to immutable caching before their matter pages are filled. (Change in `src/queries.ts`, trivial.)
5. Replace the tmux chain with the launchd runs once the backfill `matters` queue is empty; the chain's remaining steps
   are then no-ops.

## 7. The request to Alþingi

Ask (email, Icelandic, referencing their pointer to `xmlfiles.zip`):

1. **Add to `xmlfiles.zip`, per session, the matter-detail XML** currently served one matter at a time at
   `thingmalalisti/thingmal/?lthing&malnr` (status, þingskjöl with URLs, atkvæðagreiðslur summaries, umsagnabeiðnir,
   erindi, tengd mál, lög til breytinga, efnisflokkar, framsögumenn, ræður) — e.g. `<lthing>/thingmal/<malnr>.xml`. This is
   the only remaining per-item crawl (≈ 17.7k requests for 131–156) and the one that loads their service.
2. **Þingskjöl text** (`thingskjal/?lthing&skjalnr` XML) per session, e.g. `<lthing>/thingskjol/<nr>.xml`.
3. **A manifest** at the zip root (`manifest.txt`: path, size, sha256, generated-at) so a drop can be diffed without
   re-hashing, and a stable "last built" timestamp in the file name or manifest.
4. **Regular rebuilds** (monthly, or after each session closes) at a fixed URL — and a note of the cadence in llms.txt.
5. **Bot-challenge exemption** for the UA `althingi-search/0.1 (jokull@solberg.is)` (or a token/alternate host) for the
   single `xmlfiles.zip` URL only, so the drop can be fetched by the nightly job instead of by a person. We will not use a
   solver; until exempted the download stays manual.
6. Confirm (no change needed) that per-member ballots in `lidaskjol/` and `raedur_bradabirgda/` are intended for reuse,
   and whether finals exist for the 3,663 provisional-only speeches of session 153. (We can also answer the 153 question
   ourselves for ≤ 50 requests: after the chain's `index` step lists 153, `text --lthing 153 --limit 50` on pending rows
   that have no dump file — the 404 rate says whether the service has finals.)

## 8. Decisions (owner, 2026-11-11; were the open questions)

1. **Dump drops stay manual.** A monthly browser download of `xmlfiles.zip` is the steady state until Alþingi exempts the
   link (§7.5). No solver, ever.
2. **Provisional texts are indexed and searchable**, flagged `provisional` (shown as "bráðabirgðatexti" on pages and as
   `provisional: true` in MCP results), and replaced when the final text arrives from any later source.
3. **`spoluskjol` is ignored** for now (no `dump-spola` pass).
4. **Laws: metadata + amendment graph first.** Article text is stored (`law_articles`), not lemmatized or searchable yet.
5. **`speeches.member_id` is nullable**; unresolved speakers show as abbreviation-only rows.
6. **The per-member speech list stays as a weekly reconcile** for the current session only (`service index`).
7. **Weekly re-fetch of non-terminal current-session A-matters is accepted** (≈ 300–700 req/week).

## 9. Implementation notes (where the build deviates from or corrects the text above)

- **NFD (§1 invariant 1) not reproduced**: a byte-level search for combining marks (U+0300–U+030F) over every dump file,
  the fixtures and the DB found none. Abbreviations are still NFC-normalised on every write and join; the NFD test
  fixture is synthetic (a real dump file with its `skst` decomposed).
- **`vod` is not in matter detail** (§3): `fixtures/r157_1.xml` is a per-matter `ræðulisti`, not a matter detail;
  `thingmal_157_1.xml`'s `<ræður>` block has 0 `<vod>`. `vod_url` fills from day lists (`service poll`) and speech lists only.
  Matter detail `<ræður>` still gives member ids (incl. non-MP ministers).
- Speaker evidence is kept in `speaker_sightings(speech_id, member_id, source)`; `speaker_aliases` is rebuilt from it by
  `derive`. Legacy rows (`index_source` NULL) count as service rows; no backfill update of 250k rows.
- `tegr` decode adds `B` = "ber af sér sakir" (6 rows in 157 joined to the service label), so nothing is `óþekkt (B)`.
- lidaskjol `umr` → `speeches.debate` strips the trailing `f` (`1f` → `1`); the raw value stays in `sitting_items.debate`.

# Persona sweep — 100 tasks run against the live system (2026-11-11)

Method: every task in `test/golden/personas.json` was run the way that persona would (web search box as typed, URL filters, tabs, entity pages, feeds/CSV, or MCP `tools/call` for the agent personas) against the live site through the tunnel (`localhost:3051`). The harness is reproducible: `BASE=http://localhost:3051 bun scripts/persona-sweep.ts out.json` (one entry per task; the probes are also summarised in the "what I did" column). Screenshots via agent-browser for the search page states.

Corpus at sweep time: session 157 only, speech text **2025-09-11 → 2026-06-19** (11,9xx speeches, a few still pending), matter detail for all 729 A-mál, vote summaries (1,740), 1,542 document ids, consultations/submissions, seats for 157–158. **Session 158 (from 2026-09-08) has no speech text yet, so every "today / this week / yesterday / October 2026" task is corpus-limited by definition**; the mechanism was tested separately on a real date (2026-06-19 / 12 June). Per-member ballots, document text, sponsors and pre-2026 sessions are not loaded.

Verdicts: **works** · **partial** · **fails** · **corpus-limited** (fails only because the data is not loaded yet) · **out-of-scope** (decided out, or not in the source). Root cause: **L** lemma-is · **R** ranking/recall in our search · **Q** query parsing/routing · **U** UI/UX/IA · **D** missing data/feature.

## Counts

| | works | partial | fails | corpus-limited | out-of-scope |
|---|---|---|---|---|---|
| before | 21 | 42 | 17 | 17 | 3 |
| after (deployed, re-run) | 37 | 31 | 4 | 25 | 3 |

After the fixes, what is left is mostly data that is not crawled yet: ballots, document text, sponsors, sessions before 157, and session 158 text. The "after" column was re-run against the deployed site; notes say what changed.

## Table

| id | what I did | before | after | class | note |
|---|---|---|---|---|---|
| P01-01 | `veiðigjöldin umræða í dag`; same with real day 2026-06-19 + nýjast; `veiðigjöldin nýjast` | partial | corpus-limited | Q, corpus | "í dag" searched as the word *dagur*, "umræða" ANDed as a content word, "nýjast" searched as *nýr*. Today has no text (158 not loaded). URL filters `fra/til/nyjast` work. After: read as *veiðigjald* + today (dropped "umræða"); empty state says the newest text is 19 June 2026 and links the last sitting day and the same search without dates. |
| P01-02 | full question; `Kristrún Frostadóttir Landspítali`; `Landspítali&thm=1417` | fails | corpus-limited | Q, U | Names and "í þessari viku" go into FTS (`kristrún & frostadóttir & … & vika`) → 0 hits. Banner wrongly says "no member is called 'Kristrún Frostadóttir Landspítali'… similar names that are not the same person: Kristrún Frostadóttir". With `thm=` it works (2 hits). After: member filter + this week + *landspítali* (screenshot a1, with the date removed: 2 hits). Only blocked by 158 having no text. |
| P01-03 | speech page cite box | works | works | | Cite string + Afrita + `#mgr-N` anchors. |
| P01-04 | `orkuskortur` newest; "Hver sagði fyrst orkuskortur"; MCP `first_use` | partial | works | U, Q | MCP answers (Bergþór Ólason 2025-10-09). Web has no oldest-first sort; banner says "orkuskortur finnst ekki í safninu" above 8 hits (stale `vocab` MV). After: "Hver sagði fyrst …" → oldest first (Bergþór Ólason 9.10.2025 at rank 1, same as `first_use`); "Elst" sort added; false banner gone. |
| P01-05 | `Flokkur fólksins atkvæði 300. mál`; matter page | partial | corpus-limited | Q, D(ballots) | Matter page shows 36 vote summaries. Typed query → 0 hits: the "300. mál" inside a sentence is neither routed nor used as a matter filter; party name searched as words. Party grid needs ballots (not crawled). After: redirects to `/mal/157/a/300#atkvaedi`. The party grid still needs ballots. |
| P01-06 | `Inga Sæland fundarstjórn október 2026`; URL `thm+tegund=um fundarstjórn`; MCP aggregate | fails | corpus-limited | Q, U, D, corpus | Typed: name leak → 0. No "um fundarstjórn" type chip, no result count anywhere. Correct answer for 157 is 0 (aggregate). October 2026 has no text. After: member + `um fundarstjórn` + October 2026, with a result count; "Fundarstjórn" type chip. Empty only because Oct 2026 has no text. |
| P01-07 | `/mal/157/a/300/atom` | fails | works | D | 404; only search and global feeds exist. After: `/mal/157/a/300/atom` (speeches, documents, votes) linked from the matter page. |
| P01-08 | `forsætisráðherra andsvar Sigmundur Davíð`; `q=Sigmundur Davíð&tegund=andsvar&embaetti=forsrh.` | fails | partial | Q, D | With filters set, the name query still **302s to the member page** and drops the filters. andsvar→parent is not modelled (`reply_to_id` empty). After: office forsrh. + andsvar + "Sigmundur Davíð" kept as words (the addressee); no member redirect with filters. 0 hits: the PM has 5 andsvör in 157; reply-to is not modelled. |
| P01-09 | `"þetta er lygi"` | partial | partial | L, by design | Phrase works, but *lygi* is read as the verb *ljúga* (same on both sides, so it matches). Interjections are not searchable; that is only said on the zero-hit page. |
| P01-10 | speech page | partial | partial | D | `vod_url` is NULL for all 11,974 speeches; only "Hljóð" (mp3 with start/end) shows. Parser reads `vod` but the source evidently uses another field (crawler, not touched). |
| P02-01 | MCP search `hælisleitendur` + member 1332 / 1417 | partial | works | D | 0 hits + `why` + corpus block (ILIKE confirms 0). No `total` field. After: `total: 0` + `why`. |
| P02-02 | MCP + web `"ekki er allt sem sýnist"` | works | works | | 1 hit, Njáll Trausti 2026-03-18, ids + urls. |
| P02-03 | `þskj. 421` → `/thingskjal/157/421`; `list_votes` 300 | fails | corpus-limited | Q, D | Route target **404s** (no handler). Ballots not crawled; votes do not expose `doc_nr`. After: `/thingskjal/157/421` page (type, matter, althingi.is html/pdf, votes on that document); `list_votes` has `document_nr` and a `doc_nr` filter. Ballots missing. |
| P02-04 | MCP `"fyrir áramót"` capacity=ráðherra; web | works | works | | MCP 8 hits. Web has no way to say "minister" except the hidden `hlutverk=` param. |
| P02-05 | MCP aggregate by lthing `neyðarástand` | corpus-limited | corpus-limited | corpus | 157 only (22). No per-10k normaliser. |
| P02-06 | MCP explain `lán` | works | works | | |
| P02-07 | MCP search limit 5 + get_context | works | works | | Cite strings with `#mgr-N`. |
| P02-08 | `list_votes` 2026-06-12 + speech times | works | works | | |
| P02-09 | `get_speech` revision block | partial | partial | D | sha256 + fetched_at exposed, no history. |
| P02-10 | MCP 1998 date range; web | corpus-limited | corpus-limited | corpus, U | `why` lists generic reasons, not "date range before the text corpus". After: `why` starts with `date_range_before_first_speech_in_corpus`; web empty state names the year. |
| P03-01 | `húsnæðismál&flokkur=38&thing=157`; `Samfylkingin húsnæðismál` | partial | works | Q | URL party filter works; party name typed in the query is searched as the word *samfylking*. After: "Samfylkingin húsnæðismál" → party filter (25 speeches, same as the URL form). |
| P03-02 | `stjórnarandstaðan fjárlög 2026`; `fjárlög 2026` | partial | partial | out-of-scope (opposition set) | Matter cards + hits fine; government/opposition is not modelled. |
| P03-03 | member page; `Inga Sæland fyrirspurn&t=mal` | fails | fails | D | Sponsors/askers of written questions not modelled. |
| P03-04 | `412. mál` → matter page | works | works | | |
| P03-05 | matter page; `umsagnir 300. mál` | partial | works | Q, U | Matter page gives counts + request list; the 17 senders are in `submissions` but not listed. Typed query → 0 hits. After: matter page lists the 17 senders with kind/date/PDF; "umsagnir 300. mál" → `#umsagnir`. |
| P03-06 | MCP aggregate by member `leikskóli` | corpus-limited | corpus-limited | corpus | Works for 157; "síðan 2021" needs backfill. |
| P03-07 | `/leit.csv?…embaetti=forsrh.&fra&til`; `forsætisráðherra síðustu viku` | partial | works | Q | CSV fine; "síðustu viku" → *síðari & vika*; office has no UI. After: "forsætisráðherra síðustu viku" → office + last week; CSV takes the same URL. |
| P03-08 | `Bergþór Ólason andsvar`; `thm=1327&tegund=andsvar` | partial | partial | Q, U, D | Typed query: wrong "no such member" banner (screenshot s1). URL form works. Reply-to not modelled. After: Bergþór's andsvör (113) via member + type; who they answered is still not modelled. |
| P03-09 | `Jakob Frímann` | corpus-limited | corpus-limited | corpus | Not a 157 member; did-you-mean offers *frí, frír*. |
| P03-10 | `gær`; `/dagur/2026-11-10`; `/dagur/2026-06-19` | partial | partial | Q, corpus | "gær" is a word; day page works; yesterday had no text. |
| P04-01 | `lög nr. 34/1991` → law page | works | works | | |
| P04-02 | `þskj. 512` → 404; `nefndarálit meirihluta 300. mál` | fails | corpus-limited | Q, D, corpus | 404 route; doc text not crawled. After: document page with althingi.is links. Text not crawled (WP8b). |
| P04-03 | matter page by stage | works | works | | Flutningsræða under "1. umræða". After: typed question → minister's flutningsræða at 1. umræða within 300 (1 hit, Hanna Katrín Friðriksson 14.1.2026). |
| P04-04 | `212. mál` | works | works | | |
| P04-05 | `stjórnsýslulög` 2020–2026 | corpus-limited | corpus-limited | corpus | Mechanism works. |
| P04-06 | matter page "Tengd mál" | works | works | | |
| P04-07 | matter page Umsagnir | works | works | | |
| P04-08 | matter page; `get_matter` | partial | partial | D | No sponsors; the 1. umræða flutningsræða speaker + office is the only proxy. After: committee + rapporteurs shown; sponsors still not modelled. |
| P04-09 | `/mal/157/a/300/umraeda` | fails | works | D | 404, no transcript/print view. After: `/mal/157/a/300/umraeda`, every speech in order with stage headings and party at date. |
| P04-10 | `meðalhóf` within a/300; `meðalhóf 300. mál` | partial | works | R, Q | *meðalhóf* expands to `meðalhóf \| hefja \| hóf \| hófur`; the typed form takes 959 ms and ANDs "mál". After: `meðalhóf` only (2 focused hits, 40 ms vs 959 ms). |
| P05-01 | `vindorka vindorkuver&nyjast=1`; `… nýjast fyrst` | partial | works | Q, U | URL form works; typed "nýjast fyrst" → 0 hits; false "vindorkuver finnst ekki" banner. After: "nýjast fyrst" → sort; 10 hits; no false banner. |
| P05-02 | `/leit/atom?q=rammaáætlun` | works | works | | |
| P05-03 | matter 412; `hverjir studdu 412. mál` | corpus-limited | corpus-limited | D(ballots), Q | 412 is a fyrirspurn (no votes); typed query → 0. |
| P05-04 | MCP aggregate by party `loftslag` | corpus-limited | corpus-limited | corpus | 157 only; no normaliser. |
| P05-05 | `umhverfis- og samgöngunefnd` (+ Nefndir tab) | partial | works | U, D | Committee found; its link opens a text search of consultation recipients, no committee page with deadlines. After: `/nefnd/<id>` with open deadlines first, then older matters with request/submission counts. |
| P05-06 | `Hvalárvirkjun` | works | works | U | 10 hits, but a false "finnst ekki í safninu" banner sits above them. After: banner gone. |
| P05-07 | `umhverfisráðherra Landvernd`; `Landvernd&embaetti=umhv.` | partial | partial | R, Q, U | Query side expands *umhverfisráðherra* to `… \| umhverfi \| ráðherra` (any minister); office not read from the words. After: office umhv. + *landvernd*: 0 (the minister never named Landvernd in 157 text); "Leita orðrétt" gives the old 4 hits. |
| P05-08 | `Umhverfismál` (+ Efnisflokkar tab) | fails | works | U, D, R | Efnisflokkur link goes to a title search, not to the matters in that category. *umhverfismál* expands to `… \| mál` (matches nearly everything; 560 ms). After: `/efni/<id>` (e.g. *Umhverfisstjórn og náttúruvernd*: 93 matters, 13 passed as law); *umhverfismál* no longer ORs *mál* (41 hits). |
| P05-09 | `/leit.csv?q=strandveiðar&fra=2024…` | works | works | corpus | 54 rows (157 only). |
| P05-10 | `náttúruvernd&t=mal` | partial | corpus-limited | D, corpus | No category × status browse. After: topic page counts matters passed as law; 2023–2025 needs backfill. |
| P06-01 | `lög nr. 90/2018` → law page | partial | partial | D | Matters listed; no document text. |
| P06-02 | `þskj. 421 á 157. þingi`; `þskj. 157/421` | fails | partial | Q, D | The natural form is not routed; the routed form 404s. After: routed, and the page exists; text not crawled. |
| P06-03 | `"2. gr."` in a/300 with/without `hlutverk=framsögumaður nefndarálits` | partial | partial | D, U | No framsögumaður speech on 300; committee rapporteurs exist in `matter_rapporteurs` but are not shown. After: rapporteur Arna Lára Jónsdóttir shown on the matter page; she has no speech on 300 in the corpus. |
| P06-04 | matter page | partial | works | D | Docs, votes, speeches in three tables; no single timeline. After: "Ferill málsins" timeline (documents, debate starts, votes collapsed per day). |
| P06-05 | `bótaábyrgð skaðabótalög nr. 50/1993`; law page | partial | partial | Q, U | Law ref inside a sentence not routed (Lög card shown); false "finnst ekki" banners. After: false banners gone; a law ref inside a sentence is still not routed (Lög card shown). |
| P06-06 | matter page votes | corpus-limited | corpus-limited | D(ballots) | Counts + result; names need ballots. |
| P06-07 | speech cite box | partial | partial | D | One house style; no Alþingistíðindi format. |
| P06-08 | law page | works | works | | |
| P06-09 | `innanríkisráðherra útlendingalög 2012`; `útlendingalög&embaetti=innvrh.` | corpus-limited | corpus-limited | corpus, R | 2012 not loaded; *innanríkisráðherra* expands to `inna \| inni \| ríkisráðherra`. |
| P06-10 | `svar við skriflegri fyrirspurn`; `tegund=svar` | corpus-limited | corpus-limited | D | Written answers are documents (text not crawled); `svar` = oral answers only. |
| P07-01 | MCP aggregate by party `Evrópusambandið` | corpus-limited | corpus-limited | corpus | |
| P07-02 | — | corpus-limited | corpus-limited | D(ballots) | |
| P07-03 | MCP words by party | out-of-scope | out-of-scope | | Gender not in source. |
| P07-04 | `Steingrímur J. Icesave 2009` | corpus-limited | corpus-limited | corpus, U | No hint that 2009 is outside the loaded text. After: empty state says 2009 is not in the corpus. |
| P07-05 | `/leit.csv?q=kvótakerfi` | works | works | | party_at_date column. |
| P07-06 | MCP aggregate by party; `fullveldi&flokkur=47` | partial | partial | D | No compare view; numbers for 157 only. |
| P07-07 | `EES-samningurinn 1992` | corpus-limited | corpus-limited | U | Hits are 2026 speeches mentioning 1992, no boundary note. After: soft notice that 1992 speeches are not in the corpus and the year is matched in text. |
| P07-08 | MCP `list_sessions`; `/thing/157` | partial | partial | D | MCP fine; session page 404. |
| P07-09 | `Björt framtíð` → party page | corpus-limited | corpus-limited | corpus | Seats for 2013–16 not loaded. |
| P07-10 | speech cite box | partial | partial | D | No APA variant. |
| P08-01 | MCP `verðbólga` 30 days limit 100; `/leit.json` | partial | works | D | MCP returns 25 per call despite `limit: 100`; `/leit.json` 404. After: MCP `limit: 100` returns 100 (was 25) + `total: 870`; `/leit.json` with total + cursor. |
| P08-02 | `/thing/157/atkvaedagreidslur.csv`; `list_votes` limit 200 | fails | corpus-limited | D | No CSV; MCP pages of 200 with no cursor. After: `/thing/157/atkvaedagreidslur.csv` (1,740 summaries); `list_votes` pages with `after_id`. Ballots missing. |
| P08-03 | `/mal/157/a/300/atom` | fails | works | D | 404. After: matter Atom. |
| P08-04 | MCP words by party, one week | partial | partial | D | Words, not minutes. |
| P08-05 | — (not load-tested) | partial | partial | | In-process limit is a placeholder. |
| P08-06 | `/gogn` | out-of-scope | out-of-scope | D | Phase 2 dumps. |
| P08-07 | MCP explain | works | works | | |
| P08-08 | speech page; `r2026-…` alias | partial | partial | D | No source (althingi.is) link on the speech page; alias 404. |
| P08-09 | MCP aggregate member `störf þingsins`; web | partial | partial | Q | Counts speeches *containing the words*, not speeches under the B-mál "störf þingsins". |
| P08-10 | `/nyjast/atom` | works | works | | |
| P09-01 | `/ord/lán` | fails | fails | D | WP12. |
| P09-02 | MCP aggregate by year ×2 | partial | partial | corpus | |
| P09-03 | `á` | out-of-scope | out-of-scope | | Morph facets kept out. |
| P09-04 | `lán` | partial | partial | D | Compound browser kept out; parts are indexed. |
| P09-05 | MCP `first_use gervigreind`; web | works | works | U | Web has no oldest-first. |
| P09-06 | `sko` | partial | partial | D | Hits, no KWIC. |
| P09-07 | `/raeda/…json` | fails | fails | D | |
| P09-08 | member page | fails | fails | D | No profile. |
| P09-09 | MCP explain `"fyrst og fremst"` | works | works | L | Explains the reading: *fremst → fremur*. |
| P09-10 | `"meika sens"`; `meika` | partial | partial | L | Phrase hit via *sens → sen*; no frequency view. |
| P10-01 | `hvað sagði þingmaðurinn minn um leikskóla` | partial | works | Q | Question words ANDed (`segja & þingmaður & leikskóli`): recall cut to speeches containing "said" and "MP". After: "hvað sagði þingmaðurinn minn" dropped and shown ("slepptum: …"); 124 hits = same as `leikskólar`. |
| P10-02 | `Norðausturkjördæmi` | partial | partial | D | Only text hits; no constituency listing. |
| P10-03 | `hvað er andsvar`; `/um` | fails | works | D | No glossary. After: glossary entry above the results + `/um#ordskyringar` (14 terms with English glosses), footer link. |
| P10-04 | `áfengi í matvöruverslunum`; `áfengi&t=atkvaedi` | corpus-limited | corpus-limited | D(ballots), R, U | Typed → 0 hits with a false "áfengi finnst ekki í safninu" banner (78 paragraphs contain it). |
| P10-05 | `áfengi matvöruverslun`; `áfengi&t=mal` | partial | partial | R, U | 0 hits, no fallback to fewer words; matter 334 *verslun með áfengi og tóbak* not surfaced. After: false banner gone; per-word links in the empty state. Matter 334 still not surfaced (title AND). |
| P10-06 | `þskj. nál. frv. á ensku`; `/en` | fails | partial | D | After: the glossary has þskj./nál./frv./brtt./fsp. with English glosses; the typed query itself does not reach it. |
| P10-07 | speech page | partial | partial | D | Audio only (no vod_url). |
| P10-08 | `Katrín Jakobsdóttir forsætisráðherra 2017` | corpus-limited | corpus-limited | corpus, U | |
| P10-09 | speech page | partial | partial | D | Cite copy works; no OG tags. |
| P10-10 | `/`, `/leit` (skip link, landmarks, lang) | partial | partial | | No a11y tooling run. |

## Root causes that recur (before)

1. **Free-text intent is searched as words (Q)** — names, party names, "í dag/gær/síðustu viku", "nýjast fyrst", "hvað sagði", "300. mál", "þskj. 421 á 157. þingi", minister titles. Hits P01-01/02/05/06/08, P03-01/07/08/10, P04-10, P05-01/03/07, P06-02, P10-01 (16 tasks, 6 personas).
2. **Stale `vocab` materialized view (U)** — "X finnst ekki í safninu" above real hits: P01-04, P05-01, P05-06, P05-07, P06-05, P10-04/05. `vocab` has 12.7k words, built early and never refreshed.
3. **Known compounds leak their parts into the query (R)** — `queryGroupsStructured` matched the lemma-is token by set *equality*; lemma-is adds junk part strings (*umhverfis*) and stopword parts (*meðal*), so the match failed and the raw group (whole word OR every part) was used: *umhverfismál → … | mál*, *umhverfisráðherra → … | ráðherra*, *meðalhóf → … | hefja*, *innanríkisráðherra → … | inna*. P04-10, P05-07, P05-08, P06-09.
4. **Routes that exist in the plan but 404 (D)** — `/thingskjal`, `/mal/…/atom`, `/mal/…/umraeda`, `/efni`, `/nefnd`, `/thing`.
5. **Name redirect ignores filters (Q)** — P01-08.

## Fixes made (deployed 2026-11-11, `bun test` 112 pass, `tsc` clean)

Each is marked **general** (a rule that applies to any query/page) or **curated** (a small table, used only where a rule would misfire).

| # | Fix | Kind | Files | Tasks it moved |
|---|---|---|---|---|
| 1 | **Query understanding** (`interpret`): reads members (≥2 consecutive name words, inflection-tolerant prefix match against the members table), parties (all name words, inflected), relative dates (í dag/gær, þessari/síðustu viku, síðustu N daga, mánuður, *month year*, árið N, N–M, frá/síðan N), sort words (nýjast fyrst, elst fyrst, "sagði fyrst"), debate stage ("1. umræða"), matter refs inside a sentence ("300. mál á 157. þingi"), and question filler (hvað sagði…, þingmaðurinn minn, "umræða" next to a topic). Result: a 302 to the bookmarkable filter URL, a "Lesið sem: … · Leita orðrétt í staðinn" line (escape hatch `ordrett=1`), removable chips. A speaker title + a name keeps the name as text (the addressee). Lone names/party names/type words stay as before. | general rules + curated tables: minister titles → `office` prefix (13 rows), speech-type words (3), matter-section words (4), Viðreisn needs a capital | `src/intent.ts` (new), `src/web.tsx` | P01-01/02/04/05/06/08, P02-04, P03-01/05/07/08, P04-03/10, P05-01/03/07, P10-01 |
| 2 | **Browse mode**: filters with no words list the filtered speeches (newest first) instead of nothing; **Elst** (oldest-first) sort; **result count** (exact ≤ 10k) on the page, in `/leit.json` and MCP `total`. | general | `src/search.ts`, `src/pages.tsx` | P01-04/06, P02-01, P03-08, P04-03, P08-01 |
| 3 | **Known compounds no longer leak parts into the query**: match the lemma-is token by subset (whole-word reading ∈ group ⊆ readings) instead of set equality; multi-word ellipsis lemmas split + stopword-filtered like the index side. Query side only, no reindex. | general | `src/lemma.ts` | P04-10 (959 → 40 ms, 2 focused hits), P05-07, P05-08, P06-09 |
| 4 | **No false "finnst ekki í safninu"**: did-you-mean only on zero hits, and "known" is checked against the live index (the `vocab` MV is stale: 12.7k words, never refreshed). | general | `src/suggest.ts`, `src/web.tsx` | P01-04, P05-01/06/07, P06-05, P10-04/05 |
| 5 | **Name redirect respects filters**: a member name with filters set stays on the search page. | general | `src/web.tsx` | P01-08 |
| 6 | **Empty states that explain**: date range after the last text (link to the last sitting day + same search without dates), before the first text, years before the corpus (also as a soft note when hits exist), per-word "try one at a time" links. MCP `why` gains `date_range_after/before_…`. | general | `src/pages.tsx`, `src/mcp-tools.ts` | P01-01/02/06, P02-10, P03-07, P07-04/07, P10-05 |
| 7 | **Routes that 404'd**: `/thingskjal/<l>/<nr>` (type, matter, althingi.is html/pdf, votes on that document), `/mal/…/atom` (speeches + documents + votes), `/mal/…/umraeda` (whole debate, print view), `/efni/<id>`, `/nefnd/<id>` (open deadlines first), `/leit.json`, `/thing/<l>/atkvaedagreidslur.csv`. Entity links for topics/committees now go to these pages. "þskj. 421 á 157. þingi" routes. | general | `src/web.tsx`, `src/queries.ts`, `src/pages.tsx`, `src/entities.ts`, `src/route.ts` | P01-07, P02-03, P04-02/09, P05-05/08, P06-02, P08-01/02/03 |
| 8 | **Matter page**: committee, rapporteurs (`matter_rapporteurs`), list of submission senders, "Ferill málsins" timeline (documents, debate starts, one line per vote day), Atom + transcript links. | general | `src/queries.ts`, `src/pages.tsx` | P03-05, P04-08, P06-03/04 |
| 9 | **Type chips** gain *Svör ráðherra* and *Fundarstjórn*; active chips name the member (not "Einn þingmaður"), and show `hlutverk`/other types. | general | `src/pages.tsx` | P01-06, P06-10 |
| 10 | **Glossary**: 14 terms with English glosses at `/um#ordskyringar` (footer link); "hvað er X" shows the entry above the results. | curated (content) | `src/pages.tsx` | P10-03/06 |
| 11 | **MCP**: `search_speeches` honours `limit ≤ 100` (was capped at 25 silently) and returns `total`; `sort: oldest`; `list_votes` returns `document_nr`, filters by `doc_nr`, pages with `after_id`. | general | `src/mcp-tools.ts`, `src/mcp.ts` | P02-01/03, P08-01/02 |

New tests: `test/intent.test.ts` (7), `test/web.test.ts` (persona-sweep fixes: intent redirect + escape hatch, filters never redirect, browse, oldest, JSON total, matter-section redirect, document/transcript/feed/topic/committee pages, no banner above hits, glossary, votes CSV, MCP total/why/document_nr), `test/lemma.test.ts` (compound parts never free alternatives), `test/route.test.ts`.

Bug found on the way (fixed): `left(text, 300)` on `paragraphs.text` raised `invalid byte sequence for encoding "UTF8": 0xc3` for a matter-300 paragraph (the Atom feed 500'd). The truncation now happens in JS. Some stored paragraph text evidently contains a broken UTF-8 sequence; worth a one-off `select id from paragraphs where convert_to(text,'UTF8') …` hunt by the crawler owner.

## lemma-is findings

Scope per the owner: only findings that demonstrably hurt a persona task, with evidence; where the fix belongs in althingi it says so. Verified with a bun script that loads `BinaryLemmatizer.loadFromBuffer(data-dist/lemma-is.bin)`, `CompoundSplitter(lem, createKnownLemmaSet(lem.getAllLemmas()), { mode: "balanced" })`, then `processText`/`extractIndexableLemmas`, against **npm 0.12.0** (what the site runs) and **`~/Code/lemma-is` branch `batch/althingi-fixes` @ 68b5b34**. Script: scratchpad `pt.ts` (`LSRC=…/lemma-is/src/index.ts LBIN=…/data-dist/lemma-is.bin bun pt.ts <words>`).

| # | Word (task) | Expected | Actual (npm 0.12.0) | Branch @68b5b34 | Harm shown | Where to fix |
|---|---|---|---|---|---|---|
| L1 | *umhverfismál*, *umhverfisráðherra* (P05-08, P05-07) | parts `umhverfi`, `mál` / `ráðherra` | `compoundSplit.parts` = `umhverfi, umhverfis, mál`: **`umhverfis` is the genitive surface form, not a lemma**, and it is listed among `t.lemmas` | same (`umhverfis` still there) | Our query side failed to recognise the token as a known compound and ORed every part: *umhverfismál* matched any paragraph with *mál* (P05-08, 560 ms, "41 vs nearly all"), *umhverfisráðherra* any *ráðherra*. | **Fixed in althingi** (query-side subset match, fix 3). lemma-is: drop non-lemma genitive stems from `parts` (they are also indexed at weight D as the lexeme `umhverfis`, harmless but junk). |
| L2 | *meðalhóf*, *innanríkisráðherra* (P04-10, P06-09) | parts `meðal`, `hóf` / `innanríki(s)`, `ráðherra` | `meðalhóf` → parts `meðal, hefja, hóf, hófur` (stopword `meðal` + the verb *hefja* via past tense *hóf*); `innanríkisráðherra` → `innan, inna, inni, ríkisráðherra` | `meðalhóf` same; `innanríkisráðherra` → `innan, inna, ríkisráðherra` | Same mechanism as L1: the query became `meðalhóf \| hefja \| hóf \| hófur` (P04-10: 10 noisy hits, 959 ms; after the althingi fix 2 focused hits, 40 ms). | **Fixed in althingi.** On the index side the extra parts sit at weight D; over-indexing is acceptable per the owner, so no lemma-is change is requested for this. |
| L3 | *umhverfis- og samgöngunefnd* (P05-05) | ellipsis compound → `umhverfisnefnd` + `samgöngunefnd` (or the phrase kept whole) | lemmas `umhverfis- og samgöngunefnd`, `umhverfi`, `umhverfis`, **`" og samgöngunefnd"`** (leading space, contains the stopword *og*) | same | The committee name searches as `samgöngunefnd \| umhverfi` → 1,089 speeches (an OR; before the althingi split it also asked for the lexeme "og samgöngunefnd"). The committee *entity* is found, so the user still gets the committee page. | lemma-is: emit the expanded first conjunct (`umhverfisnefnd`) and the head (`samgöngunefnd`) as separate lemmas, no multi-word strings. althingi (next step): treat a hyphen-ellipsis token as an implicit phrase/AND. |
| L4 | *lögreglustjóraembættin*, *ríkislögreglustjóri* (EVAL-phase0 q13; P06 lawyers' "lögregla" queries) | recursive parts incl. `lögregla` (and `stjóri`) | `lögreglustjóraembætti` → parts `lögreglustjóri, embætti` (no `lögregla`); `ríkislögreglustjóri` → `ríkislögregla, stjóri, stjóra` | `lögreglustjóri, embætti` (still no `lögregla`); `ríkislögregla, stjóri, stjóra` (`stjóra` junk still present) | q13 ranked the substantive police paragraph below rank 5 (EVAL-phase0: one `lögregla` position for four mentions). | lemma-is (already on the branch's list: recursive splitting and junk parts like *stjóra* — **not yet effective at 68b5b34** for these two words). |
| L5 | *vindorkuverkefna* (P05-01) | whole-word lemma `vindorkuverkefni` | lemmas `vindorkuverkefna, `**`vindorkuverkefn`**`, vindorka, verkefni` (a truncated non-word) | same | The truncated form entered `vocab` and was offered as a did-you-mean ("Áttirðu við vindorkuverkefn…") on the P05-01 page. Minor since fix 4 hides did-you-mean above hits. | lemma-is: for an unknown compound, rebuild the whole-word lemma from head lemma (`vindorka` + `verkefni` → `vindorkuverkefni`) instead of stripping an ending. |

Checked and **not** reported (no task was hurt; over-indexing is acceptable): *lygi* → `ljúga` first in "þetta er lygi" (P01-09; phrase still matches because both sides agree), *fremst* → `fremur` (P09-09; the explain tool shows it, 586 correct phrase hits), *sens* → `sen` (P09-10; phrase still hits), *Inga* → `ingi` only (names now go through the member filter), *Sigmundur* → part `mundur` (weight D, no visible effect), *verðbólga* → parts `verður/verða/verja` (query side already ignores parts of known words).

## Remaining gaps, ranked by persona impact (Σ weight of tasks still not "works")

| Rank | Gap | Tasks (weight) | Recommended next step |
|---|---|---|---|
| 1 | **Session 158 text / freshness** — every "today / this week / yesterday" task is empty; latest text is 19.6.2026 while 158 started 8.9.2026. | P01-01/02/06, P03-07/10, P08-10 (≈ 15 w) | Crawler: ingest 158 (seats already there) and the 30-min sitting-day poll from DECISIONS §WP8. No search change needed: the filters and empty state are ready. |
| 2 | **Per-member ballots** | P01-05, P02-03, P05-03, P06-06, P07-02, P08-02, P10-04 (≈ 15 w) | Crawl 157 ballots (~1.5k req, plan item 1); `/atkvaedagreidsla/<id>` grid by party-at-date; MCP `get_vote`. Document pages and `document_nr` are already in place to hang it on. |
| 3 | **Backfill 156→131** | P02-05, P03-06/09, P04-05, P05-04/10, P06-09, P07-01/04/07/09, P10-08 (≈ 18 w, mostly w1–2) | WP10 as planned; no redesign needed. |
| 4 | **Reply-to (andsvar → parent) not populated** (`reply_to_id` 0 rows) | P01-08, P03-08 (6 w) | Fill `reply_to_id` (inferred: previous non-andsvar speech in the same fundur+matter within 15 min, DECISIONS §10) and add a `svarar=<member>` filter; label "líklega". |
| 5 | **Document text** (nál., frv., written answers) | P04-02, P06-01/02/10 (8 w) | WP8b (current session ~1.5k req); `/thingskjal` page already exists to show it. |
| 6 | **Sponsors / askers** | P03-03, P04-08 (5 w) | `matter_sponsors` from the matter-detail XML (no extra crawl). |
| 7 | **`vod_url` NULL for all speeches** | P01-10, P10-07 (5 w) | Parser: find the video field in the speech list XML (the reader looks for `vod`); crawler owner. |
| 8 | **Matter titles vs everyday words** ("áfengi í matvöruverslunum" → matter 334 *verslun með áfengi og tóbak* not surfaced) | P10-05, P10-04 (4 w) | When a multi-word query has 0 speech hits, run the matter-title search as OR-of-lemmas ranked by coverage and show the top 3 as cards. |
| 9 | **Hyphen-ellipsis names** ("umhverfis- og samgöngunefnd" ORs its halves) | P05-05 | Treat `X- og Y` as an implicit phrase on the query side (althingi), plus L3 in lemma-is. |
| 10 | Word pages, KWIC, token export, member profile, compare view, session page, OG card, APA/Alþingistíðindi cite styles | P09-01/06/07/08, P07-06/08/10, P06-07, P10-09 (w1–2) | WP12 as planned; cite variants and OG tags are small (S) and could ride with the next UI pass. |
| 11 | Stale `vocab` MV | indirect (did-you-mean quality) | `refresh materialized view concurrently vocab` at the end of each ingest run (ops/crawler; not changed here). |

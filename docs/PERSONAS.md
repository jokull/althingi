# althingi-search — personas and the 100 tasks (2026-11-10)

Product lead's call: the build is driven by these ten people. Verdicts are **against the DECISIONS.md plan (WP1–15), not against `src/` today**: SERVED = a named WP delivers it (phase in brackets: P0 gate, P1 live, P2 backfill, P3 enrichment); PARTIAL = the plan covers part, the rest is named; GAP = no WP touches it. Machine-readable twin: `test/golden/personas.json` (same ids, same capability slugs). Persona weight (w) = how much a failed task costs us: 3 = daily professional use, 2 = recurring, 1 = occasional.

## Personas

| # | Who | Context, goals, tech | Arrives via | Success feels like | w |
|---|---|---|---|---|---|
| P01 | **Sigrún**, political reporter, RÚV | Deadline in 40 min; needs what was said *today*, by whom, quotable with time and link; filters by name/date; bookmarks `/leit`. Medium tech. | Direct/bookmark, phone | Quote + permalink in < 1 min; today's debate already there | 3 |
| P02 | **Askur**, a Claude agent acting for Hallur, fact-checker | Verifies claims ("X never said Y", "Y voted for Z") and returns evidence packages; must know the corpus boundary and what is inferred. | MCP (Claude Desktop) | Structured hits with ids, timestamps, URLs; never fabricates a boundary | 3 |
| P03 | **Birta**, party-group assistant (þingflokksaðstoðarmaður) | Tracks her MPs' speeches, opponents' claims, bill status, consultation deadlines; writes memos in Word. Medium tech. | Direct, daily | Filters in the URL she can re-open; CSV for memos; nothing missed | 3 |
| P04 | **Guðjón**, ministry lawyer | Drafts answers to fyrirspurnir, legislative intent for law interpretation, who said what at 1. umræða. Low tech, high precision. | Google "lög nr. 34/1991 umræða" | Law → every amending matter → speeches by stage, all strong links | 2 |
| P05 | **Elín**, policy monitor at an environmental NGO | Watches energy/nature bills, consultation deadlines, which MPs voted how; wants alerts and tables for reports. | Direct + RSS reader | Feed per word and per matter; vote grid by party | 2 |
| P06 | **Ragnar**, lawyer in private practice | Lögskýringargögn: framsaga, nefndarálit, breytingartillögur, votes on amendments, citeable in a brief. | Google, althingi.is links | A legislative history on one page with citations; document texts | 2 |
| P07 | **Katrín**, MA student, political science | Longitudinal questions 2005→: word use by party, rebels, speaking time; exports for R; APA citations. | Google Scholar-ish, direct | Normalised numbers, CSV, clear boundary notes | 1 |
| P08 | **Daði**, data journalist / civic-tech developer | Builds a Telegram bot and charts; wants JSON, feeds, bulk dumps, stable ids, MCP from code. High tech. | MCP + HTTP from code | Cursor-paged JSON, Atom, weekly dump, predictable rate limits | 2 |
| P09 | **Anna**, linguist / NLP researcher (HÍ) | Word forms, trends, compounds, KWIC, lemma-is behaviour; wants the token stream. High tech, licence-aware. | Direct, `/ord` | Observed forms with counts, reproducible (lemma-is version stamped) | 1 |
| P10 | **Þórður**, social-studies teacher and voter | "What did my MP say / how did they vote", shows debates in class, shares quotes; needs a glossary, mobile, accessible. | Google, Facebook link | Readable without jargon, watch the video, share a card | 2 |

## Tasks (verdict · capability@phase)

Shape column = best result. Capability slugs match `personas.json`.

### P01 Sigrún, reporter (w3) — 2 served, 5 partial, 3 gap
| # | Task (IS · gloss) | Shape | Verdict · capability |
|---|---|---|---|
| 01 | `veiðigjöldin` umræða í dag · today's fishing-fee debate | Today's hits newest first, inflected form → lemma | PARTIAL · fts-lemma@P0 ok; freshness: 4×/day ingest = up to 6 h lag |
| 02 | Hvað sagði Kristrún Frostadóttir um Landspítala í vikunni? | Name → member filter + 7-day range | SERVED · route-member, filter-member, filter-date@P0 |
| 03 | Afrita tilvitnun með tíma, tengli og málsheiti | One-click cite string from `#mgr-N` | PARTIAL · speech-page@P1; quote-cite missing |
| 04 | Hver sagði fyrst „orkuskortur“? · who said it first | Earliest paragraph + year strip, "frá 2005" | GAP · first-use (cheap: `min(started)` over `seq_vector`) |
| 05 | Hvernig greiddi Flokkur fólksins atkvæði um 300. mál? | Party grid on the vote | PARTIAL · vote-list@P1 counts only; vote-ballots@P2 |
| 06 | Hve margar ræður hélt Inga Sæland um fundarstjórn í okt. 2026? | A number + list | PARTIAL · filters@P0; count-total/member counts@P2 |
| 07 | Fylgjast með 157/300 · follow a matter | Atom feed per matter | GAP · feed-atom |
| 08 | Forsætisráðherra í andsvari við Sigmund Davíð | andsvör by PM whose parent is SDG's speech | PARTIAL · andsvar-thread inferred@P1; filter-office missing |
| 09 | Hver kallaði fram í „þetta er lygi“? · interjection hunt | Honest "frammíköll ekki leitarbær" | GAP by design · interjections; zero-hit page must say so |
| 10 | Finna ræðuna í vefútsendingu | vod link + start/end time | SERVED · speech-page, vod-link@P1 |

### P02 Askur, agent for a fact-checker (w3) — 4 / 4 / 2
| # | Task | Shape | Verdict · capability |
|---|---|---|---|
| 01 | Sannreyna „X hefur aldrei nefnt hælisleitendur“ | member-filtered search + exact/capped total + boundary note | PARTIAL · mcp-search@P1; count-total@P2 |
| 02 | Staðfesta orðrétt „ekki er allt sem sýnist“ | phrase hit with id, seq, started, matter, URLs | SERVED · phrase@P0, mcp-get-context@P1 |
| 03 | Hvernig greiddi Y atkvæði um þskj. 421? | `get_vote` → ballots with party-at-date | GAP · vote-ballots@P2; no mcp-get-vote in WP6 |
| 04 | Hvar lofaði ráðherrann „fyrir áramót“? | phrase ∧ office set | PARTIAL · phrase ok; filter-office missing |
| 05 | „neyðarástand“ oftar á 157. en 156. þingi? | aggregate by lthing, per-10k-words | PARTIAL · mcp-aggregate/trend@P2 + backfill |
| 06 | Af hverju fann leitin „lánum“ fyrir „lán“? | explain_query JSON | SERVED · mcp-explain@P1 |
| 07 | 5 tilvitnanir með slóð, tíma, málsnúmeri | ≤ 8 KB evidence package | SERVED · mcp-get-context, resource-uri@P1 |
| 08 | Sagði ráðherra þetta fyrir eða eftir atkvæðagreiðsluna 12.6.2026? | vote time vs speech started | SERVED · vote-list@P1, mcp-list-votes |
| 09 | Hefur ræðutextinn breyst síðan í gær? | sha256 + revised_at in get_speech | PARTIAL · revisions stored, not exposed |
| 10 | Sagði Davíð Oddsson „ógeðfellt“ 1998? | structured boundary notice + index count + link | GAP · boundary-2005, sgml-index@P2 (WP13 is UI only) |

### P03 Birta, party-group assistant (w3) — 2 / 6 / 2
| # | Task | Shape | Verdict · capability |
|---|---|---|---|
| 01 | Allar ræður okkar þingmanna um húsnæðismál á 157. þingi | party filter via seats-on-date | PARTIAL · filter-party absent from SearchParams/URL |
| 02 | Hvað sagði stjórnarandstaðan um fjárlög 2026? | route to the budget matter by title, not drop "2026" | PARTIAL · number-handling, filter-party |
| 03 | Fyrirspurnir þingmannsins okkar, hverjum er ósvarað? | sponsored matters with status | GAP · matter-sponsors not modelled |
| 04 | Hvar er 412. mál statt, hvaða nefnd? | matter page: status, committee, docs | SERVED · route-matter@P0, matter-page@P1 |
| 05 | Umsagnir sem bárust um 300. mál | requests + deadlines; erindi link out | PARTIAL · committee@P1; erindi not crawled |
| 06 | Hverjir töluðu mest um leikskóla síðan 2021? | aggregate by member | PARTIAL · trend@P2 + backfill |
| 07 | Ræður ráðherra X síðustu viku sem CSV | `/leit.csv` ≤ 500 rows | GAP · export-csv-json |
| 08 | Andsvör sem okkar þingmaður fékk frá Bergþóri | reply_to filtered, labelled inferred | PARTIAL · andsvar-thread |
| 09 | Jakob Frímann um sama mál á 153. þingi, fyrir flokkaskipti | hits with party-at-date | PARTIAL · party-at-date@P1 ok; backfill@P2 |
| 10 | Dagskrá og ræður gærdagsins í röð | `/dagur/…` | SERVED · day-page@P1 |

### P04 Guðjón, ministry lawyer (w2) — 6 / 2 / 2
| # | Task | Shape | Verdict · capability |
|---|---|---|---|
| 01 | lög nr. 34/1991 – mál sem breyttu þeim og umræðan | `/log/1991/34` → matters → debates | SERVED · route-law@P0, law-page@P1 |
| 02 | Nefndarálit meirihluta (þskj. 512) – textinn | document page with text | GAP · doc-text (302 to althingi.is) |
| 03 | Framsöguræða ráðherra við 1. umræðu um 300. mál | matter page by stage | SERVED · matter-page, filter-debate@P1 |
| 04 | Svar ráðherra við munnlegri fyrirspurn, 212. mál | question + svar paired (strong) | SERVED · svar-link@P1 |
| 05 | Ræður þar sem stjórnsýslulögin eru nefnd 2020–2026 | date-ranged lemma search | PARTIAL · backfill@P2 |
| 06 | Tengd mál við 157/300 | matter_links both ways | SERVED · matter-links@P1 |
| 07 | Umsagnabeiðnir og frestur um 300. mál | consultation_requests | SERVED · committee@P1 |
| 08 | Hver flutti frumvarpið, hvaða ráðuneyti? | sponsors on the matter page | GAP · matter-sponsors |
| 09 | Prenta alla umræðuna um 300. mál | `/mal/…/umraeda` print view | PARTIAL · matter-transcript, print-view |
| 10 | Hvernig var „meðalhóf“ orðað í umræðunni? | search within matter | SERVED · filter-matter@P0 |

### P05 Elín, NGO monitor (w2) — 2 / 5 / 3
| # | Task | Shape | Verdict · capability |
|---|---|---|---|
| 01 | vindorka vindorkuver, nýjast fyrst | OR-groups incl. compounds, newest | SERVED · fts-lemma, compound, sort-newest@P0 |
| 02 | Láta vita þegar „rammaáætlun“ er nefnd | `/leit/atom?q=` | GAP · feed-atom |
| 03 | Hverjir studdu/felldu 412. mál? | ballot grid by party | PARTIAL · vote-ballots@P2 |
| 04 | „loftslag“ + samsetningar 2010–2026 eftir flokkum | ngram per 10k words | PARTIAL · trend@P2 + backfill |
| 05 | Umsagnafrestir hjá umhverfis- og samgöngunefnd | `/nefnd/<abbr>` | PARTIAL · committee data@P1; committee-page missing |
| 06 | Hver nefndi Hvalárvirkjun? | unknown proper noun as surface lexeme | SERVED · unknown-word@P0 (chip marks it) |
| 07 | Hvað sagði umhverfisráðherra um Landvernd? | office filter over time | PARTIAL · filter-office |
| 08 | Mál í efnisflokknum Umhverfismál, 157. þing | `/efni/<id>` | GAP · efnisflokkur-browse (data@P1, no route) |
| 09 | Strandveiðar 2024–2026 í töflu | CSV | GAP · export-csv-json |
| 10 | Náttúruverndarfrumvörp sem urðu að lögum 2023–2026 | category × type l × status | PARTIAL · efnisflokkur-browse, backfill |

### P06 Ragnar, lawyer (w2) — 2 / 7 / 1
| # | Task | Shape | Verdict · capability |
|---|---|---|---|
| 01 | lög nr. 90/2018 – lögskýringargögn | law → matter → stages + documents | PARTIAL · law-page@P1; doc-text missing |
| 02 | þskj. 421 á 157. þingi | document page | PARTIAL · route-doc@P0 → 302 only |
| 03 | Framsögumaður nefndar um 2. gr. | capacity N within matter, surface match on "2. gr." | PARTIAL · speaker-capacity@P1; number-handling |
| 04 | Tímalína 300. máls | one-axis timeline | PARTIAL · matter-page lists; matter-timeline not planned |
| 05 | Bótaábyrgð og skaðabótalög nr. 50/1993 | law page + search in matter | SERVED · route-law, filter-matter |
| 06 | Atkvæði um breytingartillögu við 3. umræðu | result + names | PARTIAL · vote-list@P1; vote-ballots@P2 |
| 07 | Vísa með Alþingistíðinda-sniði | defined cite string, no column numbers in XML era | PARTIAL · quote-cite |
| 08 | Önnur frumvörp sem breyttu sömu lögum | reverse index | SERVED · law-page@P1 |
| 09 | Innanríkisráðherra 2012 um útlendingalög | office-by-date + 140–141 texts | PARTIAL · backfill, filter-office |
| 10 | Leita í svörum við skriflegum fyrirspurnum | document search | GAP · doc-text; UI must say "aðeins munnleg svör" |

### P07 Katrín, student (w1) — 2 / 4 / 4
| # | Task | Shape | Verdict · capability |
|---|---|---|---|
| 01 | ESB per 10.000 orð eftir flokkum 2005–2026 | normalised ngram | PARTIAL · trend, normaliser@P2 + backfill |
| 02 | Atkvæði gegn eigin flokki 2017–2021 | rebels view | PARTIAL · rebels@P2 |
| 03 | Ræðutími eftir kyni | minutes by gender | GAP · member-gender not in source |
| 04 | Steingrímur J. um Icesave 2009 | member + date | PARTIAL · backfill |
| 05 | Kvótakerfið sem CSV með flokki | export with party-at-date | GAP · export-csv-json |
| 06 | Miðflokkur vs Sjálfstæðisflokkur á „fullveldi“ | two sparklines + quotes | GAP · compare |
| 07 | EES 1992 | boundary notice + index counts | GAP · boundary-2005 (WP13 copy only) |
| 08 | Fjöldi ræðna á þing 131–157 | session cards | SERVED · session-page@P1 |
| 09 | Þingmenn Bjartrar framtíðar 2013–2016 | seats by date | SERVED · party-page@P1 |
| 10 | APA-tilvísun | copyable cite | PARTIAL · quote-cite |

### P08 Daði, civic-tech developer (w2) — 2 / 4 / 4
| # | Task | Shape | Verdict · capability |
|---|---|---|---|
| 01 | JSON af ræðum um verðbólgu, 30 dagar | `/leit.json` or MCP limit 100 + cursor | PARTIAL · mcp-bulk (MCP ≤ 25/page, no site JSON) |
| 02 | Öll atkvæði 157 sem CSV | per-session votes CSV | GAP · export-csv-json |
| 03 | Atom fyrir /mal/157/a/300 | feed | GAP · feed-atom |
| 04 | Ræðumínútur eftir flokki á viku | aggregate minutes | PARTIAL · speaking-time@P2 |
| 05 | 200 MCP-köll/mín úr bot | 429 + Retry-After; bulk path | PARTIAL · rate-limit 60/min |
| 06 | Vikulegt niðurhal á töflunum | `/gogn` dumps on R2 | GAP · open-dump |
| 07 | explain_query fyrir eigið viðmót | JSON | SERVED · mcp-explain |
| 08 | Stöðug auðkenni ↔ althingi.is | source_url + alias redirects | SERVED · resource-uri |
| 09 | Hverjir tala mest í „störfum þingsins“ | counts with B-mál note | PARTIAL · bmal-hedge, aggregate@P2 |
| 10 | Ping við nýja ræðu | `/nyjast/atom` | GAP · feed-atom |

### P09 Anna, linguist (w1) — 2 / 4 / 4
| # | Task | Shape | Verdict · capability |
|---|---|---|---|
| 01 | Orðmyndir „lán“ með tíðni | observed forms only | SERVED · word-page@P2 |
| 02 | „kvóti“ vs „aflaheimild“ yfir tíma | two lemmas, one chart | PARTIAL · compare |
| 03 | „á“ sem sögn | POS filter | GAP · morph-facet (data stored, skipped) |
| 04 | Samsett orð með -lán | compound list on `/ord/lán` | GAP · compound-browser |
| 05 | Fyrsta tilvik „gervigreind“ | earliest + "frá 2005" | GAP · first-use |
| 06 | KWIC um „sko“ | concordance lines | PARTIAL · kwic (offsets exist) |
| 07 | Token stream einnar ræðu | per-speech view (allowed) | GAP · token-export |
| 08 | Einkennandi orð þingmanns | TF-IDF profile | PARTIAL · member-profile@P2 |
| 09 | Lemmar „fyrst og fremst“ rangt? | chip shows snemma/fremri + ILIKE fallback | SERVED · mcp-explain, phrase |
| 10 | Tíðni „meika sens“ | surface phrase counts/year | PARTIAL · unknown-word, trend@P2 |

### P10 Þórður, teacher/voter (w2) — 3 / 5 / 2
| # | Task | Shape | Verdict · capability |
|---|---|---|---|
| 01 | Google: hvað sagði þingmaðurinn minn um leikskóla | SEO landing, no-JS results | SERVED · fts-lemma, seo@P1 |
| 02 | Þingmenn Norðausturkjördæmis | `/kjordaemi/<id>` | PARTIAL · constituency-page (data exists) |
| 03 | Hvað er andsvar? 2. umræða? | glossary + tooltips | GAP · glossary |
| 04 | Hvernig kaus þingmaðurinn minn um áfengi í búðum? | ballot history on member page | PARTIAL · vote-ballots@P2 |
| 05 | Sýna nemendum umræðuna | search → matter → video | SERVED · matter-page |
| 06 | þskj./nál./frv. á ensku | bilingual structural glossary | GAP · english-glossary |
| 07 | Horfa á ræðuna | prominent vod link | SERVED · vod-link |
| 08 | Katrín Jakobsdóttir 2017 | backfill to 148 | PARTIAL · backfill |
| 09 | Deila tilvitnun á Facebook | text-only OG card | PARTIAL · og-card |
| 10 | Skjálesari, stórt letur | WCAG-clean pages | PARTIAL · accessibility (no acceptance test) |

## Synthesis

**Totals**: 27 SERVED · 46 PARTIAL · 27 GAP. Professionals (w3) are the least served: P01 2/10, P03 2/10. Most PARTIALs are one of four things: ballots in P2, backfill in P2, a missing filter, or a missing cheap view over data the plan already crawls.

### (a) Capabilities ranked (Σ persona weight over tasks needing it, computed from personas.json)

| Capability | w | tasks | status | note |
|---|---|---|---|---|
| matter-page | 34 | 15 | P1 (WP8) | the hub: status, docs, votes, laws, committee, stage-grouped speeches |
| fts-lemma | 30 | 13 | P0 | fine; inflected queries are the norm |
| backfill 156→131 | 25 | 13 | P2 | 11 PARTIALs are only "not yet"; nothing to redesign |
| filter-date | 21 | 9 | P0 | exists; needs URL + chip |
| party-at-date | 20 | 11 | P1 | strong; must also power the party *filter* |
| filter-member | 18 | 6 | P0 | exists |
| vote-ballots | 15 | 7 | P2 | 5 personas need it for the **current** session |
| speech-page / route-matter / mcp-search / trend | 13 | 5–8 | P1/P2 | trend is the long tail (P07, P09, P05) |
| vote-list | 12 | 5 | P1 | counts + times already answer P02-08 |
| quote-cite, phrase, boundary-2005 | 11 | 5 | — | cite: 5 tasks, 4 personas, zero WP |
| filter-office, mcp-aggregate, committee, export-csv-json | 10 | 4–5 | — | office filter: 4 tasks, all PARTIAL |
| feed-atom | 9 | 4 | GAP | the only "alert" mechanism that fits a stateless public site |
| count-total, law-page, doc-text, filter-type | 8 | 3–4 | — | doc-text is the lawyer's wall |

### (b) Biggest gaps → fixes

| Gap | Hurts | Fix (cost) |
|---|---|---|
| No alerts/follow | P01, P03, P05, P08 (9 w) | **Atom everywhere**: `/leit/atom?q=…&filters`, `/mal/<l>/<c>/<n>/atom`, `/thingmadur/<id>/atom`, `/nyjast/atom`; entries = speeches/docs/votes; `s-maxage=300`. Stateless, zero accounts. (S) |
| No export | P03, P05, P07, P08 (10 w) | `/leit.csv` and `/leit.json` with the same params, ≤ 500 rows, cursor for JSON; `/thing/<l>/atkvaedagreidslur.csv`; `/mal/…/umraeda` print view. (S) |
| Ballots only in P2 | P01, P02, P05, P06, P10 (11 w) | Crawl **157 ballots** (≈ 1.5k req ≈ 2 h) in WP8 before the 157 text remainder; `get_vote` tool; grid with five values. (S + 2 h crawl) |
| No citation format | P01, P02, P06, P07, P10 | One cite string: `Nafn (Flokkur), ræða 12.6.2026 kl. 14:19, 300. mál á 157. lþ., mgr. 4 — althingi.solberg.is/raeda/rad20260612T141933#mgr-4 (althingi.is: …)`; "afrita" button, text-only OG card, `?q=` highlight. (S) |
| Missing filters | P01–P03, P05, P06 | `party` (seats-on-date), `office` (`embætti` by date), `debate`, `capacity` in SearchParams, URL and MCP. (S) |
| Cheap views over crawled data | P05, P10, P03 | `/efni/<id>`, `/nefnd/<abbr>`, `/kjordaemi/<id>`; first-use + year strip on `/ord` and in `aggregate`; `/ord/<l>?vs=`. (S each) |
| Document text | P04, P06 (4 tasks) | v1.5: fetch `thingskjal` XML for the current session only (≈ 1.5k req ≈ 2 h), index nál./frv./svar with the same pipeline; `/thingskjal` becomes a page. Written answers become searchable. (M) |
| Matter sponsors | P03, P04 | `matter_sponsors(lthing, cls, nr, member_id|office, ord)` parsed from the first document's flutningsmenn in matter detail (same request). (S) |
| Freshness | P01 | Poll `raedulisti?dagur=today` every 30 min on sitting days (1 req) and fetch new texts at once; target lag ≤ 60 min. (S) |
| Glossary / English | P10 | `/um/ordskyringar` (speech types, stages, matter and document types) with tooltips on labels; English structural glossary at `/en`; no speech translation. (S) |
| Agent boundary | P02 | Tool descriptions and every response carry `corpus: {text_from: 2005, sessions, ingested_to}`; zero-hit responses carry `why` (boundary, interjections, numbers). (S) |

### (c) What this changes

- **Data model**: add `matter_sponsors`; `documents.text`/`lemma_text`/`search_vector` (nullable, current session first); `speeches.revised_at` exposed; `votes.time` indexed for the before/after question; `seats.constituency_id` gets a page. No gender column (not in source; refuse rather than guess). `paragraph_tokens` already serves KWIC and first-use.
- **URL scheme**: add `/leit/atom`, `/leit.csv`, `/leit.json`, `/mal/<l>/<c>/<n>/{atom,umraeda}`, `/thingmadur/<id>/atom`, `/nyjast/atom`, `/efni/<id>`, `/nefnd/<abbr>`, `/kjordaemi/<id>`, `/um/ordskyringar`, `/en`, `/gogn` (dumps). Filters in the URL: `flokkur=`, `embaetti=`, `umraeda=`, `tegund=`, `fra=`, `til=`. `/thingskjal/<l>/<n>` becomes a page once text exists.
- **Ranking**: unchanged, plus: a query matching a matter title in the current session (`fjárlög 2026`) shows the matter card above hits; numbers in the query feed the surface `ILIKE` leg within a matter filter ("2. gr.") instead of vanishing; office/capacity filters are pre-filters, not boosts.
- **Performance budget**: `/leit` p95 ≤ 120 ms stays; Atom/CSV ≤ 500 ms for 500 rows (streamed); `/ord` ≤ 50 ms from MVs; MCP `search_speeches` ≤ 300 ms end to end; 429 with `Retry-After`. Freshness ≤ 60 min on sitting days replaces "4×/day".
- **MCP tool set**: WP6 + `get_vote(id)`, `get_matter_timeline`, `list_documents(matter)`, `first_use(lemma)`; `search_speeches` gains `party`, `office`, `debate`, `capacity`, `limit ≤ 100`, `total` (exact ≤ 10k else "10000+"); every response carries `corpus` and `derived` flags; `get_speech` returns `revisions` and `interjections` (display field). Rate limit 60/min stays; bulk goes through `/gogn`.
- **Crawl/ingest order**: 157 A-mál detail → 157 votes list → **157 ballots** → remaining 157 texts → 157 þingskjöl text (new) → soak. Backfill order unchanged (newest first) but ballots interleaved per session as planned. The 2005 boundary is acceptable for every persona *if stated structurally* (P02-10, P07-07) and the index-only counts ship with WP13; nobody here needs pre-2005 text badly enough to block v1.

### (d) Delta to the DECISIONS.md build plan

1. **WP8 re-scope**: insert "157 ballots (electronic votes)" after the votes list and before the remaining 157 texts (+2 h crawl); `/atkvaedagreidsla/<id>` grid ships in WP5. Reason: 7 tasks, 5 personas, 15 w; WP11 then covers 156→131 only.
2. **WP8 ingest cadence**: replace 4×/day with a 30-minute sitting-day poll (`raedulisti?dagur=today`, ≈ 20 req/day) plus the existing nightly pass. Reason: P01 freshness bar.
3. **WP5 add**: Atom feeds (search/matter/member/global), `/leit.csv|.json`, cite button + OG card + `?q=` highlight, `/efni`, `/nefnd`, `/kjordaemi`, glossary, `/en`. Acceptance: Atom validates; CSV 500 rows < 500 ms; cite string matches §(b) format.
4. **WP3 add**: `party`, `office`, `debate`, `capacity` filters (seats/office resolved on speech date); current-session matter-title card for title-matching queries; numeric tokens routed to the surface leg when a matter filter is set. Reason: 8 PARTIALs across P01–P03, P05, P06 collapse to SERVED.
5. **WP6 add**: `get_vote`, `get_matter_timeline`, `list_documents`, `first_use`; `limit ≤ 100`, `total`, `corpus` block, structured zero-hit `why`. Reason: P02 and P08 tasks.
6. **New WP8b (after WP9 soak, before WP10)**: þingskjöl text for the current session (≈ 1.5k req), `documents` text columns, `/thingskjal` page, written answers searchable. Reason: P04/P06 GAPs are the only ones a crawl can close cheaply.
7. **WP8 sql/0003 add** `matter_sponsors` from matter detail (no extra requests). Reason: P03-03, P04-08.
8. **WP12 add**: first-use + year strip, `/ord/<l>?vs=`, speaking minutes by party/week in `aggregate`, KWIC endpoint from `paragraph_tokens` offsets, per-speech token view (licence-safe). Reason: P07, P09, P08-04.
9. **WP13 extend**: pre-2005 handling also in MCP (counts + link + boundary block), not only page copy. Reason: P02-10, P07-07.
10. **WP5 acceptance add**: axe/Lighthouse a11y ≥ 95, keyboard-only pass, vote grid readable without colour. Reason: P10-10.
11. **WP3 eval**: `scripts/eval.ts` also reads `personas.json` and prints served/partial/gap per persona; the P@5 gate is unchanged, the persona coverage is reported, not gated.
12. **New WP (Phase 2, S)**: weekly open-data dumps to R2 (`/gogn`): speeches, paragraphs.text, votes, ballots, seats, matters; lemma columns excluded (BÍN). Reason: P08-06, and it drains bulk traffic off the MCP.
13. **Keep out** (unchanged, now evidenced): morphology facets (P09-03 only), compound browser (P09-04 only), gender stats (no source), embeddings, topic lens stays P3, pre-2005 text.

### (e) Persona-driven quality bars

| Persona | Bar |
|---|---|
| P01 reporter | `/leit` p95 TTFB ≤ 120 ms; every hit shows hh:mm:ss, matter, type; cite copied in one click; speeches visible ≤ 60 min after althingi.is publishes on sitting days; "nýjast fyrst" is one tap on mobile |
| P02 agent | `tools/list` ≤ 50 ms; search ≤ 300 ms; every hit carries `speech_id, seq, started, member, party_at_date, matter, url, source_url`; `corpus` block on every response; inferred fields flagged `inferred:true`; zero hits always have a `why` |
| P03 staffer | all filters URL-addressable and bookmarkable; CSV ≤ 500 rows < 500 ms; feeds update ≤ 5 min after ingest |
| P04/P06 lawyers | law/matter/vote pages contain **no inferred links**; every document id links to althingi.is until text exists; cite string stable forever (ids are source ids) |
| P05 NGO | Atom validates in Feedly/Slack; vote grid never collapses the five ballot values |
| P07/P09 researchers | counts reproducible: `lemma_is_version` and MV refresh time printed on every number; normaliser (per 10k words) shown next to raw counts; "frá 2005" on every first/total |
| P08 developer | 429 carries `Retry-After`; cursor paging never duplicates; ids and URLs never change; dumps weekly with a checksum |
| P10 citizen | Lighthouse a11y ≥ 95, SEO 100; usable at 320 px and 200 % zoom without JS; glossary tooltip on every jargon label |

### (f) Risks of misleading users, and the hedge per persona

| Risk | Who it bites | Hedge |
|---|---|---|
| andsvar→parent and speech→document are inferred | P01-08, P03-08, P02 | label "líklega andsvar við …" in UI, `inferred:true` in MCP; never in lawyers' pages (P04/P06 see only strong links) |
| Party-at-time (switchers, `með varamann`, utanþingsráðherrar) | P03-09, P07, P05-03 | always seats-on-date; "ráðherra (utan þings)" when no seat; party filter and grids use the same join; member page shows the stint list |
| Interjections not indexed | P01-09 | zero-hit page and MCP `why: interjections_not_indexed`; speech page renders them muted with name |
| B-mál: "störf þingsins" is a new stub matter each day, no docs/votes | P08-09, P03 | matter card says "B-mál: titill úr ræðuskrá, engin skjöl"; aggregates group B-mál by title with a note; never a topic by itself |
| 2005 cutoff | P02-10, P07-07, P10-08 | "frá 2005 (XML-öld)" on every first/total/count; index-only counts with althingi.is links (WP13); MCP `corpus` block; no pre-2005 option in filters |
| lemma-is quirks (stopword phrases, "fyrst og fremst", numbers dropped, false compound splits) | P09-09, P06-03, P03-02 | expansion chip always shown, removable groups, ILIKE fallback for phrases, dropped numbers listed, matter-title card for numeric titles |
| Unknown words (proper nouns) indexed as surface forms | P05-06 | chip marks "óþekkt orð: leitað að orðmyndinni"; did-you-mean from corpus vocab |
| Counts inflated by procedural speeches | P01-06, P07, P09-08 | `is_substantive` default in profiles/trends with a toggle; counts say which |
| Upstream text revisions | P02-09 | `revised_at` + sha shown; old text kept, never silently replaced |
| Written answers absent (only oral `svar`) | P06-10, P04 | type=svar filter labelled "munnleg svör"; link to the document on althingi.is |
| Derived labels (P3 topic lens) look like facts | P05-08, P10 | "líklega um …, merkt af <model>" badge, `derived:true`, feedback link; never on lawyers' legislative-history views |

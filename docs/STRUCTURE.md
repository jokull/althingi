# Althingi data: structure as sampled (2026-11-10)

Source: `https://www.althingi.is/altext/xml/` (open XML service). All fixtures in `fixtures/` were fetched at ≥5 s spacing, UA `althingi-search/0.1 (jokull@solberg.is)`, no 429 seen. HTML under `/altext/` (incl. `.sgml`, `.html`, `.pdf`) is behind a Cloudflare challenge (403) — **not used, not circumvented**. XSD host `skema.althingi.is` does not resolve; parser is built from samples.

## 1. Eras (what text exists, and where)

| Era | Sessions | Speech index | Speech text | Status |
|---|---|---|---|---|
| SGML | ~115–130 (1991–2004) | yes, via `raedulisti` / per-member list; links are `<sgml>` under `/altext/…` | **403** — unavailable | out of scope v1; ask Alþingi / use IGC |
| XML | ~131–157 (2004–2026) | yes | `https://www.althingi.is/xml/<lthing>/raedur/rad<YYYYMMDDTHHMMSS>.xml` | **v1 corpus** |

Evidence: 2002-11-05 and 1999-03-02 listings carry only `<sgml>`; 2005-03-02 onward carry `raedur/rad*.xml`; the 8 SGML URLs sampled all returned 403. Members exist from session 1, matters/votes from ~20, committees 74, erindi 111 (per the service overview).

## 2. Hierarchy

```
löggjafarþing (1..158; 157 = 2025-26)            loggjafarthing/            1 request lists all
├─ þingmenn (members per session)                thingmenn/?lthing=N        49–114 per session; id, name, birth, abbr, links. NO party here
│   └─ þingmaður detail                          thingmadur/?nr=ID          current seat, contact; links to the rest
│       ├─ þingseta (seats, with dates + party)  thingmadur/thingseta/?nr=  type (þingmaður|varamaður), þingflokkur id+name, kjördæmi, in/out dates; ~1 row per session/stint
│       └─ ræðulisti (ALL speeches, all eras)    thingmadur/raedur/?nr=     one request = whole career (MP 7: 2110 speeches, 1.8 MB, no 429)
├─ þingmál (matters)                             thingmalalisti/?lthing=N   157: 1070, 131: 922, 123: 685; one request/session (title, type code, status link)
│   ├─ A-mál  detail                             thingmal/?lthing&malnr     type (l frv., m þáltill., q/fsp, a, ff, ud, s, b), staða, tengd mál, efnisflokkar, þingskjöl, atkvæðagreiðslur, umsagnabeiðnir, ræður
│   └─ B-mál  detail                             bmal/?lthing&malnr         (störf þingsins, tilkynningar forseta, fundarstjórn…) title + speeches only
├─ þingskjöl (documents)                         thingskjol/?lthing=N       157: 1542 (fsp., svör, frumvörp, nál., lög…); full text only via thingskjal/?lthing&skjalnr (XML) — v2
├─ atkvæðagreiðslur (votes)                      atkvaedagreidslur/?lthing=N[&malnr=M] | ?dagur | ?dagar
│   └─ vote detail with per-member ballots       atkvaedagreidsla/?numer=ID   já | nei | greiðir ekki atkvæði | boðaði fjarvist | fjarverandi; result + counts; doc ref
├─ nefndir (committees)                          nefndir/?lthing=N          id, name, abbreviations, first session; members via nefndarmenn/
└─ ræður (speeches)                              raedulisti/?dagur= | ?lthing&malnr= | per member   index entries; text = separate XML per speech
lagasafn                                         lagasafn/zip/nuna/allt.zip 8.9 MB zip, 1799 HTML files (34 MB) — v2, separate pipeline
```

## 3. Speech index entry (`<ræða>` in lists)
speaker `id`, role flag (`ráðherra` | `forsetiAlþingis` | `framsögumaðurNefndarálits`), `dagur`, `löggjafarþing`, `fundur`, `ræðahófst`/`ræðulauk`, `tegundræðu`, `umræða`, `mál{málsflokkur,málsnúmer,málsheiti}`, links (`xml`, `html`, `hljóð`, `vod`; old era `sgml`, `dálkur`).

Values seen: **tegundræðu**: ræða, andsvar, flutningsræða, svar, um atkvæðagreiðslu, grein fyrir atkvæði, um fundarstjórn, útbýting þingskjala (*not a speech*, 2–4/day, no matter). **umræða**: `1` `2` `3` `*` `S` `E` `F` `''`. **málsflokkur**: `A`, `B`, `''` (no matter). B-mál are 15–40 % of a day's speeches.

## 4. Speech text file
Root `<ræða id="r2025-10-21T14:19:33" skst="RGuðb" embætti="fjmrh." tegr tegflm frhr>` → `<umsýsla fundur tími lgþ><mál nr málstegund málsflokkur><málsheiti>` → `<ræðutexti>` → `<mgr jöfnun="…">` paragraphs.

Parser traps found in 22 samples:
- **Namespace-prefixed variant** (`<ns:ræða>`, `<ns:mgr>`, seen 2025): regex = 0 paragraphs. Use a real namespace-aware parser (local-name matching).
- Inline `<frammíkall>` (interjections by *other* MPs; some contain `<?xm-replace_text …?>` PIs), empty `<undirtitill/>`, `jöfnun` attribute on `<mgr>`.
- Hard-wrapped lines inside paragraphs → collapse whitespace.
- Size: 8 s speech ≈ 0.8 KB, 14-min budget speech ≈ 12 KB, 43-paragraph debate speech ≈ 30 KB.
- `speeches.id` = filename stem (`rad20250911T103151`), not the `r2025-…` attribute.

## 5. Request budget at 5 s (XML-era v1)

| Step | Requests | Time |
|---|---|---|
| sessions + members per session (131–157) | ~30 | 2.5 min |
| per-member speech lists (unique members ≈ 450?) | ~450 | ~40 min |
| member detail + thingseta | ~900 | ~75 min |
| matter lists per session | 27 | 2 min |
| **speech text (≈200–250k, estimate)** | **~200–250k** | **~12–15 days** |
| votes (list + per-vote ballots) — Phase 2 | ~50k? | ~3 days |
| matter detail (status) — optional | ~28k | ~1.6 days |

Total ≈ 2–3 weeks. Raw XML stored on disk (and R2) → re-parse without recrawl.

## 6. Schema revisions vs design doc
- `member_terms` → **`seats(member_id, lthing, kind, party_id, constituency, from, to)`** + `parties(id,name)`; party joined on the **speech date**, not the session (party/seat changes mid-session).
- `speeches`: `matter` nullable; add `debate` as **text**, `is_speech bool` (false for útbýting), `speaker_abbr`, `role`, `era`. Index entry fields stored even before text is fetched (`text_fetched_at` null = pending) → the crawler's work queue is a table, resumable.
- `matters`: add `class` (A/B), `type_code`/`type_label`, `status_text`, `stub bool` (created from a speech's `<mál>` block; B-mál titles come only from there), `related`.
- `paragraphs`: speaker text only; interjections stripped from the lemma index, kept in `interjections` (display only).
- `votes(id, lthing, malnr, time, fundur, type, doc_no, result, yes, no, abstain)` + `ballots(vote_id, member_id, choice)`.
- committees, documents, laws: v2.

## 7. Findings from building the parser/schema (2026-11-10)
- **Seat kinds**: `þingmaður`, `varamaður`, and **`með varamann`** (the MP is on leave and a substitute holds the seat — NOT sitting). Party-at-time must only use þingmaður/varamaður rows. A member can have two stints with the same start date (a one-day stint and a longer one), so the uniqueness key includes `to_date`.
- **Source feeds contain exact duplicate rows** (matter 157/A/516 is listed twice) → upserts dedupe by key (last wins).
- **A and B matter numbers are separate spaces** (A 309 and B 309 both exist) → matter key is `(lthing, cls, nr)`. All 15 B-speeches of 2018-03-06 belong to one matter, B/307 "störf þingsins".
- **Lemmatizing**: lemma-is emits multi-word lemmas for hyphenated ellipsis compounds ("hljóð- og myndmiðlun"); `src/lemma.ts` splits them into single lexemes and re-applies the stopword filter (otherwise "og" leaks back into the index). Query/index property test: 0.03% of 6,265 three-word query windows miss their own paragraph (lemma-is is context-sensitive, e.g. "klukkan fimm á morgnana" is a phrase that skips tokens).
- **Interjections** (`frammíkall`) are stored separately in `paragraphs.interjections` and never indexed (decision 3).

## 8. Decisions (confirmed by user 2026-11-10)
1. v1 speech corpus = XML era (2005→). 2. Enumerate via per-member lists. 3. Interjections stay out of the index. 4. Phase 0 = small slice first, then session 157.

## 9. Open decisions (superseded list kept for history)
1. v1 speech corpus = XML era (2005→) only? Pre-2005 text needs Alþingi's help (email sent to Ásta) or IGC.
2. Enumerate via per-member lists (cheapest, whole career each) instead of per-day probing: yes?
3. Interjections: drop from index, keep for display?
4. Phase 0 slice: session 157 (~10–12k speeches ≈ 15 h) — or a smaller slice first (e.g. 10 sitting days) to iterate on parser + schema + search quality before committing the 15 h run?

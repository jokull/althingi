# Speech text 1991–2004 from the Icelandic Gigaword Corpus (IGC-Parla) — decision: GO (2026-11-11)

Fills `text` for the SGML-era index rows (sessions 115–130, `era='sgml'`, `text_state='unavailable'`, DECISIONS §8)
from the parliament subcorpus of Risamálheildin, without any request to althingi.is. Evidence: the corpus zip (md5
verified), the 59,772 index rows exported read-only from the mini, scripts in the session scratchpad (`parse_igc.py`,
`measure2.py`, `fidelity.py`). Code: `src/igc.ts`, step `scripts/ingest.ts igc --path DIR`, tests `test/igc.test.ts`,
fixture `fixtures/igc/` (CC BY excerpt, see its `LICENCE`).

## 1. Licence and provenance (decisive)

| | |
|---|---|
| Item | **IGC-Parla 2026 (unannotated version)**, http://hdl.handle.net/20.500.12537/393, CLARIN-IS repository, issued 2026-09-09, publication date in the TEI header 2026-09-01 |
| Licence | **Creative Commons Attribution 4.0 International (CC BY 4.0)** — `dc.rights` on the item page, `[LICENCE]` in the zip's README, `<availability status="free"><licence>` in every TEI file. The same licence is on every earlier version (21.05 `/111`, 21.12 `/179`, 22.10 `/208` + `/216`, 2024ext `/354` + `/355`). |
| Publisher / authors | Stofnun Árna Magnússonar í íslenskum fræðum; Hinrik Hafsteinsson, Steinþór Steingrímsson, Starkaður Barkarson. Funded by the Ministry of Education (Language Technology Programme 2019–2023). |
| File | `IGC-Parla-2026.TEI.zip`, 630.8 MB, md5 `b50a7758f19bb66bcc0cd2d492ac7505`; 19,758 TEI day files, 613,197 speeches, 269.8 M words, 1909-01-01 – 2025-12-31. The annotated twin (`.ana`, POS/lemma/UD/NER) is a separate item and not needed. |
| Produced from | althingi.is HTML (ParlaCLARIN 2020 paper, Steingrímsson et al.: "all the speeches on the website are available in HTML files"; pre-1937 speeches OCR-read from Alþingistíðindi). Every utterance carries `source=` = the althingi.is URL of the speech; for 1991–2004 that is the `.sgml` link we already store. |

**Verdict: public display + MCP redistribution of derived text is permitted.** CC BY 4.0 asks only for credit, a licence
link and a note of changes. Attribution text (shipped in `/um` and `ATTRIBUTION` for llms.txt; the MCP `corpus`
block and the Markdown footer get the same sentence at deploy time, §7):

> Ræðutexti 1991–2004 (þar sem hann er til): Íslenska risamálheildin, þingræðumálheild (IGC-Parla 2026), Stofnun Árna
> Magnússonar í íslenskum fræðum, CC BY 4.0, http://hdl.handle.net/20.500.12537/393 (klippt úr TEI-skrám, málsgreinaskipt).

Not a BÍN-style restriction: the text is the public parliamentary record; the licence covers the compilation.

## 2. Coverage and metadata

- Granularity: **one TEI file per sitting** (`<year>/IGC-Parla_<date>-<fundur>.xml`; `-unreg` for irregular meetings,
  `-upper`/`-lower`/`-uni` for the two-chamber era before 1991), one `<u>` per utterance, one `<seg>` per paragraph.
- Per file: session (`<meeting ana="#parla.session" n>`), meeting number, term, date (sourceDesc), word/speech counts.
- Per `<u>`: `xml:id`, `who` (→ `listPerson` in `IGC-Parla-2026.xml`: name, sex, birth, party/constituency/minister
  affiliations with dates, and **`<idno type="URL">…cv/is/?nfaerslunr=N` = our member id** for 1,171 of 1,175 persons),
  `ana` = `#chair|#regular|#guest` + `#issue.<lthing>_<nr>_M` (matter; the title is in the root taxonomy, 31,901 issues),
  `source` = althingi.is speech URL. **No start/end time, speech type or debate round** — the time is only in the URL stem.
- Inline: `<vocal type="interruption"><desc>Gripið fram í…</desc>`, `<kinesic type="ringing">`, `<note>`, `<incident>`.
- Sessions 115–130: 118,027 `<u>` in 1,732 files (the 1991–2004 year directories also hold sessions 113/114 and 131),
  95,046 distinct `source` URLs (59,611 of ours + 35,435 IGC-only). **Every `<u>` has a source.**
  A record where another speaker cut in is split into consecutive `<u>` sharing one `source` (7,076 groups, 30,057 `<u>`).

## 3. Join rule (deterministic; anything else stays unlinked)

Key = `source` URL with scheme/host stripped (`/altext/<lthing>/<dir>/<stem>.sgml`) → the one `speeches` row with that
`source_url` (59,772 rows, 59,772 distinct URLs). Group = all `<u>` with that URL, document order. Speaker check =
`listPerson` member id (`nfaerslunr`) **equals `speeches.member_id`**. Classes:

| Class | Rule | Rows | % |
|---|---|---|---|
| **A** | one `<u>`, speaker agrees | 54,886 | 91.8 |
| **A2** | several `<u>` share the URL; ≥ 1 by our member (kept, in order); other speakers' words become `interjections` ("Nafn: orð", display only, never indexed — the same treatment as `<frammíkall>`) | 4,226 | 7.1 |
| MIS | URL found, no `<u>` by our member → unlinked | 499 | 0.8 |
| NONE | no `<u>` with that URL → unlinked | 161 | 0.3 |
| **linked** | | **59,112** | **98.9** |

Per session (linked %): 115 99.1 · 116 99.9 · 117 100 · 118 97.6 · 119 98.0 · 120 99.1 · 121 99.0 · 122 98.4 · 123 98.4 ·
124 92.6 · 125 98.7 · 126 99.2 · 127 98.4 · 128 98.4 · **129 51.7** (87 rows, two days in May 2003 absent from the corpus) · 130 99.9.

- MIS is almost entirely four IGC persons without an `idno` (Ísólfur Gylfi Pálmason = member 274 is 0.6 pts alone).
  A name-based alias would link them; left for a human alias decision, never guessed by code.
- NONE: 44 rows on days with no file at all, the rest on days whose file lacks that record.
- Cross-checks on the linked rows: matter number from `#issue` agrees on **47,237 / 47,237** where IGC has one (the
  remaining 11,875 are B-mál/off-agenda, no issue tag); sitting number agrees on 58,884, the 228 "disagreements" are
  IGC's `unreg` files. Neither is used as a key.
- **Tested and rejected**: a fallback on (lthing, date, stem-time ± 60 s, speaker name) matched **0** additional rows —
  do not re-add a fuzzy key.
- **Spot-check: 30 random linked rows (seed 7, 26 A + 4 A2) read against speaker, type and matter title: 30/30 correct, 0 errors.**

## 4. Text fidelity (overlap test against our XML-era text, 2018-03-06, 81 speeches)

81/81 speeches present on both sides, 0 extra. `difflib` ratio on the concatenated text: mean 0.9953, **70/81 ≥ 0.999**,
paragraph count equal 76/81 (IGC splits a few paragraphs differently). Differences: bracketed stage notes such as
`[Hlátur í þingsal.]` are dropped by IGC (we keep them as interjections only, so nothing indexed is lost); other
speakers' interjections appear as separate `<u>` ("Einmitt.", "Nei.") — the A2 model; **1/81 (`rad20180306T134533`,
ratio 0.76) is substantively rephrased**: IGC captured an earlier revision of the HTML than the final XML. For
1991–2004 the SGML has been static for 20+ years, so this risk is small but not zero. No OCR noise, no hyphenation
artefacts (the SGML era is born-digital).

## 5. Provenance, precedence, idempotency (implemented)

- `text_source = 'igc-parla-2026'` (`IGC_VERSION`), `provisional = false`, `era` stays `sgml`, `source_ref =
  '<file id>:<kept u ids>'` (e.g. `IGC-Parla_1999-03-02-75:u15,u17`), `raw_sha256` = sha of the deterministic payload
  (kept u ids + paragraphs). Lemmatized through `saveSpeechText`, so `lemma_text`, `lemma_seq`, `paragraph_tokens`,
  `word_count` are produced exactly as for XML-era text.
- **Alþingi text always wins**: a row is written only while `text_state = 'unavailable'` or its text already came from
  IGC. A later dump/service/SGML text overwrites IGC; IGC never overwrites anything else. Rerun = sha no-op.
- Existing rows only: IGC-only records never create rows (§6).
- Lock: `dump` (zero requests; must not run beside a dump pass). ≈ 42 speeches/s of lemmatization → ≈ 25 min for all.

## 6. What IGC has that we do not (not loaded)

- **44,685 `<u>` (35,435 records) in 115–130 have no row of ours**: 4,724 chair remarks (not in per-member lists) and
  39,961 regular utterances, of which **38,438 are by 146 speakers with no `members` row and no speech at all on the
  mini** (Svavar Gestsson 3,209, Hjörleifur Guttormsson 2,149, Friðrik Sophusson 2,008, Páll Pétursson 1,880, …).
  Cause: the 115–130 index came from the per-member lists of members who served from session 131 on. Our index
  therefore covers ≈ 63 % of the era's records. They *could* become rows: id from the source URL (`sgml<l>_<dir>_<stem>`),
  member from `nfaerslunr`, date + time from the file and stem, sitting from the file name, matter from `#issue`
  (35,673 of them); missing: end time, speech type, debate round. The clean fix is 146 per-member list requests
  (`thingmadur/raedur/?nr=`) — deferred under the no-althingi.is constraint; the ids, names and IGC speech counts are
  in `docs/igc-missing-members.json`.
- Pre-1991 (two-chamber era, sessions ≤ 113): IGC has 1909–1990 with per-chamber files and `source` URLs of other
  shapes (`/altext/112/r1/1856.html`, `/altext/raeda/?lthing=107&rnr=1882`); the paper says speeches before 1991 carry
  a date only, no timestamp. We have no index rows before 115, so nothing to stitch onto; a pre-1991 corpus would be a
  new-row ingest keyed on those URLs with a new id scheme, with member ids from `listPerson` — a separate decision.
  Scoped in §8 (not actioned).

## 8. Going back before 1991 (scoped 2026-11-12, not actioned)

The owner asked whether the corpus can reach further back than session 115 (October 1991). It can, from IGC alone,
without fetching anything from althingi.is beyond the XML service. This section records the plan and its cost in case
the scope is widened. Nothing below has been started.

**State on 2026-11-12.** The corpus covers sessions 115–158 with 349,471 speeches that have text. The database is
13 GB. The mini has about 22 GB free. The `members` table goes back to session 92 (691 members), and nothing exists
before session 115. Only `1991/`–`2004/` of IGC-Parla 2026 are unpacked in `~/althingi/igc/`, and the zip itself was
deleted after unpacking.

**Steps**

1. **Re-fetch IGC-Parla 2026.** It is `IGC-Parla-2026.TEI.zip` (631 MB, md5 above) from CLARIN-IS
   (hdl.handle.net/20.500.12537/393). CLARIN-IS is not althingi.is, so the mini may fetch it, or a person can download
   it in a browser. Unpack `1909/`–`1990/` one decade at a time, or read entries straight from the zip, so the disk
   never holds the whole tree.
2. **Measure before loading** (no DB writes): per decade, count utterances, words, distinct `who`/`nfaerslunr` and
   chamber files. That turns the size estimate below into a measured number.
3. **Members and seats for sessions 1–114,** from the XML service only: one `thingmenn/?lthing=N` per session plus
   one `thingseta/?nr=` per member who is new. That is a few hundred requests, about 1–2 h at the 5 s crawl delay,
   under the crawl lock. It gives party-at-date for aggregates and filters.
4. **A new kind of row: IGC speeches with nothing in Alþingi's index to attach to.** So far the import only fills
   text into rows the Alþingi index created. Before 1991 there is no index, so rows must be created from IGC:
   - id: from the `<u source>` URL (shapes `/altext/112/r1/1856.html`, `/altext/raeda/?lthing=107&rnr=1882`), or
     from the IGC `xml:id` where there is no URL;
   - member: from `nfaerslunr`;
   - date: from the file name;
   - sitting: from the file;
   - matter: from `#issue` where present;
   - `text_source = 'igc-parla-2026'` and `index_source = 'igc'`.

   Extend `src/igc.ts` with a create-rows mode for `--from 1 --to 114`; the 1991–2004 stitching rules stay as they are.
5. Run `post`, then update the boundary wording, which is currently "frá 115. þingi (október 1991)": `TEXT_ERA` in
   `src/mcp-tools.ts`, plus `agent-docs.ts`, `markdown.ts`, `pages.tsx` and `agent-pages.tsx`.

**What these rows lack, compared with Alþingi rows**

- **Time:** dates only (the IGC paper: no timestamps before 1991). The `started` column takes midnight plus the
  utterance order, and pages show the date only.
- **Speech data:** no speech type, no debate round, no end time. The matter is known only where IGC tags `#issue`.
- **Chamber:** until 1991 Alþingi had two chambers plus a combined session (efri deild, neðri deild, sameinað
  þing). That needs a new column (e.g. `chamber`) on speeches and speech_index, and a filter.
- **Text quality:** older decades are OCR'd from Alþingistíðindi. Expect noisy text and weaker lemma matching from
  1909 to roughly the 1970s.
- **Links:** most of these rows have no althingi.is deeplink.

**Disk is the binding constraint.** 13 GB holds about 350k speeches, so roughly 37 KB per speech, all tables and
indexes included. IGC has about 613k speeches in total, so roughly 260–270k fall before 1991. Loading all of them
would add about **8–10 GB** and leave the mini with about 12 GB free (it was at about 94 % disk use on 2026-11-11).
Options:

- **(a) Everything, 1909–1990:** about 8–10 GB.
- **(b) From about 1959 on:** about half the cost, and the cleaner OCR.
- **(c) Everything, but lean for the old era (recommended at scoping):** load `paragraphs` and `speech_index` (FTS
  and the GIN index), but skip `paragraph_tokens` / `paragraph_index` positions for era = `igc-pre1991`. That roughly
  halves the size. Phrase and proximity search over pre-1991 text falls back to slower verification; everything else
  works.

If step 2's measurement shows a tighter disk than estimated, fall back from (c) to (b).

## 7. Deploy steps (owner)

1. Merge; `bun install` on the mini if needed. No migration (all columns exist since 0006).
2. Download `IGC-Parla-2026.TEI.zip` from the handle (a person in a browser, as for the Alþingi dump), verify the md5,
   unzip to `~/althingi/igc/IGC-Parla-2026.TEI/` (only `IGC-Parla-2026.xml` + `1991/`–`2004/` are needed, 1.1 GB unpacked).
3. `bun scripts/ingest.ts igc --path ~/althingi/igc/IGC-Parla-2026.TEI --lthing 123 --limit 50`, read a few
   `/raedur/sgml123_…` pages, then the full run (`--from 115 --to 130`, ≈ 25 min), then `bun scripts/ingest.ts post`.
4. Copy that is now wrong and should change in the same deploy (not changed here because `test/web.test.ts` pins it and
   the MCP files were off limits): "Ræðutexti er til frá 2005" in `src/pages.tsx` (footer, `/um`, search help),
   `src/agent-docs.ts` (llms.txt corpus line, `Dataset` name), `src/markdown.ts` `FOOTER`, and the MCP `corpus.text_from`
   / `why: text_corpus_starts_2005` in `src/mcp-tools.ts`. Suggested wording: "Ræðutexti frá 2005 úr gögnum Alþingis;
   1991–2004 úr Risamálheildinni (IGC-Parla, CC BY 4.0), 98,9 % ræðna sem skráðar eru." Speech pages should show
   `text_source` for IGC rows as they do for provisional ones (`queries.ts` already returns it).
5. `sessionState()` counts only `era='xml'`; sessions 115–130 stay "not complete" for caching purposes, which is fine.
6. **MCP (off limits in this change, for the agent editing `src/mcp.ts`)**: `get_speech` and `get_context` validate
   `speech_id` with `/^rad\d{8}T\d{6}$/`; they must accept `sgml\d+_\w+_r\w+` too (use `isSpeechId` from `queries.ts`,
   which the web `/raedur/:id` route and the `.md` twin now use — verified by `test/web.test.ts`: an IGC-filled 1999 speech
   renders, has a Markdown twin and is a `/leit.json` hit). Until then `search_speeches` returns 1991–2004 hits whose ids
   `get_speech` rejects.

# What lemmatized + disambiguated Alþingi speeches make possible

Brainstorm, 2026-11-10. Ranked within each theme (best first). Effort S = a day, M = a week, L = multi-week. "Strong" = explicit ids in the source; "inferred" = derived by us and labelled as such in UI and MCP, always. **Model** column: `none` = lemma-is + Postgres is enough; `better` = works without a model, gets meaningfully better with one; `needs` = impossible without a model. Not a plan; see STRUCTURE.md for what exists.

Three facts shape everything below:
1. The index today is an **all-candidates, deduplicated** lemma set per paragraph (`indexLemmas` returns a Set, `indexAllCandidates:true`, `includeNumbers:false`). Great for recall; useless for phrases, proximity, counts, trends and numbers. Most "wow" ideas need a **second representation**: an ordered best-guess token stream (`processText` → disambiguated lemma, POS, morph, confidence, offsets) per token.
2. BÍN licence: *do not publish inflection paradigms*. Any "word" page shows **forms observed in the corpus**, never the BÍN paradigm. Credit Árnastofnun in the footer.
3. Derived annotations (topics, stance, entity links, similarity, rerank scores) live in a separate **enrichment layer** (§6), never in source tables, so models can be swapped and labels never masquerade as facts.

## 1. Indexing and ranking

| # | Idea | User sees | Powered by | Effort | Risk | Links | Model |
|---|---|---|---|---|---|---|---|
| 1 | **Two-layer index**: keep the recall tsvector; add `tokens(speech_id, seq, pos, lemma, surface, wc, case, conf)` (~40–60 M rows, partition by lthing) | Precise counts, trends, phrases, "as a verb" filters; recall unchanged | `processText` with `includeOffsets`; best-guess lemma per token | L | ≈ 3–5 GB with indexes; lemma-is is not a parser, so POS/case are guesses — store `conf` | n/a | none |
| 2 | **Group hits by speech** (best 2 paragraphs, "+3 more in this speech") | One row per speech instead of the same speech 5× | `max(ts_rank_cd)` per speech via lateral subquery, snippets on ≤ 2 paragraphs | S | None | strong | none |
| 3 | **Query understanding → structured routing**: `lög nr. 46/2016`, `þskj. 421`, `mál 300`, `157/300`, member name, party abbreviation, date | A law number lands on the law page with every matter that amended it; a name lands on the member | Regex + `members.name` trigram + `breytingaráLögum`, documents, matters. Numbers are **not in the FTS index**; this is the only way they resolve | S/M | Namesakes → disambiguation chip | strong (laws/docs/matters), inferred (names) | none |
| 4 | **Field weighting** with `setweight`: A = matter title lemmas, B = body, first paragraph *demoted* (every speech opens "Virðulegur forseti") | A query matching the matter title ranks the whole debate above a stray mention | One speech-level generated tsvector besides the paragraph one | S | Doubles GIN size | strong | none |
| 5 | **Show the expanded query** ("leitað að: *húsnæði* OR *húsnæðislán*, AND *vextir*") with one-click group removal | Trust; users learn what lemmas do | `queryGroups`/`tsquery` already returned by `search.ts` | S | None | n/a | none |
| 6 | **Boosts**: debate stage (1./2./3. umræða > um fundarstjórn), role (flutningsræða/framsögumaður > andsvar), length (short "grein fyrir atkvæði" are noise); "Nýjast fyrst" is a sort, not a boost | Substantive speeches float up | Multiply `ts_rank_cd` by per-type factors; `type`, `debate`, `role_kind`, `word_count` are columns | S | Over-tuning; keep a 20-query golden set | strong | none |
| 7 | **BM25 vs ts_rank_cd**: try `pg_textsearch`; if the macOS build fails, length-normalise with `ts_rank_cd(..., 2\|32)` | Long budget speeches stop winning on term count | Phase-0 side by side on the golden set | S/M | Extension needs a restart (planitor bounce) | n/a | none |
| 8 | **Phrase and proximity** (`"húsnæðislán" <2> vextir`) | Quotes and a near-operator | Needs 1.1 (positional, non-deduped) or a positional `lemma_seq` tsvector | M | lemma-is phrase skips ("hér á landi" is a stopword phrase) break some phrases → quoted strings also try surface `ILIKE` on `paragraphs.text` | n/a | none |
| 9 | **Compound-aware query modes**: default (word + parts), "aðeins heilt orð", "öll samsett orð með -lán" (free hyponym browser) | Chips under the search box | Corpus vocabulary of compounds and parts from `CompoundSplitter`, stored once per distinct surface form | S | False splits → show the split, let the user turn it off | n/a | none |
| 10 | **Did-you-mean** from the corpus lemma vocabulary + unknown-word flag | "Ekkert fannst fyrir *húsnæðsilán* — áttirðu við *húsnæðislán*?" | `pg_trgm` over `lemma_vocab(lemma, df)`; `lemmatize(w)[0] === w` detects unknowns | S | None | n/a | none |
| 11 | **Synonyms/hyponyms**: efnisflokkar `<lýsing>` lists ("þ.m.t. bankar, einkaleyfi, lán…") as a free controlled vocabulary; compound heads as hyponyms; no Icelandic WordNet shipped | "Tengd orð" chips, opt-in, never auto-applied | Stored once | S | Over-expansion kills precision | strong (categories) | better (embedding neighbours as candidates) |
| 12 | **Morphology facets**: "only as verb" (`á` → eiga vs á), "only dative" | Sidebar facets on POS/case | 1.1 columns | M | Guesses from a non-parser; show "giskað, 0.7" | n/a | none |
| 13 | **Rerank the top 50** of a lemma search (cross-encoder, or a decision model choosing best-of-N) | Better top-10 for ambiguous one-word queries | Enrichment layer, query-time, cached per (q, filters) | M | Icelandic quality UNVERIFIED for every candidate; adds 100–500 ms to the 120 ms budget → async swap of the top block only | n/a | needs |

## 2. Linking and crawlable structure

| # | Idea | User sees | Powered by | Effort | Risk | Links | Model |
|---|---|---|---|---|---|---|---|
| 1 | **Canonical URLs** (correct the design doc: `cls` is part of the matter key): `/raeda/rad20250911T103151#mgr-4`, `/mal/157/a/300`, `/mal/157/b/307`, `/thingmadur/633`, `/dagur/2018-03-06`, `/thing/157`, `/flokkur/<id>`, `/efni/<efnisflokkur>`, `/ord/<lemma>`, `/atkvaedagreidsla/47851`, `/log/2016/46`, `/thingskjal/157/421` | Permanent, guessable links; the paragraph is the quote unit | Source ids only; the `r2025-…` attribute as an alias redirect | S | None | strong | none |
| 2 | **Related speeches by lemma TF-IDF** (query-by-document): top-12 distinctive lemmas of a speech as a tsquery, precomputed, 10 ids per speech | "Svipaðar ræður"; the site becomes a dense graph for crawlers | `lemma_vocab.df` for IDF; batch after ingest | M | Generic speeches get generic neighbours; exclude same matter | inferred | better (embeddings) |
| 3 | **Auto-link entities in text**: members ("hv. þm. Kolbrún Baldursdóttir", genitive forms, `skst`), law numbers, "þskj. N", matter titles within the same lthing | Inline dotted-underline links | Regex + name-form table built with `lemmatizeWithMorph`; link only when unique among that lthing's sitting members | M | Namesakes, "ráðherra" without a name | inferred | better (entity linking for the ambiguous residue) |
| 4 | **Word pages `/ord/<lemma>`**: observed forms, count by year, top speakers/parties, first/last use *in this corpus*, compounds containing it | An Althingi dictionary of use | 1.1 or counts from the tsvector | S after 1.1 | BÍN licence (observed forms only) | n/a | none |
| 5 | **SEO/LLM crawl layer**: sitemaps per lthing (immutable past sessions), JSON-LD (`Legislation`, `Person`), `llms.txt` + `/llms-full/<lthing>.txt`, canonical links, strong ETags, `s-maxage=1y` for past sessions | Fast indexing by Google and agent crawlers | Already in the perf design; add the files | S | None | strong | none |
| 6 | **Matter graph**: `tengdMál`, laws amended, documents, votes, committee requests on `/mal/…` with reverse links (`/log/1991/34` → every amending matter) | From a law to its legislative history | Matter detail XML (≈ 28 k optional requests) | S | Crawl time | strong | none |
| 7 | **Party lineage** (renames/mergers) as a curated table | Party pages continue across renames with a note | Hand-written `party_lineage` | S | Political judgement; keep small and sourced | curated | none |

## 3. Presentation

| # | Idea | User sees | Powered by | Effort | Risk | Links | Model |
|---|---|---|---|---|---|---|---|
| 1 | **Orðanotkun / ngram viewer**: lemma(s) over time by party or member, per 10 k words, "incl. compounds" toggle | The Google-ngrams moment for Icelandic politics | 1.1 → `mv_lemma_year_party`; whole-word vs part flag per row | M | Part hits inflate "lán"; normalise per words spoken | strong (party-at-date) | none |
| 2 | **Matter timeline** `/mal/157/a/300`: speeches by stage, documents, votes with results, committee consults, related matters, laws amended on one axis | The whole life of a bill on one page | Matter detail + speeches + votes | M | Documents v2 → render ids + source links until then | strong | none |
| 3 | **Debate threads**: ræða + following andsvör + svar grouped by order within (fundur, matter); labelled "líklega andsvar við …" | Readable back-and-forth | Order by `started`; decode `frhr`/`tegr`/`tegflm` first | S/M | Inferred | inferred | none |
| 4 | **Vote views**: grid by party; keep nei / greiðir ekki atkvæði / boðaði fjarvist / fjarverandi distinct; "rebels" = ballots against the party majority | Who broke ranks | ballots × party-at-date | S | Never collapse to "abstain" | strong | none |
| 5 | **Member profile**: speaking minutes (strong: `started`/`ended`), speeches by type/stage, party stripe, distinctive lemmas (TF-IDF vs the house), efnisflokkur topics, voting-with-party %, substitute stints | A fair, numeric portrait | Materialised views | M | Exclude `um fundarstjórn`/presiding from topics; "ráðherra" when no seat | strong + inferred | better (topic labels on B-mál speeches) |
| 6 | **Quote permalinks and cards**: `/raeda/<id>#mgr-4`, server-rendered text-only OG card, highlight-in-place with `?q=` | Shareable, cite-able paragraphs | `highlight()` on one paragraph | S | None | strong | none |
| 7 | **Day view `/dagur/…`**: agenda in order, votes inline, B-mál grouped | "What happened on Tuesday" | `speeches_date` index | S | Hide útbýting rows | strong | none |
| 8 | **"Who first said X" / phrase across years**: first corpus occurrence + sparse year strip | Trivia journalists love | 1.1 or 1.8 | S after 1.1 | Must read "fyrst í þessu safni (2005→)" | n/a | none |
| 9 | **Compare two members/parties on a word** (`/ord/lán?vs=633,7`) | Two sparklines, two quote columns | Same MV as 3.1 | S after 3.1 | Small-n noise; show counts | strong | none |
| 10 | **Keyboard-first, instant feel**: `/` focuses search, `j/k` through hits, `Enter` swaps the speech into a side pane via `hx-get`; speculation-rules prefetch; filters are partial swaps at `/leit/rows` | Feels like planitor | htmx + ~2 KB JS; all state in the URL so Cloudflare caches it | S | None | n/a | none |
| 11 | **Accessibility, text-only**: semantic `<article>`/`<time>`, `<mark>` with `aria-label`, no colour-only meaning in vote grids, reduced-motion honoured | Works with screen readers and in Lynx | CSS only | S | None | n/a | none |
| 12 | **Topic lens on B-mál and uncategorised speeches**: "störf þingsins" speeches tagged with an efnisflokkur, shown as "líklega um: Húsnæðismál" | Browsable topics where the source has none | Enrichment layer (§6), closed-set classification into the source's efnisflokkur taxonomy, per paragraph | M | Wrong labels on satire/irony; show confidence, allow "rangt?" feedback | inferred | needs |

## 4. MCP / agent UX

| # | Idea | Agent gets | Powered by | Effort | Risk |
|---|---|---|---|---|---|
| 1 | **`explain_query(q)`** → lemma groups, tsquery, unknown words, phrase skips, numbers routed to entities | Verifies what matched before trusting hits | `queryGroups` exists | S | None |
| 2 | **Cite-able ids**: `speech_id` + `seq`; every hit carries `source_url` and our canonical URL; `get_context(speech_id, seq, before, after)` | Evidence packages with exact paragraphs | Existing tables | S | None |
| 3 | **`aggregate`** over the token MV: `count(lemma, group_by=year\|party\|member, filters)` ≤ 50 buckets with the normaliser | Trend questions answered numerically | 1.1 + MV | M | `derived: true` flag on every inferred bucket |
| 4 | **Resource URIs** `althingi://raeda/<id>`, `althingi://mal/157/a/300`, `althingi://thingmadur/633`, `althingi://ord/<lemma>`; cursor-paged lists; `total` stays "1000+" | Stable handles across sessions | Hono routes reused | S | None |
| 5 | **`get_matter_timeline`**, **`get_vote`** (ballots with party-at-date), **`get_annotations(id)`** returning enrichment rows with model + confidence | Structured, labelled derived data | §3.2/3.4 + §6 | S | Documents v2 |
| 6 | **Evidence budget flags**: `max_bytes`, `paragraphs=[from,to]`, `snippets_only` | ≤ 8 KB payloads by default | Already in design | S | None |

## 5. Data-quality traps and the hedges

- **Party-at-time**: join `seats` on the speech/vote date, kind in (þingmaður, varamaður); `með varamann` = on leave. Utanþingsráðherrar have no seat → show "ráðherra", not an empty party. The search party filter must use the same join, not `lthing`.
- **Role speeches**: forseti, "um fundarstjórn", "um atkvæðagreiðslu", "grein fyrir atkvæði" inflate counts; exclude from topic profiles and trend denominators by default, with a toggle.
- **Interjections** never indexed or counted; rendered muted with the interjector's name when parseable.
- **B-mál**: titles only from speech `<mál>` blocks (`stub`), no documents/votes; "störf þingsins" is one matter per day with unrelated speeches → never a topic by itself (hence 3.12).
- **Útbýting þingskjala** rows and duplicate feed rows filtered at ingest; count mismatches vs althingi.is explained on `/um`.
- **Compound false splits** and all-candidates overindexing (`á` → á/eiga/ær): recall side only; every precision claim (trends, first use, word pages) reads the best-guess stream and shows the expanded query.
- **lemma-is phrase quirks**: stopword phrases ("hér á landi"; "fyrst og fremst" → "snemma og fremri") drop or mangle tokens; 0.03 % of three-word windows miss their own paragraph. Hedge: quoted queries also try surface `ILIKE`; "0 hits" always shows the expansion.
- **Numbers skipped**: no "2016" in the index; numeric queries go through routing (1.3).
- **Timestamps** naive local = UTC; speech ids are filename stems; namespace-prefixed XML variant exists; **SGML era absent** → every "first/ever/total" reads "frá 2005".
- **Upstream edits**: keep `raw_sha256`; a changed text is a visible revision, not a silent replace.
- **Derived labels drift**: a model upgrade changes topic labels on old speeches → keep both rows (§6), show "merkt af <model> <date>".

## 6. Models that are now cheap enough for ~250 k speeches (≈ 1 M paragraphs, ≈ 150 M words, likely 300–450 M BPE tokens — unmeasured; Icelandic tokenises at 2–3 tokens/word)

Vendor-neutral rule: **lemma-is + Postgres is the product; models are optional enrichment.** Everything a model produces goes into `annotations`, never into source tables, and is labelled derived in UI and MCP.

| Class | Enables | Cost / latency order | Icelandic quality | Fits | Where lemma+PG already suffices |
|---|---|---|---|---|---|
| **Fast closed-set decision models** (e.g. Jev, TypeSafe AI; early access 2026-09; choice ≤ 255 options / score / 0–1 "noul" with confidence; vendor figures: $0.042 per M input tokens, output free, 70–500 ms, hosted API only; "no EU region, no self-host" per one aggregator, not confirmed in docs; docs warn of context rot — unrelated material in the state costs accuracy — and non-determinism) | Topic → efnisflokkur, procedural vs substantive, stance/tone, "which member is this mention", quality gates (does this phrase skip need a fallback?), best-of-N rerank | Whole corpus ≈ **$15–20 per pass** per question set at the vendor price; a full pass in hours. No text, no explanation; classify per paragraph, not per 43-paragraph speech (context rot) | **UNVERIFIED**: the official model-limitations page checked (docs.typesafe.ai/model-jaggedness/jev-1.13) says nothing about languages; a third-party source attributes "other languages handled but not equally well" to TypeSafe; no public benchmarks; one third-party report found Gemini slightly more accurate on business email classification | Closed-set labels at volume where a wrong label is cheap and visible | Keyword search, counts, trends, routing, strong-link pages — Jev adds nothing there |
| **Embeddings / multilingual retrieval** (bge-m3, multilingual-e5, Jina v3, Snowflake-arctic multilingual) | "Svipaðar ræður", semantic query fallback when lemma search returns 0, candidate synonyms | 1 M paragraphs: hours–days on the mini CPU per model, or ≈ $10–50 hosted; pgvector HNSW ≈ 1–3 GB | UNVERIFIED for Icelandic; bge-m3/e5 likely include Icelandic in training data (not checked), never evaluated by us | 2.2, 1.11, 1.13 candidates | TF-IDF neighbours (2.2) are 80 % of the value for free |
| **Rerankers / cross-encoders** (jina-reranker-multilingual, bge-reranker-v2-m3, Cohere rerank) | Better top-10 ordering | Query-time, top 50 pairs ≈ 100–500 ms, $1 per 1 k queries hosted | UNVERIFIED | 1.13 only | Boosts (1.6) + BM25 (1.7) first; measure before paying latency |
| **LLM structured extraction / summarisation** (small cheap models: Haiku-class, Gemini Flash-class, local 7–9 B) | One-line speech summaries, claim extraction, "what was promised", matter abstracts, andsvar parent detection with reasons | ≈ $0.10–1 per 1 M tokens → **$6–60 per corpus pass**; seconds per speech | Gemini is reported strongest at Icelandic (user's own experience; not benchmarked here); small local models weak | Summaries on member/matter pages, 3.3 as a labelled upgrade | Snippets, highlights, timelines need no LLM |
| **Speech/audio alignment** (whisper-class forced alignment; `hljóð`/`vod` links exist per speech) | Click a paragraph → play that second of the video; corrects transcript/audio drift | Whole corpus ≈ 15–25 k hours of audio (250 k speeches at a few minutes each): weeks of local compute or thousands of dollars hosted → **current session only** | Icelandic ASR exists (Whisper, Samrómur-trained models) but alignment accuracy UNVERIFIED | Paragraph-level deep links into althingi.is video | Speech-level `vod_url` is already a strong link |
| **Entity linking / coreference** | "hv. þingmaður", "ráðherrann", "frumvarpið" resolved to member/matter ids inside text | Decision model or small LLM over mention windows, ≈ $3–30 per pass | UNVERIFIED | 2.3 residue after regex/uniqueness rules | Unique-name regex + `skst` + sitting-members-at-date covers most mentions |
| **Local on-box models** (16 GB mini, lemma-is already takes 220 MB; ~6 GB free for a model) | Embeddings (bge-m3 fits), small rerankers, 3–4 B LLMs in Q4 for offline batch jobs; no vendor, no egress | Free but slow: embeddings ≈ 50–200 paragraphs/s on M-series CPU/ANE; batch at night under `taskpolicy -b` | Same as above per model | Nightly enrichment of the current session; never query-time | n/a |

**Enrichment layer (minimal shape):**

```
annotations(id bigserial, target_kind text ('speech'|'paragraph'|'mention'), target_id text, seq int null,
            kind text ('topic'|'procedural'|'stance'|'entity'|'similar'|'summary'|'rerank_score'),
            value jsonb, confidence real, model text, model_version text, run_id text, created_at timestamptz)
  unique (target_kind, target_id, coalesce(seq,-1), kind, model, model_version)
annotation_runs(run_id PK, model, model_version, prompt_sha256, started, finished, n_targets, cost_usd, notes)
```
Rules: one row per (target, kind, model version) — old rows stay, UI shows the newest run per kind with its confidence badge; source tables never get a derived column; a feature reads `annotations` with `left join` and renders without it (fallback = lemma + Postgres behaviour); MCP returns `derived: true, model, confidence` on every annotated field; re-run = new `run_id`, diff old vs new before switching the default. Jev-shaped jobs map to `kind` ∈ topic/procedural/stance/entity/rerank_score; an embedding goes to a sibling `embeddings(target…, model, vector)` table.

## Build first (wow per week)

1. **Group by speech + expanded-query chip + query routing** (1.2, 1.5, 1.3) — one week; fixes the three most visible search embarrassments. *Model: none.*
2. **Canonical URLs with paragraph anchors, quote permalinks, day view, SEO layer** (2.1, 3.6, 3.7, 2.5) — crawlable web before the backfill finishes. *Model: none.*
3. **Token table (1.1) on session 157 only**, then `/ord/<lemma>` and the ngram viewer (2.4, 3.1) — the headline feature; one session first to measure size and speed. *Model: none.*
4. **Matter timeline + vote grid with party-at-date** (3.2, 3.4) — strong links only, zero inference. *Model: none.*
5. **MCP `explain_query`, `get_context`, `aggregate`** (4.1–4.3) plus the empty `annotations` table (§6) so the first model experiment (topic lens 3.12 on one session, under $1) has somewhere to land. *Model: better, not required.*

## Skip for now

- **Embeddings over all paragraphs** — unverified Icelandic quality, days of compute per model change, keyword users rarely ask semantic questions; revisit as a rerank-only probe after a blind 20-query test.
- **Morphology facets in the search sidebar** (1.12) — POS/case are guesses from a non-parser; a facet wrong a quarter of the time erodes trust. Keep the data, hide the facet.
- **Andsvar threading as the default layout** — inferred ordering breaks on interleaved matters and procedural interruptions; a labelled alternate view only.

## Open questions

1. Jev: should one cheap corpus pass (efnisflokkur classification on 157, scored against the source's own category labels on A-mál as ground truth) be the first model experiment? That is a free Icelandic eval using strong links.
2. Token table scope: all speeches (~50 M rows) or current session + on-demand backfill? Disk and reindex time on the mini are the constraint.
3. Are corpus-observed inflected forms on `/ord/` acceptable under the BÍN terms as the user reads them, or counts only?
4. Decode `frhr`, `tegr`, `tegflm` on the speech root — do they encode andsvar parent or speaker type? Would turn 3.3 from inferred to strong.
5. Crawl matter detail (≈ 28 k requests, ~1.6 days) in v1 to unlock 2.6/3.2, or defer with documents to v2?
6. Hosted models and data residency: speeches are public, but is sending them to a US-only API acceptable, or local-only enrichment?

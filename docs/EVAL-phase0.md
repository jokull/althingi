# Phase 0 search evaluation, v5

Corpus: 680 speeches / 1,896 paragraphs, 8–19 June 2026 (lþ. 157). Input: `eval-dump5.json`. Ground truth: `ILIKE` on `paragraphs.text`. Per-hit judgements in `test/golden/judged.json`. Rubric unchanged: RELEVANT only if the paragraph substantively engages the topic (quoted queries: contains the exact phrase); list mentions, passing jabs, bill-title boilerplate and other-sense matches are NOT.

Engine history. v1 baseline. v2: full-token quoted phrases; compound parts to weight D (0.1); numbers within 4 tokens; 1.5x exact-phrase boost. v3: number window 8; short-paragraph factor; weight D 0.3. v4: `ts_rank_cd` flag 0 (net regression, reverted). **v5: v3 settings + indexed lemma fields are multisets (one entry per occurrence, so positions carry term frequency); lexeme set unchanged.**

## Per-query history (P@5 = relevant / min(5, returned))

| id | query | v1 | v2 | v3 | v4 | **v5** | v5 verdict | v5 vs v3 |
|----|-------|----|----|----|----|--------|------------|----------|
| q01 | húsnæðislán vextir | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | PASS | same |
| q02 | verðbólga | 5/5 | 5/5 | 5/5 | 4/5 | 5/5 | PASS | **better quality**: all five now multi-mention, focused paragraphs; the 96-char list item no longer leads a hit |
| q03 | veiðigjald | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | PASS | neutral; new rank 1 (veiðigjöld ×2) is on-topic |
| q04 | strandveiðar | – | – | – | – | – | n/a-TN | |
| q05 | kvótakerfi | – | – | – | – | – | n/a-TN | |
| q06 | hælisleitendur | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | PASS | same |
| q07 | loftslagsmál | 0/1 | 0/1 | 0/1 | 0/1 | 0/1 | FAIL (corpus-limited) | same |
| q08 | orkuskipti | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | PASS | same |
| q09 | vindorka | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | PASS | same (Halla Hrund back at rank 1 vs v4) |
| q10 | Landspítali biðlistar | – | – | – | – | – | n/a-TN | |
| q11 | leikskólar | 1/5 | 1/5 | 1/5 | 1/5 | 1/5 | FAIL (corpus-limited) | **worse order**: rad20260612T114236 (leikskól* ×4, an apology for the leikskóli metaphor) is rank 1 above the one substantive hit |
| q12 | kennarar kjarasamningar | – | – | – | – | – | n/a-TN | |
| q13 | lögreglan | 2/5 | 2/5 | 2/5 | 1/5 | 2/5 | FAIL (corpus-capped at 3/5) | same list as v3; rad20260612T182450 still absent |
| q14 | Evrópusambandið aðildarviðræður | 4/5 | 4/5 | 4/5 | 4/5 | 4/5 | PASS | **worse order**: passing rad20260612T211040 (ESB ×3, aðildarviðræður ×2, fjármálaáætlun procedure) is rank 1 |
| q15 | bankar einkaleyfi | – | – | – | – | – | n/a-TN | |
| q16 | rafmagn Reykjanes | – | – | – | – | – | n/a-TN | |
| q17 | fjárlög 2026 | 3/4 | 2/2 | 3/3 | 3/3 | 3/3 | PASS | same set, reordered |
| q18 | "hér á landi" | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | PASS | identical |
| q19 | "virðulegi forseti" | 4/5 | 5/5 | 5/5 | 4/5 | 5/5 | PASS | identical to v3 (v4 regression gone) |
| q20 | "ekki er allt sem sýnist" | 0/5 | – | – | – | – | n/a-TN | |

## Gate

True negatives (n/a): q04, q05, q10, q12, q15, q16, q20 = 7. Scored: 13. Pass: q01, q02, q03, q06, q08, q09, q14, q17, q18, q19 = 10. Fail: q07, q11, q13.

- **All scored queries: 10/13 = 0.77 → gate NOT met.** History: v1 0.64, v2 0.77, v3 0.77, v4 0.77, v5 0.77.
- **Excluding corpus-limited q07, q11: 10/11 = 0.91.**
- **q13 is also corpus-capped.** The slice has exactly three paragraphs that substantively engage the police (rad20260612T185706, rad20260610T195159, rad20260612T182450); the other seven `lögregl*`/`löggæsl*` paragraphs are bill-title intros, list mentions, "starfsferil í lögreglunni", a neighbourhood "lögreglustöð". Best achievable P@5 is 3/5, so q13 cannot pass under this rubric on this corpus. **Excluding all three corpus-limited queries: 10/10.** Relevant-hit total across scored queries: 39 (v3) → 36 (v4) → 39 (v5).

## Is v5 a net improvement over v3? Marginally yes on content, with a new ordering risk; not on the gate.

- **Better:** q02 is now five focused, multi-mention paragraphs instead of mixed one-mention hits, and the within-hit paragraph order improved (seq 14 before the one-line seq 23 is gone entirely). q03 gained a two-mention paragraph. The v4 regressions (q09, q19) are gone.
- **No change:** q01, q06, q07, q08, q09, q17, q18, q19 and all true negatives. Precision counts are identical to v3 on every query.
- **Worse (the predicted opposite failure):** term frequency now puts a non-relevant repetitive paragraph at rank 1 in two queries. q11: rad20260612T114236 (four `leikskól*` tokens, all about the *metaphor*) outranks Guðrún's leikskólavandi paragraph. q14: rad20260612T211040 (Evrópusamband ×3) outranks the four direct referendum paragraphs. Neither changes P@5, both change what the user sees first.
- **q13 did not move.** After the reindex, `lemma_parts` for rad20260612T182450 still contains **one** `lögregla` for **four** text tokens: `lögreglustjóraembættin`, `lögreglustjóraembættum`, `lögreglustjóri`, `ríkislögreglustjóri`. The multiset works (other repeated lemmas now appear three times), but the compound splitter only decomposes the plain binary `lögreglu+stjóri`; three-part compounds and prefixed ones yield nothing. Measured with the engine's weights: ts_rank_cd(flag 1) = 0.053 for 182450 vs 0.074 for the rank-5 hit rad20260610T195159.

## Smallest remaining change

**Recursive compound splitting in the indexer**: when a compound decomposes to `X+Y`, also decompose X and Y if they are themselves compounds, and strip productive prefixes (`ríkis-`, `höfuð-`, `aðal-`). For rad20260612T182450 this yields four `lögregla` D-positions instead of one; at 0.3 each under flag 1 it would land around rank 2 in q13 (≈0.2 vs 0.185 for rank 2). That raises q13 to its corpus ceiling of 3/5. The gate figure stays 10/13 because the ceiling is below the 4/5 threshold; the honest gate statement for this slice is 10/10 on non-corpus-limited queries.

A second, optional change would address the new ordering risk without touching precision: cap the term-frequency contribution per paragraph (e.g. count at most two positions per lexeme at weight A, one at D), so a four-mention metaphor cannot outrank a one-mention substantive paragraph. Evidence: q11 rank 1 (leikskól* ×4 vs ×1), q14 rank 1 (ESB ×3 vs ×1).

## Remaining defects, ranked

1. Compound splitter stops at the first binary split (q13): `lögreglustjóraembættin`, `ríkislögreglustjóri` yield no `lögregla`.
2. Uncapped term frequency promotes repetitive off-topic paragraphs to rank 1 (q11, q14).
3. Bill-title boilerplate via `-lög` compounds (q13 rank 4, rad20260609T130952).
4. Within-hit paragraph order still by raw score (q11: seq 7 before the leikskólavandi seq 6).
5. Candidate-lemma noise (D6): `bankar → banka`, `vextir → vöxtur`; no observed harm in five rounds.

## What works

- Phrase search end to end (q18, q19 5/5, q20 genuine zero); exact-form boost holds under flag 1.
- Number proximity at 8 tokens (q17 3/3, no false positives).
- Recall vs ILIKE complete on q01, q03, q06, q08, q09, q17; all seven zero-hit queries are genuine true negatives.
- Term frequency improves q02/q03 when the repeated term is the paragraph's subject.

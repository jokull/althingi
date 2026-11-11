-- 0005: compound constituents move to their own low-weight field; lemma_seq now keeps stopwords.
-- Evidence: docs/EVAL-phase0.md D2 — constituents of known compounds polluted precision (lýðræði -> ræða,
-- niðurstaða -> staða, lögreglulög -> lögregla). Constituents stay searchable (hælisleitendakerfi is still found by
-- "hælisleitendur") but at tsvector weight D, so real word matches rank above them.
-- The stored generated column is rewritten: apply while no crawler is running; then run scripts/reindex.ts
-- (the lemma version string carries the index revision, so every paragraph is picked up).
drop index if exists paragraphs_fts;
alter table paragraphs drop column search_vector;
alter table paragraphs add column lemma_parts text not null default '';
alter table paragraphs add column search_vector tsvector generated always as (
  setweight(to_tsvector('simple', lemma_text), 'A') || setweight(to_tsvector('simple', lemma_parts), 'D')
) stored;
create index paragraphs_fts on paragraphs using gin (search_vector);

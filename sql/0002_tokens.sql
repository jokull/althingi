-- 0002: ordered token stream (phrases, trends, word pages), SGML-era index rows, decoded speech attributes.
-- NOTE: the stored generated column rewrites `paragraphs` under lock; apply only while no crawler is running.
-- See docs/DECISIONS.md §1, §3, §8, §10.

-- speeches: SGML-era rows exist as an index only (text is behind a bot challenge and is not fetched)
alter table speeches alter column xml_url drop not null;
alter table speeches drop constraint speeches_text_state_check;
alter table speeches add constraint speeches_text_state_check
  check (text_state in ('pending', 'done', 'error', 'unavailable'));
alter table speeches
  add column era                text    not null default 'xml' check (era in ('xml', 'sgml')),
  add column source_url         text,                       -- sgml/html link for era = 'sgml'
  add column nefnd              text,                       -- 'fl' (flutningsmaður marker) or committee abbreviation
  add column continued          boolean,                    -- frhr <> '0'  (framhald ræðu)
  add column speaker_capacity   text,                       -- decoded tegflm, see parse.ts decodeCapacity
  add column reply_to_id        text,                       -- andsvar -> parent speech (INFERRED unless type = svar)
  add column reply_to_inferred  boolean not null default true;
create index speeches_era on speeches (era);

-- paragraphs: best-guess lemma sequence (stopwords dropped, order kept) for phrase / proximity search
alter table paragraphs
  add column lemma_seq text not null default '',
  add column seq_vector tsvector generated always as (to_tsvector('simple', lemma_seq)) stored;
create index paragraphs_seq on paragraphs using gin (seq_vector);

-- Parallel arrays, one row per paragraph (a row per token would be 8-12 GB at 250k speeches).
-- All word-like tokens in order; stopwords and numbers kept. Array position = token position.
create table paragraph_tokens (
  speech_id        text not null,
  seq              int  not null,
  surface          text[]     not null,
  lemma            text[]     not null,
  pos              text[]     not null,                  -- '' when unknown
  conf             real[]     not null,                  -- disambiguation confidence, -1 when n/a
  start            int[]      not null,                  -- char offset into paragraphs.text
  len              smallint[] not null,
  lemma_is_version text not null,
  primary key (speech_id, seq),
  foreign key (speech_id, seq) references paragraphs (speech_id, seq) on delete cascade
);

-- matter titles: searchable and boostable
alter table matters
  add column title_lemmas text not null default '',
  add column title_vector tsvector generated always as (to_tsvector('simple', title_lemmas)) stored;
create index matters_title_fts on matters using gin (title_vector);

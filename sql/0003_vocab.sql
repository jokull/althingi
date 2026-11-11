-- 0003: corpus vocabulary (did-you-mean, unknown-word handling) and member-name lookup.
-- pg_trgm is a trusted extension (PG13+): the database owner can create it, no superuser needed.
create extension if not exists pg_trgm;

-- Lexemes that actually occur in the corpus (all-candidates side), with document / entry counts.
-- Refresh after ingest: refresh materialized view concurrently vocab;
-- NB: materialized views run their query with a restricted search_path, so the table inside ts_stat() is schema-qualified.
create materialized view vocab as
  select word, ndoc, nentry from ts_stat('select search_vector from public.paragraphs');
create unique index vocab_word on vocab (word);
create index vocab_trgm on vocab using gin (word gin_trgm_ops);

create index members_name_trgm on members using gin (name gin_trgm_ops);

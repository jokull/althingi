-- migrate: no-transaction
-- 0008: the narrow search tables and the precomputed corpus state (docs/PERFORMANCE.md §3). Additive: no existing table
-- is rewritten. Runs outside a transaction so the indexes can be built CONCURRENTLY beside the live site; every
-- statement is idempotent, so a failed run simply re-runs.
--
-- Why narrow tables with FUNCTION-backed GIN indexes: a GIN bitmap scan must visit the heap page of every candidate
-- row, and on the mini (shared_buffers 128 MB, OS cache churned by other tenants) those visits are random disk reads:
-- the same 12k-candidate scan over `paragraphs` (2 rows per 8 KB page, 1.6 GB) measured 4.0 s cold and 18 ms warm.
-- A row that holds only ids is ~40 B, so the whole table is a few tens of MB and stays in shared_buffers. The vector
-- is not stored in the row at all: the index is built over an IMMUTABLE function that reads it from `paragraphs`
-- (TOAST cannot be forced out of line for values under 2 KB, so storing it inline would bloat the heap 5×). The
-- function is only ever called when a row is inserted/updated and on a lossy-bitmap recheck, which needs a TID bitmap
-- larger than work_mem (1M TIDs ≈ 6 MB; work_mem is 32 MB): never in practice. Keep work_mem ≥ 16 MB.

-- per paragraph: the stored search vector (whole-word lemmas at A, compound parts at D)
create or replace function para_vec(sid text, sq int) returns tsvector language sql immutable parallel safe as $$
  select p.search_vector from public.paragraphs p where p.speech_id = sid and p.seq = sq
$$;
-- per speech: the stripped union of its paragraphs' lemmas (recall only: positions dropped)
create or replace function speech_vec(sid text) returns tsvector language sql immutable parallel safe as $$
  select strip(to_tsvector('simple', string_agg(p.lemma_text || ' ' || p.lemma_parts, ' '))) from public.paragraphs p where p.speech_id = sid
$$;

-- paragraph ids only (candidate sets, totals): every GIN probe answers from a ~45 MB heap
create table if not exists paragraph_index (
  speech_id text not null,
  seq       int  not null,
  primary key (speech_id, seq)
);
create index concurrently if not exists paragraph_index_fts on paragraph_index using gin (para_vec(speech_id, seq));

-- One row per speech with text: the facts every hot path needs (no join to the 300 MB speeches table, party already
-- resolved on the speech date). The speech-level lemma set is indexed through speech_vec(id), not stored.
create table if not exists speech_index (
  id          text primary key,
  lthing      int  not null,
  speech_date date not null,
  started     timestamp not null,
  year        int  not null,
  member_id   int,
  member_name text not null,
  party_id    int,                       -- seat (þingmaður/varamaður) on the speech date; null = none
  type        text not null,
  debate      text not null,
  substantive boolean not null,          -- ræða/flutningsræða/andsvar/svar and not the presiding officer
  word_count  int,
  matter_cls  text,
  matter_nr   int,
  title_vec   tsvector,                  -- the matter title's lemma vector (title boost without a matters join)
  built_at    timestamptz not null default now()
);
create index concurrently if not exists speech_index_vec on speech_index using gin (speech_vec(id));
create index concurrently if not exists speech_index_started on speech_index (started desc);
create index concurrently if not exists speech_index_member on speech_index (member_id, started desc);
create index concurrently if not exists speech_index_party on speech_index (party_id, started desc);
create index concurrently if not exists speech_index_lthing on speech_index (lthing, started desc);
create index concurrently if not exists speech_index_matter on speech_index (lthing, matter_cls, matter_nr);

-- (Re)build the rows for a set of speeches: both tables. Called inside saveSpeechText's transaction (never stale for
-- new text), by reindex, and by the ingest post step for the current session (party/member fixes). Rows are deleted and
-- re-inserted so the function-backed indexes are re-evaluated. Speeches without text lose their rows.
create or replace function speech_index_refresh(ids text[]) returns int language plpgsql as $$
declare n int;
begin
  delete from paragraph_index where speech_id = any(ids);
  insert into paragraph_index (speech_id, seq)
    select p.speech_id, p.seq from paragraphs p join speeches s on s.id = p.speech_id
    where p.speech_id = any(ids) and s.text_state = 'done';
  delete from speech_index where id = any(ids);
  insert into speech_index (id, lthing, speech_date, started, year, member_id, member_name, party_id, type, debate, substantive,
                            word_count, matter_cls, matter_nr, title_vec, built_at)
  select s.id, s.lthing, s.speech_date, s.started, extract(year from s.speech_date)::int, s.member_id,
         coalesce(s.member_name, s.speaker_abbr, ''),
         (select st.party_id from seats st
           where st.member_id = s.member_id and st.kind in ('þingmaður', 'varamaður')
             and s.speech_date between coalesce(st.from_date, date '0001-01-01') and coalesce(st.to_date, date '9999-12-31')
           order by st.from_date desc nulls last limit 1),
         s.type, s.debate,
         (s.type in ('ræða', 'flutningsræða', 'andsvar', 'svar') and coalesce(s.role_kind, '') <> 'forseti'),
         s.word_count, s.matter_cls, s.matter_nr, m.title_vector, now()
  from speeches s
  left join matters m on (m.lthing, m.cls, m.nr) = (s.lthing, s.matter_cls, s.matter_nr)
  where s.id = any(ids) and s.text_state = 'done' and exists (select 1 from paragraphs p where p.speech_id = s.id);
  get diagnostics n = row_count;
  return n;
end $$;

-- Seats changed for these members: re-resolve party-on-the-date (a HOT update: no index touches the vector function).
create or replace function speech_index_reparty(member_ids int[]) returns int language plpgsql as $$
declare n int;
begin
  update speech_index si set party_id = x.party_id
  from (select si2.id, (select st.party_id from seats st
                         where st.member_id = si2.member_id and st.kind in ('þingmaður', 'varamaður')
                           and si2.speech_date between coalesce(st.from_date, date '0001-01-01') and coalesce(st.to_date, date '9999-12-31')
                         order by st.from_date desc nulls last limit 1) as party_id
        from speech_index si2 where si2.member_id = any(member_ids)) x
  where si.id = x.id and si.party_id is distinct from x.party_id;
  get diagnostics n = row_count;
  return n;
end $$;

-- Speeches whose index row is missing or older than their text/metadata (the post step's reconciliation set).
create or replace function speech_index_stale(max_rows int default 5000) returns setof text language sql stable as $$
  select s.id from speeches s left join speech_index si on si.id = s.id
  where s.text_state = 'done' and (si.id is null or si.built_at < s.fetched_at)
  order by s.started desc limit max_rows
$$;

-- The corpus in one row, refreshed by the ingest post step: counts, date range, per-session state (complete = safe to
-- cache as immutable), and a version that changes on every refresh (keys the in-process caches).
create table if not exists corpus_state (
  id             int primary key default 1 check (id = 1),
  version        bigint not null default 1,
  speeches_done  int not null,
  date_from      date,
  date_to        date,
  last_ingest    timestamptz,
  first_lthing   int,
  current_lthing int,
  sessions       jsonb not null,        -- [{lthing, period, starts, ends, done, pending, unavailable, first_date, last_date, complete}]
  updated_at     timestamptz not null default now()
);

create or replace function corpus_state_refresh() returns bigint language plpgsql as $$
declare v bigint;
begin
  with per as (
    select lthing,
           count(*) filter (where text_state = 'done')::int as done,
           count(*) filter (where text_state = 'pending' and era = 'xml')::int as pending,
           count(*) filter (where text_state = 'unavailable')::int as unavailable,
           min(speech_date) filter (where text_state = 'done') as first_date,
           max(speech_date) filter (where text_state = 'done') as last_date,
           max(fetched_at) as last_fetch
    from speeches group by lthing
  ), cover as (
    select lthing, count(*)::int a, count(detail_fetched_at)::int fetched from matters where cls = 'A' group by lthing
  ), cur as (select max(lthing) as l, min(lthing) as f from per where done > 0),
  rows_ as (
    select p.lthing, s.period, s.starts, s.ends, p.done, p.pending, p.unavailable, p.first_date, p.last_date,
           -- complete (safe to cache as immutable): nothing pending, text present, ≥ 95 % of A-mál have detail, and the
           -- session has ENDED (a running session gets new speeches on its matter pages even when nothing is pending)
           (p.pending = 0 and p.done > 0 and coalesce(c.fetched::float / nullif(c.a, 0), 1) >= 0.95
             and coalesce(s.ends, date '9999-12-31') < current_date) as complete
    from per p left join sessions s on s.lthing = p.lthing left join cover c on c.lthing = p.lthing
    where p.done > 0 or p.pending > 0 or p.unavailable > 0
  )
  insert into corpus_state (id, version, speeches_done, date_from, date_to, last_ingest, first_lthing, current_lthing, sessions, updated_at)
  select 1, 1, coalesce(sum(done), 0), min(first_date), max(last_date), (select max(last_fetch) from per),
         (select f from cur), (select l from cur),
         coalesce(jsonb_agg(jsonb_build_object('lthing', lthing, 'period', period, 'starts', starts, 'ends', ends, 'done', done,
                  'pending', pending, 'unavailable', unavailable, 'first_date', first_date, 'last_date', last_date, 'complete', complete)
                  order by lthing desc), '[]'::jsonb), now()
  from rows_
  on conflict (id) do update set version = corpus_state.version + 1, speeches_done = excluded.speeches_done,
    date_from = excluded.date_from, date_to = excluded.date_to, last_ingest = excluded.last_ingest,
    first_lthing = excluded.first_lthing, current_lthing = excluded.current_lthing, sessions = excluded.sessions, updated_at = now()
  returning version into v;
  return v;
end $$;

-- the row must exist from the first request on (the web layer reads it, never computes it)
select corpus_state_refresh();

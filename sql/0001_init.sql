-- althingi-search schema v1. See docs/STRUCTURE.md for why each table looks like this.
-- Timestamps are stored as served (naive local time; Iceland is UTC+0 all year, so they equal UTC).

create table sessions (
  lthing     int primary key,
  period     text not null,
  starts     date,
  ends       date,
  has_record boolean not null default false
);

create table members (
  id    int primary key,
  name  text not null,
  born  date,
  abbr  text
);

create table parties (
  id   int primary key,
  name text not null
);

-- One row per seat stint. Party can change mid-session, so party-at-time joins on dates, not on lthing.
create table seats (
  id              bigserial primary key,
  member_id       int  not null,
  lthing          int  not null,
  kind            text not null,            -- þingmaður | varamaður | með varamann (on leave: NOT sitting)
  abbr            text,
  party_id        int,
  constituency_id int,
  constituency    text,
  from_date       date,
  to_date         date                      -- null = open-ended / unknown
);
-- same member can have two stints with the same start (e.g. a one-day stint + a longer one), so to_date is part of the key
create unique index seats_uq on seats (member_id, lthing, kind, coalesce(from_date, date '0001-01-01'), coalesce(to_date, date '9999-12-31'));
create index seats_member on seats (member_id, from_date);
create index seats_party on seats (party_id, lthing);

-- Matter numbers are separate spaces for A and B (A 309 and B 309 both exist) -> cls is part of the key.
create table matters (
  lthing     int  not null,
  cls        text not null,                 -- A | B
  nr         int  not null,
  title      text not null,
  subtitle   text,
  type_code  text,
  type_label text,
  stub       boolean not null default false, -- created from a speech's <mál> block, no matter list row yet
  primary key (lthing, cls, nr)
);

create table speeches (
  id            text primary key,           -- rad20250911T103151 (xml filename stem)
  lthing        int  not null,
  fundur        int,
  member_id     int  not null,              -- no FK: speech index can arrive before the member row
  member_name   text not null,
  role_kind     text,                       -- ráðherra | forseti | framsögumaður
  role_title    text,
  speaker_abbr  text,
  office        text,
  tegr          text,
  tegflm        text,
  speech_date   date not null,
  started       timestamp not null,
  ended         timestamp,
  type          text not null,              -- ræða | andsvar | flutningsræða | svar | …
  debate        text not null default '',   -- 1 2 3 * S E F or ''
  matter_cls    text,
  matter_nr     int,
  xml_url       text not null,
  html_url      text,
  audio_url     text,
  vod_url       text,
  -- crawler work queue: the index row exists first, the text arrives later
  text_state    text not null default 'pending' check (text_state in ('pending', 'done', 'error')),
  text_error    text,
  fetched_at    timestamptz,
  word_count    int,
  lemma_is_version text,
  raw_sha256    text,
  created_at    timestamptz not null default now()
);
create index speeches_member_date on speeches (member_id, speech_date desc);
create index speeches_matter on speeches (lthing, matter_cls, matter_nr, started);
create index speeches_date on speeches (speech_date desc, id);
create index speeches_type on speeches (type);
create index speeches_lthing on speeches (lthing, started);
create index speeches_pending on speeches (started desc) where text_state = 'pending';

create table paragraphs (
  speech_id     text not null references speeches (id) on delete cascade,
  seq           int  not null,
  text          text not null,              -- speaker's words, for display and snippets
  lemma_text    text not null,              -- space-joined lowercase lexemes from src/lemma.ts
  interjections text[] not null default '{}', -- other MPs' <frammíkall>; display only, never indexed
  search_vector tsvector generated always as (to_tsvector('simple', lemma_text)) stored,
  primary key (speech_id, seq)
);
create index paragraphs_fts on paragraphs using gin (search_vector);

-- Every URL fetched once; raw bodies live on disk (and later R2) so parsers can be replayed without recrawl.
create table raw_fetch (
  url        text primary key,
  fetched_at timestamptz not null default now(),
  status     int  not null,
  bytes      int  not null,
  sha256     text,
  path       text
);

create table ingest_state (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

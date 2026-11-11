-- 0006: layered ingest (docs/INGEST.md §4). Additive only: new columns are nullable or have constant defaults
-- (no table rewrite), two NOT NULLs are dropped (catalog-only), every other object is new. Safe while the site serves.

-- ---------------------------------------------------------------- provenance on existing tables
alter table speeches
  add column text_source  text,                 -- dump | dump-provisional | dump-spola | service (NULL = legacy service row)
  add column index_source text,                 -- dump | service (NULL = legacy service row)
  add column source_ref   text,                 -- dump: <lthing>/<dir>/<file>; service: the URL
  add column revised_at   timestamptz,          -- a later final text with a different sha replaced this one
  add column provisional  boolean not null default false;  -- text from raedur_bradabirgda (bráðabirgðatexti)
-- dump-only speakers (non-MP ministers before their first service sighting) have an abbreviation, no id yet
alter table speeches alter column member_id drop not null;
alter table speeches alter column member_name drop not null;
create index speeches_unresolved on speeches (lthing) where member_id is null;
create index speeches_provisional on speeches (lthing) where provisional;

alter table votes
  add column source      text,                  -- dump | service (NULL = legacy, from matter detail)
  add column method_code text,                  -- dump aðferð: S G K N E Y
  add column kind_code2  text,                  -- dump <um tegatkvgr>
  add column unanimous   boolean;
alter table ballots   add column source text;
alter table documents add column distributed_at timestamp, add column source text, add column title text;
alter table raw_fetch add column etag text, add column last_modified text, add column headers jsonb;

-- ---------------------------------------------------------------- dump drops and per-file change detection
create table dump_drops (
  id            serial primary key,
  path          text not null,
  tree_sha256   text,                            -- sha over (path, sha256) of every hashed file: identical tree = same drop
  zip_sha256    text,
  downloaded_at timestamptz not null default now(),
  max_speech_ts timestamp,
  files         int,
  note          text
);
create table dump_files (
  drop_id    int references dump_drops,
  lthing     int  not null,
  dir        text not null,
  name       text not null,
  sha256     text not null,
  bytes      int,
  mtime      timestamptz,
  parsed_at  timestamptz,
  parser_rev int,
  primary key (lthing, dir, name)
);
create index dump_files_unparsed on dump_files (dir) where parsed_at is null;

-- ---------------------------------------------------------------- speakers
-- What the XML service said about who gave a speech (speech lists, matter detail <ræður>): the evidence aliases are learned from.
create table speaker_sightings (
  speech_id   text not null,
  member_id   int  not null,
  member_name text,
  source      text not null,                    -- member-list | day-list | matter-detail | matter-speeches
  seen_at     timestamptz not null default now(),
  primary key (speech_id, source)
);
create index speaker_sightings_member on speaker_sightings (member_id);
-- abbr -> member id, learned (never curated) by joining sightings/service rows to the dump's skst. NFC everywhere.
create table speaker_aliases (
  abbr       text not null,
  member_id  int  not null,
  n          int  not null default 0,
  first_seen date,
  last_seen  date,
  primary key (abbr, member_id)
);
create table ministries (office_abbr text primary key, name text);

-- ---------------------------------------------------------------- sittings (dump-only entities)
create table sittings (lthing int, fundur int, name text, starts timestamp, ends timestamp, source_ref text, primary key (lthing, fundur));
create table sitting_items (
  lthing int, fundur int, seq int, lid_id text, cls text, nr int, started timestamp,
  debate text,                                   -- raw umr as served (1f, 2, *, …)
  vote_flag boolean,
  primary key (lthing, fundur, seq)
);
create index sitting_items_lid on sitting_items (lid_id);
create index sitting_items_matter on sitting_items (lthing, cls, nr);
-- lidaskjol <þingræða> rows in order; speech_id is linked by derive (exact stem, else same skst within 120 s)
create table sitting_speeches (
  lid_id text not null, seq int not null, lthing int, fundur int, cls text, nr int,
  debate text, abbr text, started timestamp, tegr text, tegflm text, office text, continued boolean,
  speech_id text,
  primary key (lid_id, seq)
);
create index sitting_speeches_speech on sitting_speeches (speech_id);
create table sitting_events (
  lthing int, fundur int, at timestamp, kind text, cls text not null default '', nr int not null default 0, doc_nr int,
  primary key (lthing, fundur, at, kind, cls, nr)
);
create index sitting_events_matter on sitting_events (lthing, cls, nr);
create table agenda_items (
  lthing int, fundur int, seq int, cls text, nr int, title text, doc_nr int, off_agenda boolean, parent_seq int,
  primary key (lthing, fundur, seq)
);
create table matter_sponsors (
  lthing int, cls text, nr int, seq int, abbr text, member_id int, office text, source text,
  primary key (lthing, cls, nr, seq)
);
create index matter_sponsors_member on matter_sponsors (member_id);
create table ballots_unresolved (vote_id int, abbr text, choice text, lthing int, primary key (vote_id, abbr));
create table absences (lthing int, fundur int, date date, abbr text, member_id int, office text, source text, primary key (lthing, fundur, abbr));
create table seat_returns (lthing int, fundur int, date date, abbr text, member_id int, office text, primary key (lthing, fundur, abbr));
create table speech_revisions (speech_id text, raw_sha256 text, seen_at timestamptz default now(), source text, primary key (speech_id, raw_sha256));

-- ---------------------------------------------------------------- laws (lagasafn zip)
create table laws (
  year int, nr int, edition text, title text, chapter text, in_force text, ministry text,
  matter_lthing int, matter_nr int, html text, text text, lemma_text text not null default '',
  source_ref text,
  primary key (year, nr, edition)
);
create index laws_title_trgm on laws using gin (title gin_trgm_ops);
create view laws_current as
  select distinct on (year, nr) * from laws order by year, nr, edition desc;
create table law_amendments (year int, nr int, by_year int, by_nr int, effective_text text, primary key (year, nr, by_year, by_nr));
create index law_amendments_by on law_amendments (by_year, by_nr);
create table law_articles (year int, nr int, edition text, article_id text, heading text, text text, primary key (year, nr, edition, article_id));

-- ---------------------------------------------------------------- runs
create table ingest_runs (
  id bigserial primary key, kind text, started timestamptz default now(), finished timestamptz,
  requests int default 0, files int default 0, rows int default 0, status text, note text
);

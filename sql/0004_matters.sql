-- 0004: matter detail (A-mál): status, documents, votes with counts, consultations, submissions, related matters,
-- laws amended, topic categories, committees. One request per matter fills all of it (docs/DECISIONS.md §4).
alter table matters
  add column status_text         text,
  add column question_to         text,
  add column detail_fetched_at   timestamptz;

create table committees (
  id          int primary key,
  name        text not null,
  abbr        text,
  abbr_long   text,
  first_lthing int
);

create table efnisflokkar (
  id          int primary key,
  parent_id   int,
  name        text not null,
  parent_name text,
  description text
);
create table matter_efnisflokkar (
  lthing int not null, cls text not null, nr int not null, efnisflokkur_id int not null,
  primary key (lthing, cls, nr, efnisflokkur_id)
);

create table matter_laws (
  lthing int not null, cls text not null, nr int not null, law_year int not null, law_nr int not null,
  primary key (lthing, cls, nr, law_year, law_nr)
);
create index matter_laws_law on matter_laws (law_year, law_nr);

-- relations as served (lagtFramÁðurSem, skyltMál, …): strong links, direction as in the source
create table matter_links (
  lthing int not null, cls text not null, nr int not null,
  kind text not null, to_lthing int not null, to_cls text not null, to_nr int not null, to_title text,
  primary key (lthing, cls, nr, kind, to_lthing, to_cls, to_nr)
);
create index matter_links_to on matter_links (to_lthing, to_cls, to_nr);

-- document ids and metadata only (texts are v2 / WP8b)
create table documents (
  lthing int not null, nr int not null,
  matter_cls text, matter_nr int,
  type text not null, issued timestamp,
  html_url text, pdf_url text, xml_url text,
  primary key (lthing, nr)
);
create index documents_matter on documents (lthing, matter_cls, matter_nr);

-- summary per vote as served in the matter detail (counts + result); per-member ballots come separately
create table votes (
  id         int primary key,
  lthing     int not null, cls text not null, nr int not null,
  voted_at   timestamp,
  kind_code  text, kind_label text not null,
  doc_nr     int,
  method     text,           -- atkvæðagreiðslukerfi | nafnakall | yfirlýsing forseta/mál gengur
  result     text,           -- samþykkt | Fellt | kallað aftur | kom ekki til atkvæðagreiðslu
  yes int, no int, abstain int
);
create index votes_matter on votes (lthing, cls, nr, voted_at);
create index votes_time on votes (voted_at);

create table ballots (
  vote_id   int not null,
  member_id int not null,
  choice    text not null,   -- já | nei | greiðir ekki atkvæði | boðaði fjarvist | fjarverandi — five values, verbatim
  primary key (vote_id, member_id)
);
create index ballots_member on ballots (member_id, vote_id);

-- umsagnabeiðnanúmer identifies a ROUND (one batch sent with one deadline), shared by all its recipients,
-- so it cannot be a primary key (found on real data: 38 recipients of matter 157/300 share round 12917 / 12919)
create table consultation_requests (
  id           bigserial primary key,
  round_id     int not null,
  lthing int not null, cls text not null, nr int not null,
  requested    date, due date,
  recipient    text not null,
  committee_id int
);
create unique index consultation_uq on consultation_requests (lthing, cls, nr, round_id, recipient);
create index consultation_matter on consultation_requests (lthing, cls, nr);

create table submissions (        -- erindi: opinions and submissions received by committees
  id           int not null,      -- dagbókarnúmer (unique per session)
  lthing int not null, cls text not null, nr int not null,
  sender       text not null,
  committee_id int,
  kind_code    text, kind text,
  received     date, sent date,
  pdf_url      text,
  primary key (lthing, id)
);
create index submissions_matter on submissions (lthing, cls, nr);

-- framsögumenn as served (committee rapporteurs); NOT the bill's sponsors
create table matter_rapporteurs (
  lthing int not null, cls text not null, nr int not null, member_id int not null, name text not null,
  primary key (lthing, cls, nr, member_id)
);

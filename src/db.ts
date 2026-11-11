import { readdirSync, readFileSync } from "node:fs";
import postgres from "postgres";
import type { CommitteeRow, Member, MatterDetail, MatterRow, Paragraph, Seat, SessionRow, SpeechIndexEntry } from "./parse.ts";

export type Sql = postgres.Sql;
/** Either the pool or a transaction handle. */
export type Queryable = postgres.Sql | postgres.TransactionSql;

export function connect(url = process.env.DATABASE_URL, max = 4): Sql {
  if (!url) throw new Error("DATABASE_URL is not set");
  return postgres(url, { max, onnotice: () => {}, idle_timeout: 30 });
}

const SQL_DIR = new URL("../sql/", import.meta.url);

/** Apply sql/*.sql in filename order, once each. */
export async function migrate(sql: Sql): Promise<string[]> {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const done = new Set((await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
  const applied: string[] = [];
  for (const f of readdirSync(SQL_DIR).filter((x) => x.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    const body = readFileSync(new URL(f, SQL_DIR), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (name) values (${f})`;
    });
    applied.push(f);
  }
  return applied;
}

/** Source feeds contain exact duplicate rows (e.g. matter 157/A/516 twice); last one wins. */
function uniqBy<T>(rows: T[], key: (r: T) => string): T[] {
  return [...new Map(rows.map((r) => [key(r), r])).values()];
}

const CHUNK = 500;
async function inChunks<T>(rows: T[], fn: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) await fn(rows.slice(i, i + CHUNK));
}

export async function upsertSessions(sql: Sql, rows: SessionRow[]): Promise<void> {
  const data = rows.map((r) => ({ lthing: r.lthing, period: r.period, starts: r.start, ends: r.end, has_record: r.hasRecord }));
  await inChunks(data, (c) => sql`
    insert into sessions ${sql(c)}
    on conflict (lthing) do update set period = excluded.period, starts = excluded.starts, ends = excluded.ends, has_record = excluded.has_record`);
}

export async function upsertMembers(sql: Sql, rows: Member[]): Promise<void> {
  const data = rows.map((r) => ({ id: r.id, name: r.name, born: r.born, abbr: r.abbr, cv_url: r.cvUrl ?? null }));
  await inChunks(data, (c) => sql`
    insert into members ${sql(c)}
    on conflict (id) do update set name = excluded.name, born = coalesce(excluded.born, members.born), abbr = coalesce(excluded.abbr, members.abbr),
      cv_url = coalesce(excluded.cv_url, members.cv_url)`);
}

export async function upsertSeats(sql: Sql, rows: Seat[]): Promise<void> {
  const parties = new Map<number, string>();
  for (const s of rows) if (s.partyId !== null && s.party) parties.set(s.partyId, s.party);
  if (parties.size) {
    const p = [...parties].map(([id, name]) => ({ id, name }));
    await sql`insert into parties ${sql(p)} on conflict (id) do update set name = excluded.name`;
  }
  const data = uniqBy(rows, (s) => `${s.memberId}|${s.lthing}|${s.kind}|${s.from}|${s.to}`).map((s) => ({
    member_id: s.memberId, lthing: s.lthing, kind: s.kind, abbr: s.abbr, party_id: s.partyId,
    constituency_id: s.constituencyId, constituency: s.constituency, from_date: s.from, to_date: s.to,
  }));
  await inChunks(data, (c) => sql`
    insert into seats ${sql(c)}
    on conflict (member_id, lthing, kind, coalesce(from_date, date '0001-01-01'), coalesce(to_date, date '9999-12-31'))
    do update set abbr = excluded.abbr, party_id = excluded.party_id, constituency_id = excluded.constituency_id,
                  constituency = excluded.constituency`);
}

export async function upsertMatters(sql: Sql, rows: MatterRow[], lemmatize: (t: string) => string = () => ""): Promise<void> {
  const data = uniqBy(rows, (m) => `${m.lthing}|${m.cls}|${m.nr}`).map((m) => ({
    lthing: m.lthing, cls: m.cls, nr: m.nr, title: m.title, subtitle: m.subtitle,
    type_code: m.typeCode, type_label: m.typeLabel, stub: false, title_lemmas: lemmatize(m.title), html_url: m.htmlUrl ?? null,
  }));
  await inChunks(data, (c) => sql`
    insert into matters ${sql(c)}
    on conflict (lthing, cls, nr) do update set title = excluded.title, subtitle = excluded.subtitle,
      type_code = excluded.type_code, type_label = excluded.type_label, stub = false,
      html_url = coalesce(excluded.html_url, matters.html_url),
      title_lemmas = case when excluded.title_lemmas <> '' then excluded.title_lemmas else matters.title_lemmas end`);
}

/**
 * Store index rows for real speeches. XML-era rows enter the work queue ('pending'); SGML-era rows are kept as an
 * honest index only ('unavailable': their text sits behind a bot challenge and is never fetched).
 * Existing rows keep their text_state; the service's index fields (member id/name, type label, debate, links incl.
 * vod) fill in or win over dump-derived values (docs/INGEST.md §2), and only rows that actually differ are written.
 * Every entry is also recorded as a speaker sighting (the evidence speaker_aliases are learned from), and speakers
 * with an id but no members row (non-MP ministers) get one. B-mál titles only exist here, hence stub matters.
 * Returns the number of NEW speech rows.
 */
export async function upsertSpeechIndex(
  sql: Sql, entries: SpeechIndexEntry[], lemmatize: (t: string) => string = () => "", source = "member-list",
): Promise<number> {
  const usable = uniqBy(entries.filter((e) => e.isSpeech && e.id && (e.xmlUrl || e.sourceUrl) && e.date && e.started), (e) => e.id!);
  if (!usable.length) return 0;

  const stubs = new Map<string, { lthing: number; cls: string; nr: number; title: string; stub: boolean; title_lemmas: string }>();
  for (const e of usable) {
    if (e.matter && e.matter.cls) {
      const k = `${e.lthing}/${e.matter.cls}/${e.matter.nr}`;
      if (!stubs.has(k)) {
        stubs.set(k, { lthing: e.lthing, cls: e.matter.cls, nr: e.matter.nr, title: e.matter.title, stub: true, title_lemmas: lemmatize(e.matter.title) });
      }
    }
  }
  const rows = usable.map((e) => ({
    id: e.id!, lthing: e.lthing, fundur: e.fundur, member_id: e.memberId, member_name: e.memberName,
    role_kind: e.roleKind, role_title: e.roleTitle, speech_date: e.date!, started: e.started, ended: e.ended,
    type: e.type, debate: e.debate, matter_cls: e.matter?.cls || null, matter_nr: e.matter?.cls ? e.matter.nr : null,
    xml_url: e.xmlUrl, source_url: e.sourceUrl, html_url: e.htmlUrl, audio_url: e.audioUrl, vod_url: e.vodUrl,
    era: e.era, text_state: e.era === "xml" ? "pending" : "unavailable", index_source: "service",
  }));
  const people = uniqBy(usable.filter((e) => e.memberId > 0 && e.memberName), (e) => String(e.memberId))
    .map((e) => ({ id: e.memberId, name: e.memberName }));
  const sightings = usable.filter((e) => e.memberId > 0)
    .map((e) => ({ speech_id: e.id!, member_id: e.memberId, member_name: e.memberName || null, source }));
  let inserted = 0;
  await sql.begin(async (tx) => {
    await inChunks([...stubs.values()], (c) => tx`insert into matters ${tx(c)} on conflict (lthing, cls, nr) do nothing`);
    await inChunks(people, (c) => tx`insert into members ${tx(c)} on conflict (id) do nothing`);
    await inChunks(rows, async (c) => {
      const r = await tx<{ ins: boolean }[]>`
        insert into speeches ${tx(c)}
        on conflict (id) do update set
          member_id = case when excluded.member_id > 0 then excluded.member_id else speeches.member_id end,
          member_name = case when excluded.member_id > 0 and excluded.member_name <> '' then excluded.member_name else speeches.member_name end,
          role_kind = coalesce(excluded.role_kind, speeches.role_kind), role_title = coalesce(excluded.role_title, speeches.role_title),
          type = case when excluded.type <> '' then excluded.type else speeches.type end,
          debate = case when excluded.debate <> '' then excluded.debate else speeches.debate end,
          ended = coalesce(speeches.ended, excluded.ended), fundur = coalesce(speeches.fundur, excluded.fundur),
          xml_url = coalesce(speeches.xml_url, excluded.xml_url),
          html_url = coalesce(excluded.html_url, speeches.html_url), audio_url = coalesce(excluded.audio_url, speeches.audio_url),
          vod_url = coalesce(excluded.vod_url, speeches.vod_url)
        where (excluded.member_id > 0 and speeches.member_id is distinct from excluded.member_id)
           or (excluded.member_id > 0 and excluded.member_name <> '' and speeches.member_name is distinct from excluded.member_name)
           or (excluded.vod_url is not null and speeches.vod_url is distinct from excluded.vod_url)
           or (excluded.html_url is not null and speeches.html_url is distinct from excluded.html_url)
           or (excluded.audio_url is not null and speeches.audio_url is distinct from excluded.audio_url)
           or (excluded.type <> '' and speeches.type is distinct from excluded.type)
           or (excluded.debate <> '' and speeches.debate is distinct from excluded.debate)
           or (speeches.role_kind is null and excluded.role_kind is not null)
           or (speeches.ended is null and excluded.ended is not null)
        returning (xmax = 0) as ins`;
      inserted += r.filter((x) => x.ins).length;
    });
    await inChunks(sightings, (c) => tx`
      insert into speaker_sightings ${tx(c)} on conflict (speech_id, source) do update set member_id = excluded.member_id,
        member_name = excluded.member_name, seen_at = now()
      where speaker_sightings.member_id <> excluded.member_id or speaker_sightings.member_name is distinct from excluded.member_name`);
  });
  return inserted;
}

export interface SpeechMeta {
  id: string;
  speakerAbbr: string | null;
  office: string | null;
  tegr: string | null;
  tegflm: string | null;
  nefnd: string | null;
  continued: boolean | null;
  speakerCapacity: string | null;
}

/** What the ingest side computes for one paragraph (see lemma.ts analyze). */
export interface ParagraphAnalysis {
  lemmaText: string;
  lemmaParts: string;
  lemmaSeq: string;
  tokens: { surface: string; lemma: string; pos: string; conf: number; start: number; len: number }[];
}

/** Replace a speech's paragraphs + tokens and mark it done. `analyze` is injected so tests/ingest/reindex share one source. */
export async function saveSpeechText(
  sql: Sql,
  meta: SpeechMeta,
  paragraphs: Paragraph[],
  info: {
    rawSha256: string; lemmaVersion: string; analyze: (text: string) => ParagraphAnalysis;
    /** provenance (docs/INGEST.md §2): service | dump | dump-provisional; default service */
    textSource?: string; provisional?: boolean; sourceRef?: string | null;
  },
): Promise<void> {
  const analyzed = paragraphs.map((p) => ({ p, a: info.analyze(p.text) }));
  const rows = analyzed.map(({ p, a }) => ({
    speech_id: meta.id, seq: p.seq, text: p.text, lemma_text: a.lemmaText, lemma_parts: a.lemmaParts, lemma_seq: a.lemmaSeq,
    interjections: p.interjections,
  }));
  const words = paragraphs.reduce((n, p) => n + p.text.split(" ").length, 0);
  await sql.begin(async (tx) => {
    await tx`delete from paragraphs where speech_id = ${meta.id}`;
    await inChunks(rows, (c) => tx`insert into paragraphs ${tx(c)}`);
    await writeTokens(tx, analyzed.map(({ p, a }) => ({ speechId: meta.id, seq: p.seq, tokens: a.tokens })), info.lemmaVersion);
    await tx`
      update speeches set text_state = 'done', text_error = null, fetched_at = now(), word_count = ${words},
        lemma_is_version = ${info.lemmaVersion}, raw_sha256 = ${info.rawSha256},
        speaker_abbr = ${meta.speakerAbbr}, office = ${meta.office}, tegr = ${meta.tegr}, tegflm = ${meta.tegflm},
        nefnd = ${meta.nefnd}, continued = ${meta.continued}, speaker_capacity = ${meta.speakerCapacity},
        text_source = ${info.textSource ?? "service"}, provisional = ${info.provisional ?? false},
        source_ref = coalesce(${info.sourceRef ?? null}, source_ref)
      where id = ${meta.id}`;
  });
}

/** Upsert the parallel-array token rows for a set of paragraphs. */
export async function writeTokens(
  sql: Queryable,
  items: { speechId: string; seq: number; tokens: ParagraphAnalysis["tokens"] }[],
  lemmaVersion: string,
): Promise<void> {
  const data = items.map((i) => ({
    speech_id: i.speechId, seq: i.seq,
    surface: i.tokens.map((t) => t.surface), lemma: i.tokens.map((t) => t.lemma), pos: i.tokens.map((t) => t.pos),
    conf: i.tokens.map((t) => t.conf), start: i.tokens.map((t) => t.start), len: i.tokens.map((t) => t.len),
    lemma_is_version: lemmaVersion,
  }));
  await inChunks(data, (c) => sql`
    insert into paragraph_tokens ${sql(c)}
    on conflict (speech_id, seq) do update set surface = excluded.surface, lemma = excluded.lemma, pos = excluded.pos,
      conf = excluded.conf, start = excluded.start, len = excluded.len, lemma_is_version = excluded.lemma_is_version`);
}

export async function markSpeechError(sql: Sql, id: string, error: string): Promise<void> {
  await sql`update speeches set text_state = 'error', text_error = ${error.slice(0, 500)}, fetched_at = now() where id = ${id}`;
}

export interface PendingSpeech { id: string; lthing: number; xml_url: string; started: Date }

/** Work queue: newest first, optionally limited to a session or a date window. */
export async function nextPending(
  sql: Sql, limit: number, f: { lthing?: number; from?: string; to?: string } = {},
): Promise<PendingSpeech[]> {
  return sql<PendingSpeech[]>`
    select id, lthing, xml_url, started from speeches
    where text_state = 'pending'
      ${f.lthing !== undefined ? sql`and lthing = ${f.lthing}` : sql``}
      ${f.from ? sql`and speech_date >= ${f.from}` : sql``}
      ${f.to ? sql`and speech_date <= ${f.to}` : sql``}
    order by started desc limit ${limit}`;
}

export interface FetchRecord {
  url: string; status: number; bytes: number; sha256: string | null; path: string | null;
  etag?: string | null; last_modified?: string | null; headers?: Record<string, string> | null;
}

/** Record one fetch. A 304 keeps the stored body (sha/path/bytes) and only refreshes time, validators and headers. */
export async function recordFetch(sql: Sql, r: FetchRecord): Promise<void> {
  const row = {
    url: r.url, status: r.status, bytes: r.bytes, sha256: r.sha256, path: r.path,
    etag: r.etag ?? null, last_modified: r.last_modified ?? null, headers: r.headers ? sql.json(r.headers) : null,
  };
  if (r.status === 304) {
    await sql`
      update raw_fetch set fetched_at = now(), etag = coalesce(${row.etag}, etag), last_modified = coalesce(${row.last_modified}, last_modified),
        headers = ${row.headers} where url = ${r.url}`;
    return;
  }
  await sql`
    insert into raw_fetch ${sql(row as never)}
    on conflict (url) do update set fetched_at = now(), status = excluded.status, bytes = excluded.bytes,
      sha256 = excluded.sha256, path = excluded.path, etag = excluded.etag, last_modified = excluded.last_modified,
      headers = excluded.headers`;
}

export async function getState<T = unknown>(sql: Sql, key: string): Promise<T | undefined> {
  const r = await sql<{ value: T }[]>`select value from ingest_state where key = ${key}`;
  return r[0]?.value;
}

export async function setState(sql: Sql, key: string, value: unknown): Promise<void> {
  await sql`
    insert into ingest_state (key, value) values (${key}, ${sql.json(value as never)})
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

/** Only one crawler may talk to Alþingi at a time: the 5 s politeness budget is global, not per process. */
export async function tryCrawlLock(sql: Sql): Promise<boolean> {
  const r = await sql<{ ok: boolean }[]>`select pg_try_advisory_lock(746100) as ok`;
  return r[0]!.ok;
}

export interface RecordedFetch { status: number; path: string | null; fetched_at: Date; sha256: string | null; etag: string | null; last_modified: string | null }
export async function recordedFetch(sql: Sql, url: string): Promise<RecordedFetch | undefined> {
  const r = await sql<RecordedFetch[]>`select status, path, fetched_at, sha256, etag, last_modified from raw_fetch where url = ${url}`;
  return r[0];
}

// ---------------------------------------------------------------- locks and runs (docs/INGEST.md §5)

/** Advisory lock keys. `crawl` = the one network client; dump/derive/laws never take it, so they run beside the crawler. */
export const LOCKS = { crawl: 746100, dump: 746101, derive: 746102, laws: 746103 } as const;
export type LockName = keyof typeof LOCKS;

export async function tryLock(sql: Sql, name: LockName): Promise<boolean> {
  const r = await sql<{ ok: boolean }[]>`select pg_try_advisory_lock(${LOCKS[name]}) as ok`;
  return r[0]!.ok;
}

export async function startRun(sql: Sql, kind: string): Promise<number> {
  const [r] = await sql<{ id: string }[]>`insert into ingest_runs (kind, status) values (${kind}, 'running') returning id`;
  return Number(r!.id);
}

export async function finishRun(
  sql: Sql, id: number, r: { status: string; requests?: number; files?: number; rows?: number; note?: string | null },
): Promise<void> {
  await sql`
    update ingest_runs set finished = now(), status = ${r.status}, requests = ${r.requests ?? 0}, files = ${r.files ?? 0},
      rows = ${r.rows ?? 0}, note = ${r.note ?? null}
    where id = ${id}`;
}

/** Network steps refuse to start while a 403/429 pause is in force (set for 24 h by the run that saw it). */
export async function crawlPausedUntil(sql: Sql): Promise<Date | null> {
  const v = await getState<string>(sql, "crawl_paused_until");
  const d = v ? new Date(v) : null;
  return d && d.getTime() > Date.now() ? d : null;
}
export async function pauseCrawl(sql: Sql, hours = 24, why = ""): Promise<void> {
  await setState(sql, "crawl_paused_until", new Date(Date.now() + hours * 3_600_000).toISOString());
  await setState(sql, "crawl_paused_reason", why);
}

/** Abbreviations are joined after NFC normalisation, always (dump vs service can differ in normal form). */
export const nfc = <T extends string | null | undefined>(s: T): T => (typeof s === "string" ? (s.normalize("NFC").trim() as T) : s);

export async function upsertCommittees(sql: Sql, rows: CommitteeRow[]): Promise<void> {
  const data = uniqBy(rows, (r) => String(r.id)).map((r) => ({ id: r.id, name: r.name, abbr: r.abbr, abbr_long: r.abbrLong, first_lthing: r.firstLthing }));
  if (!data.length) return;
  await sql`
    insert into committees ${sql(data)}
    on conflict (id) do update set name = excluded.name, abbr = excluded.abbr, abbr_long = excluded.abbr_long,
      first_lthing = coalesce(excluded.first_lthing, committees.first_lthing)`;
}

/** Store everything one matter-detail request carries. Child rows of this matter are replaced; votes/documents upsert by id. */
export async function upsertMatterDetail(sql: Sql, d: MatterDetail, lemmatize: (t: string) => string = () => ""): Promise<void> {
  const { lthing, cls, nr } = d;
  await sql.begin(async (tx) => {
    await tx`
      insert into matters (lthing, cls, nr, title, subtitle, type_code, type_label, stub, title_lemmas, status_text, question_to, detail_fetched_at)
      values (${lthing}, ${cls}, ${nr}, ${d.title}, ${d.subtitle}, ${d.typeCode}, ${d.typeLabel}, false, ${lemmatize(d.title)}, ${d.statusText}, ${d.questionTo}, now())
      on conflict (lthing, cls, nr) do update set title = excluded.title, subtitle = excluded.subtitle, type_code = excluded.type_code,
        type_label = excluded.type_label, stub = false,
        title_lemmas = case when excluded.title_lemmas <> '' then excluded.title_lemmas else matters.title_lemmas end,
        status_text = excluded.status_text, question_to = excluded.question_to, detail_fetched_at = now()`;

    const topics = uniqBy(d.topics, (t) => String(t.id));
    if (topics.length) {
      await tx`
        insert into efnisflokkar ${tx(topics.map((t) => ({ id: t.id, parent_id: t.parentId, name: t.name, parent_name: t.parentName, description: t.description })))}
        on conflict (id) do update set parent_id = excluded.parent_id, name = excluded.name, parent_name = excluded.parent_name, description = excluded.description`;
    }
    await tx`delete from matter_efnisflokkar where lthing = ${lthing} and cls = ${cls} and nr = ${nr}`;
    if (topics.length) await tx`insert into matter_efnisflokkar ${tx(topics.map((t) => ({ lthing, cls, nr, efnisflokkur_id: t.id })))} on conflict do nothing`;

    await tx`delete from matter_laws where lthing = ${lthing} and cls = ${cls} and nr = ${nr}`;
    const laws = uniqBy(d.laws, (l) => `${l.year}/${l.nr}`);
    if (laws.length) await tx`insert into matter_laws ${tx(laws.map((l) => ({ lthing, cls, nr, law_year: l.year, law_nr: l.nr })))}`;

    await tx`delete from matter_links where lthing = ${lthing} and cls = ${cls} and nr = ${nr}`;
    const links = uniqBy(d.links, (l) => `${l.kind}/${l.lthing}/${l.cls}/${l.nr}`);
    if (links.length) {
      await tx`insert into matter_links ${tx(links.map((l) => ({ lthing, cls, nr, kind: l.kind, to_lthing: l.lthing, to_cls: l.cls, to_nr: l.nr, to_title: l.title })))}`;
    }

    await tx`delete from matter_rapporteurs where lthing = ${lthing} and cls = ${cls} and nr = ${nr}`;
    const rap = uniqBy(d.rapporteurs, (r) => String(r.memberId));
    if (rap.length) await tx`insert into matter_rapporteurs ${tx(rap.map((r) => ({ lthing, cls, nr, member_id: r.memberId, name: r.name })))}`;

    const docs = uniqBy(d.documents, (x) => String(x.nr));
    await inChunks(docs, (c) => tx`
      insert into documents ${tx(c.map((x) => ({ lthing, nr: x.nr, matter_cls: cls, matter_nr: nr, type: x.type, issued: x.issued, html_url: x.htmlUrl, pdf_url: x.pdfUrl, xml_url: x.xmlUrl })))}
      on conflict (lthing, nr) do update set matter_cls = excluded.matter_cls, matter_nr = excluded.matter_nr, type = excluded.type,
        issued = excluded.issued, html_url = excluded.html_url, pdf_url = excluded.pdf_url, xml_url = excluded.xml_url`);

    const votes = uniqBy(d.votes, (v) => String(v.id));
    await inChunks(votes, (c) => tx`
      insert into votes ${tx(c.map((v) => ({ id: v.id, lthing, cls, nr, voted_at: v.votedAt, kind_code: v.kindCode, kind_label: v.kindLabel, doc_nr: v.docNr, method: v.method, result: v.result, yes: v.yes, no: v.no, abstain: v.abstain })))}
      on conflict (id) do update set voted_at = excluded.voted_at, kind_code = excluded.kind_code, kind_label = excluded.kind_label, doc_nr = excluded.doc_nr,
        method = excluded.method, result = excluded.result, yes = excluded.yes, no = excluded.no, abstain = excluded.abstain`);

    await tx`delete from consultation_requests where lthing = ${lthing} and cls = ${cls} and nr = ${nr}`;
    const consults = uniqBy(d.consultations, (c) => `${c.roundId}|${c.recipient}`);
    await inChunks(consults, (c) => tx`
      insert into consultation_requests ${tx(c.map((x) => ({ round_id: x.roundId, lthing, cls, nr, requested: x.requested, due: x.due, recipient: x.recipient, committee_id: x.committeeId })))}`);

    const subs = uniqBy(d.submissions, (x) => String(x.id));
    await inChunks(subs, (c) => tx`
      insert into submissions ${tx(c.map((x) => ({ id: x.id, lthing, cls, nr, sender: x.sender, committee_id: x.committeeId, kind_code: x.kindCode, kind: x.kind, received: x.received, sent: x.sent, pdf_url: x.pdfUrl })))}
      on conflict (lthing, id) do update set sender = excluded.sender, committee_id = excluded.committee_id, kind_code = excluded.kind_code,
        kind = excluded.kind, received = excluded.received, sent = excluded.sent, pdf_url = excluded.pdf_url`);

    // committees seen in consultations/submissions that the committee list did not provide yet
    const seen = new Map<number, string>();
    for (const c of d.consultations) if (c.committeeId !== null && c.committee) seen.set(c.committeeId, c.committee);
    if (seen.size) await tx`insert into committees ${tx([...seen].map(([id, name]) => ({ id, name })))} on conflict (id) do nothing`;
  });
  // the <ræður> block: member ids for every speaker (non-MP ministers included) -> speeches + sightings
  if (d.speeches?.length) await upsertSpeechIndex(sql, d.speeches, lemmatize, "matter-detail");
}

/** A-mál of a session whose detail has not been fetched yet, in matter-number order. */
export async function matterDetailQueue(sql: Sql, lthing: number, limit: number): Promise<{ nr: number }[]> {
  return sql<{ nr: number }[]>`
    select nr from matters where lthing = ${lthing} and cls = 'A' and detail_fetched_at is null order by nr limit ${limit}`;
}

// ---------------------------------------------------------------- session lists (service L1)

/** thingskjol list: ids, types, links. Never overwrites a matter link; only changed rows are written. */
export async function upsertDocumentList(sql: Sql, rows: import("./parse.ts").DocumentRow[]): Promise<number> {
  const data = uniqBy(rows, (r) => `${r.lthing}/${r.nr}`).map((r) => ({
    lthing: r.lthing, nr: r.nr, type: r.type, issued: r.issued, html_url: r.htmlUrl, pdf_url: r.pdfUrl, xml_url: r.xmlUrl, source: "service",
  }));
  let n = 0;
  await inChunks(data, async (c) => {
    n += (await sql`
      insert into documents ${sql(c)}
      on conflict (lthing, nr) do update set type = excluded.type, issued = coalesce(excluded.issued, documents.issued),
        html_url = coalesce(excluded.html_url, documents.html_url), pdf_url = coalesce(excluded.pdf_url, documents.pdf_url),
        xml_url = coalesce(excluded.xml_url, documents.xml_url)
      where (documents.type, documents.issued, documents.html_url, documents.pdf_url, documents.xml_url)
        is distinct from (excluded.type, coalesce(excluded.issued, documents.issued), coalesce(excluded.html_url, documents.html_url),
                          coalesce(excluded.pdf_url, documents.pdf_url), coalesce(excluded.xml_url, documents.xml_url))`).count;
  });
  return n;
}

/** Vote summaries from a list: the service's labels win, the dump's counts are kept when present (docs/INGEST.md §2). */
export async function upsertVoteList(sql: Sql, rows: import("./parse.ts").VoteRow[]): Promise<number> {
  const data = uniqBy(rows, (r) => String(r.id)).map((v) => ({
    id: v.id, lthing: v.lthing, cls: v.cls, nr: v.nr, voted_at: v.votedAt, kind_code: v.kindCode, kind_label: v.kindLabel,
    doc_nr: v.docNr, method: v.method, result: v.result, yes: v.yes, no: v.no, abstain: v.abstain, source: "service", html_url: v.htmlUrl,
  }));
  let n = 0;
  await inChunks(data, async (c) => {
    n += (await sql`
      insert into votes ${sql(c)}
      on conflict (id) do update set kind_code = excluded.kind_code, kind_label = excluded.kind_label,
        method = coalesce(excluded.method, votes.method), result = coalesce(excluded.result, votes.result),
        voted_at = coalesce(votes.voted_at, excluded.voted_at), doc_nr = coalesce(votes.doc_nr, excluded.doc_nr),
        yes = coalesce(votes.yes, excluded.yes), no = coalesce(votes.no, excluded.no), abstain = coalesce(votes.abstain, excluded.abstain),
        html_url = coalesce(excluded.html_url, votes.html_url)
      where (excluded.html_url is not null and votes.html_url is distinct from excluded.html_url) or (votes.kind_code, votes.kind_label) is distinct from (excluded.kind_code, excluded.kind_label)
         or (excluded.method is not null and votes.method is distinct from excluded.method)
         or (excluded.result is not null and votes.result is distinct from excluded.result)
         or (votes.voted_at is null and excluded.voted_at is not null) or (votes.doc_nr is null and excluded.doc_nr is not null)
         or (votes.yes is null and excluded.yes is not null)`).count;
  });
  return n;
}

import { documentPageUrl, matterPageUrl, memberPageUrl, speechPageUrl, submissionUrl, votePageUrl } from "./althingi-urls.ts";
// Read queries behind the pages. Party is ALWAYS resolved through seats on the date in question, never by session.
import type { Sql } from "./db.ts";

export interface SpeechPage {
  id: string; lthing: number; date: string; started: string; ended: string | null; type: string; debate: string;
  /** null = dump-only speaker not resolved yet: memberName is then the abbreviation */
  memberId: number | null; memberName: string; party: string | null; roleKind: string | null; office: string | null; capacity: string | null;
  matter: { lthing: number; cls: string; nr: number; title: string | null } | null;
  audioUrl: string | null; vodUrl: string | null; wordCount: number | null; textState: string;
  /** Alþingi's provisional text (bráðabirgðatexti), replaced when the final arrives */
  provisional: boolean; textSource: string | null;
  /** the speech on althingi.is (its own text/audio/video page) */
  althingiUrl: string | null;
  paragraphs: { seq: number; text: string; interjections: string[] }[];
  prevId: string | null; nextId: string | null;
}

const ID_RE = /^rad\d{8}T\d{6}$/;
export const isSpeechId = (s: string): boolean => ID_RE.test(s);

/** Party a member sat for on `date` (þingmaður/varamaður seats only; "með varamann" = on leave). */
export async function partyAt(sql: Sql, memberId: number, date: string): Promise<string | null> {
  const r = await sql<{ name: string }[]>`
    select p.name from seats st join parties p on p.id = st.party_id
    where st.member_id = ${memberId} and st.kind in ('þingmaður', 'varamaður')
      and ${date}::date between coalesce(st.from_date, date '0001-01-01') and coalesce(st.to_date, date '9999-12-31')
    order by st.from_date desc nulls last limit 1`;
  return r[0]?.name ?? null;
}

export async function speechPage(sql: Sql, id: string): Promise<SpeechPage | null> {
  const [s] = await sql<{
    id: string; lthing: number; speech_date: string; started: string; ended: string | null; type: string; debate: string;
    member_id: number | null; member_name: string; role_kind: string | null; office: string | null; speaker_capacity: string | null;
    matter_cls: string | null; matter_nr: number | null; title: string | null; audio_url: string | null; vod_url: string | null;
    word_count: number | null; text_state: string; fundur: number | null; provisional: boolean; text_source: string | null; html_url: string | null;
  }[]>`
    select s.id, s.lthing, s.speech_date::text, s.started::text, s.ended::text, s.type, s.debate, s.member_id,
           coalesce(s.member_name, s.speaker_abbr, '') as member_name,
           s.role_kind, s.office, s.speaker_capacity, s.matter_cls, s.matter_nr, m.title, s.audio_url, s.vod_url,
           s.word_count, s.text_state, s.fundur, s.provisional, s.text_source, s.html_url
    from speeches s left join matters m on m.lthing = s.lthing and m.cls = s.matter_cls and m.nr = s.matter_nr
    where s.id = ${id}`;
  if (!s) return null;
  const paragraphs = await sql<{ seq: number; text: string; interjections: string[] }[]>`
    select seq, text, interjections from paragraphs where speech_id = ${id} order by seq`;
  // neighbours within the same sitting and matter (strong link: same fundur + same matter), by time
  const nb = s.matter_cls && s.matter_nr !== null
    ? await sql<{ id: string; dir: string }[]>`
        (select id, 'prev' as dir from speeches where lthing = ${s.lthing} and matter_cls = ${s.matter_cls} and matter_nr = ${s.matter_nr}
           and started < ${s.started}::timestamp and text_state = 'done' order by started desc limit 1)
        union all
        (select id, 'next' as dir from speeches where lthing = ${s.lthing} and matter_cls = ${s.matter_cls} and matter_nr = ${s.matter_nr}
           and started > ${s.started}::timestamp and text_state = 'done' order by started asc limit 1)`
    : [];
  return {
    id: s.id, lthing: s.lthing, date: s.speech_date, started: s.started, ended: s.ended, type: s.type, debate: s.debate,
    memberId: s.member_id, memberName: s.member_name, party: s.member_id === null ? null : await partyAt(sql, s.member_id, s.speech_date),
    roleKind: s.role_kind, office: s.office, capacity: s.speaker_capacity,
    matter: s.matter_cls && s.matter_nr !== null ? { lthing: s.lthing, cls: s.matter_cls, nr: s.matter_nr, title: s.title } : null,
    audioUrl: s.audio_url, vodUrl: s.vod_url, wordCount: s.word_count, textState: s.text_state,
    provisional: s.provisional, textSource: s.text_source, althingiUrl: speechPageUrl(s.lthing, s.id, s.html_url),
    paragraphs, prevId: nb.find((x) => x.dir === "prev")?.id ?? null, nextId: nb.find((x) => x.dir === "next")?.id ?? null,
  };
}

export interface MatterPage {
  lthing: number; cls: string; nr: number; title: string; subtitle: string | null; typeLabel: string | null; statusText: string | null;
  stub: boolean; detailFetched: boolean;
  /** the matter's page (ferill) on althingi.is */
  althingiUrl: string;
  topics: { id: number; name: string }[];
  laws: { year: number; nr: number }[];
  links: { kind: string; lthing: number; cls: string; nr: number; title: string | null }[];
  documents: { nr: number; type: string; issued: string | null; htmlUrl: string | null; althingiUrl: string }[];
  votes: { id: number; at: string | null; kind: string; method: string | null; result: string | null; yes: number | null; no: number | null; abstain: number | null; althingiUrl: string }[];
  consultations: { due: string | null; recipient: string; committee: string | null }[];
  submissionCount: number;
  speeches: { id: string; started: string; date: string; memberId: number; memberName: string; type: string; debate: string; words: number | null }[];
  speechCount: number;
}

export async function matterPage(sql: Sql, lthing: number, cls: string, nr: number): Promise<MatterPage | null> {
  const [m] = await sql<{ title: string; subtitle: string | null; type_label: string | null; status_text: string | null; stub: boolean; fetched: boolean; html_url: string | null }[]>`
    select title, subtitle, type_label, status_text, stub, detail_fetched_at is not null as fetched, html_url
    from matters where lthing = ${lthing} and cls = ${cls} and nr = ${nr}`;
  if (!m) return null;
  const [topics, laws, links, documents, votes, consults, subs, speeches, cnt] = await Promise.all([
    sql<{ id: number; name: string }[]>`select e.id, e.name from matter_efnisflokkar x join efnisflokkar e on e.id = x.efnisflokkur_id where x.lthing = ${lthing} and x.cls = ${cls} and x.nr = ${nr}`,
    sql<{ law_year: number; law_nr: number }[]>`select law_year, law_nr from matter_laws where lthing = ${lthing} and cls = ${cls} and nr = ${nr} order by 1, 2`,
    sql<{ kind: string; to_lthing: number; to_cls: string; to_nr: number; to_title: string | null }[]>`select kind, to_lthing, to_cls, to_nr, to_title from matter_links where lthing = ${lthing} and cls = ${cls} and nr = ${nr}`,
    sql<{ nr: number; type: string; issued: string | null; html_url: string | null }[]>`select nr, type, issued::text, html_url from documents where lthing = ${lthing} and matter_cls = ${cls} and matter_nr = ${nr} order by nr`,
    sql<{ id: number; at: string | null; kind_label: string; method: string | null; result: string | null; yes: number | null; no: number | null; abstain: number | null; html_url: string | null }[]>`
      select id, voted_at::text as at, kind_label, method, result, yes, no, abstain, html_url from votes where lthing = ${lthing} and cls = ${cls} and nr = ${nr} order by voted_at, id`,
    sql<{ due: string | null; recipient: string; committee: string | null }[]>`
      select cr.due::text, cr.recipient, c.name as committee from consultation_requests cr left join committees c on c.id = cr.committee_id
      where cr.lthing = ${lthing} and cr.cls = ${cls} and cr.nr = ${nr} order by cr.due, cr.recipient limit 200`,
    sql<{ n: number }[]>`select count(*)::int n from submissions where lthing = ${lthing} and cls = ${cls} and nr = ${nr}`,
    sql<{ id: string; started: string; speech_date: string; member_id: number; member_name: string; type: string; debate: string; word_count: number | null }[]>`
      select id, started::text, speech_date::text, member_id, member_name, type, debate, word_count from speeches
      where lthing = ${lthing} and matter_cls = ${cls} and matter_nr = ${nr} and text_state = 'done' order by started limit 300`,
    sql<{ n: number }[]>`select count(*)::int n from speeches where lthing = ${lthing} and matter_cls = ${cls} and matter_nr = ${nr} and text_state = 'done'`,
  ]);
  return {
    lthing, cls, nr, title: m.title, subtitle: m.subtitle, typeLabel: m.type_label, statusText: m.status_text, stub: m.stub, detailFetched: m.fetched,
    althingiUrl: matterPageUrl(lthing, cls, nr, m.html_url),
    topics, laws: laws.map((l) => ({ year: l.law_year, nr: l.law_nr })),
    links: links.map((l) => ({ kind: l.kind, lthing: l.to_lthing, cls: l.to_cls, nr: l.to_nr, title: l.to_title })),
    documents: documents.map((d) => ({ nr: d.nr, type: d.type, issued: d.issued, htmlUrl: d.html_url, althingiUrl: documentPageUrl(lthing, d.nr, d.html_url) })),
    votes: votes.map((v) => ({ id: v.id, at: v.at, kind: v.kind_label, method: v.method, result: v.result, yes: v.yes, no: v.no, abstain: v.abstain, althingiUrl: votePageUrl(v.id, v.html_url) })),
    consultations: consults, submissionCount: subs[0]?.n ?? 0,
    speeches: speeches.map((s) => ({ id: s.id, started: s.started, date: s.speech_date, memberId: s.member_id, memberName: s.member_name, type: s.type, debate: s.debate, words: s.word_count })),
    speechCount: cnt[0]?.n ?? 0,
  };
}

export interface MemberPage {
  id: number; name: string; born: string | null;
  /** the member's CV page on althingi.is */
  althingiUrl: string;
  seats: { lthing: number; kind: string; party: string | null; constituency: string | null; from: string | null; to: string | null }[];
  speechCount: number;
  recent: { id: string; started: string; type: string; matterTitle: string | null; matterCls: string | null; matterNr: number | null; lthing: number; words: number | null }[];
}

export async function memberPage(sql: Sql, id: number): Promise<MemberPage | null> {
  const [m] = await sql<{ name: string; born: string | null; cv_url: string | null }[]>`select name, born::text, cv_url from members where id = ${id}`;
  // a speaker that has speeches but no members row yet still gets a page
  const [fallback] = m ? [] : await sql<{ member_name: string }[]>`select member_name from speeches where member_id = ${id} limit 1`;
  if (!m && !fallback) return null;
  const [seats, cnt, recent] = await Promise.all([
    sql<{ lthing: number; kind: string; party: string | null; constituency: string | null; from_date: string | null; to_date: string | null }[]>`
      select st.lthing, st.kind, p.name as party, st.constituency, st.from_date::text, st.to_date::text from seats st left join parties p on p.id = st.party_id
      where st.member_id = ${id} order by st.from_date nulls first, st.lthing`,
    sql<{ n: number }[]>`select count(*)::int n from speeches where member_id = ${id} and text_state = 'done'`,
    sql<{ id: string; started: string; type: string; title: string | null; matter_cls: string | null; matter_nr: number | null; lthing: number; word_count: number | null }[]>`
      select s.id, s.started::text, s.type, m.title, s.matter_cls, s.matter_nr, s.lthing, s.word_count from speeches s
      left join matters m on m.lthing = s.lthing and m.cls = s.matter_cls and m.nr = s.matter_nr
      where s.member_id = ${id} and s.text_state = 'done' order by s.started desc limit 40`,
  ]);
  return {
    id, name: m?.name ?? fallback!.member_name, born: m?.born ?? null, althingiUrl: memberPageUrl(id, m?.cv_url),
    seats: seats.map((s) => ({ lthing: s.lthing, kind: s.kind, party: s.party, constituency: s.constituency, from: s.from_date, to: s.to_date })),
    speechCount: cnt[0]?.n ?? 0,
    recent: recent.map((r) => ({ id: r.id, started: r.started, type: r.type, matterTitle: r.title, matterCls: r.matter_cls, matterNr: r.matter_nr, lthing: r.lthing, words: r.word_count })),
  };
}

export interface DayPage {
  date: string;
  groups: { lthing: number; cls: string | null; nr: number | null; title: string | null; speeches: { id: string; started: string; memberName: string; type: string; words: number | null }[] }[];
  total: number;
  prev: string | null;
  next: string | null;
}

export async function dayPage(sql: Sql, date: string): Promise<DayPage | null> {
  const rows = await sql<{ id: string; started: string; member_name: string; type: string; word_count: number | null; lthing: number; matter_cls: string | null; matter_nr: number | null; title: string | null }[]>`
    select s.id, s.started::text, s.member_name, s.type, s.word_count, s.lthing, s.matter_cls, s.matter_nr, m.title
    from speeches s left join matters m on m.lthing = s.lthing and m.cls = s.matter_cls and m.nr = s.matter_nr
    where s.speech_date = ${date} and s.text_state = 'done' order by s.started limit 2000`;
  const [nb] = await sql<{ prev: string | null; next: string | null }[]>`
    select (select max(speech_date)::text from speeches where speech_date < ${date} and text_state = 'done') as prev,
           (select min(speech_date)::text from speeches where speech_date > ${date} and text_state = 'done') as next`;
  if (!rows.length && !nb?.prev && !nb?.next) return null;
  const groups = new Map<string, DayPage["groups"][number]>();
  for (const r of rows) {
    const k = `${r.lthing}/${r.matter_cls ?? "-"}/${r.matter_nr ?? "-"}`;
    let g = groups.get(k);
    if (!g) { g = { lthing: r.lthing, cls: r.matter_cls, nr: r.matter_nr, title: r.title, speeches: [] }; groups.set(k, g); }
    g.speeches.push({ id: r.id, started: r.started, memberName: r.member_name, type: r.type, words: r.word_count });
  }
  return { date, groups: [...groups.values()], total: rows.length, prev: nb?.prev ?? null, next: nb?.next ?? null };
}

export async function corpusStats(sql: Sql): Promise<{ speeches: number; from: string | null; to: string | null; lastIngest: Date | null }> {
  const [r] = await sql<{ n: number; d0: string | null; d1: string | null; last: Date | null }[]>`
    select count(*)::int n, min(speech_date)::text d0, max(speech_date)::text d1, max(fetched_at) as last from speeches where text_state = 'done'`;
  return { speeches: r?.n ?? 0, from: r?.d0 ?? null, to: r?.d1 ?? null, lastIngest: r?.last ?? null };
}

/** Party on the speech date for many speeches at once (one query). Map key = speech id. */
export async function partiesFor(sql: Sql, items: { speechId: string; memberId: number | null; date: string }[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (!items.length) return out;
  const rows = await sql<{ sid: string; party: string | null }[]>`
    select k.sid, (
      select p.name from seats st join parties p on p.id = st.party_id
      where st.member_id = k.mid and st.kind in ('þingmaður', 'varamaður')
        and k.d::date between coalesce(st.from_date, date '0001-01-01') and coalesce(st.to_date, date '9999-12-31')
      order by st.from_date desc nulls last limit 1) as party
    from unnest(${items.map((i) => i.speechId)}::text[], ${items.map((i) => i.memberId)}::int[], ${items.map((i) => i.date)}::text[]) as k(sid, mid, d)`;
  for (const r of rows) out.set(r.sid, r.party);
  return out;
}

export interface LawPage {
  year: number; nr: number;
  /** from the law collection (null when the law is not in the current lagasafn, e.g. only an amending act) */
  law: { title: string; chapter: string | null; inForce: string | null; edition: string; matter: { lthing: number; nr: number; title: string | null } | null } | null;
  /** matters (in this corpus) that amend the law, from matter detail <breytingaráLögum> */
  matters: { lthing: number; cls: string; nr: number; title: string; status: string | null }[];
  /** "Breytt með" in the collection: acts that amended this law */
  amendedBy: { year: number; nr: number; effective: string | null; title: string | null }[];
  /** laws this act amended (the same list read from the other side) */
  amends: { year: number; nr: number; title: string | null }[];
}

export async function lawPage(sql: Sql, year: number, nr: number): Promise<LawPage> {
  const [matters, [law], amendedBy, amends] = await Promise.all([
    sql<{ lthing: number; cls: string; nr: number; title: string; status: string | null }[]>`
      select m.lthing, m.cls, m.nr, m.title, m.status_text as status
      from matter_laws l join matters m on m.lthing = l.lthing and m.cls = l.cls and m.nr = l.nr
      where l.law_year = ${year} and l.law_nr = ${nr} order by m.lthing desc, m.nr`,
    sql<{ title: string; chapter: string | null; in_force: string | null; edition: string; matter_lthing: number | null; matter_nr: number | null; mtitle: string | null }[]>`
      select l.title, l.chapter, l.in_force, l.edition, l.matter_lthing, l.matter_nr, m.title as mtitle
      from laws_current l left join matters m on m.lthing = l.matter_lthing and m.cls = 'A' and m.nr = l.matter_nr
      where l.year = ${year} and l.nr = ${nr}`,
    sql<{ by_year: number; by_nr: number; effective_text: string | null; title: string | null }[]>`
      select a.by_year, a.by_nr, a.effective_text, c.title from law_amendments a left join laws_current c on c.year = a.by_year and c.nr = a.by_nr
      where a.year = ${year} and a.nr = ${nr} order by a.by_year desc, a.by_nr desc`,
    sql<{ year: number; nr: number; title: string | null }[]>`
      select a.year, a.nr, c.title from law_amendments a left join laws_current c on c.year = a.year and c.nr = a.nr
      where a.by_year = ${year} and a.by_nr = ${nr} order by a.year, a.nr`,
  ]);
  return {
    year, nr, matters,
    law: law ? {
      title: law.title, chapter: law.chapter, inForce: law.in_force, edition: law.edition,
      matter: law.matter_lthing !== null && law.matter_nr !== null ? { lthing: law.matter_lthing, nr: law.matter_nr, title: law.mtitle } : null,
    } : null,
    amendedBy: amendedBy.map((a) => ({ year: a.by_year, nr: a.by_nr, effective: a.effective_text, title: a.title })),
    amends,
  };
}

/**
 * Which session counts as "current" for routing and boosts: the latest one WE HAVE DATA FOR (bare references like
 * "300. mál" must land on a page that exists). `complete` = sessions with no pending speech text AND matter detail for
 * ≥ 95 % of their A-mál (a dump-ingested session has every text at once, long before its matter pages are filled):
 * only those are safe to cache as immutable. A session still being backfilled stays on short TTLs, whatever its number.
 */
export async function sessionState(sql: Sql): Promise<{ lthing: number; first: number; starts: string | null; complete: Set<number> }> {
  const sessions = await sql<{ lthing: number; pending: number; done: number }[]>`
    select lthing, count(*) filter (where text_state = 'pending')::int as pending, count(*) filter (where text_state = 'done')::int as done
    from speeches where era = 'xml' group by lthing`;
  const withData = sessions.filter((x) => x.done > 0).map((x) => x.lthing);
  const lthing = withData.length ? Math.max(...withData) : 0;
  const [st] = await sql<{ starts: string | null }[]>`select starts::text from sessions where lthing = ${lthing}`;
  const first = withData.length ? Math.min(...withData) : 0;
  const cover = new Map((await sql<{ lthing: number; a: number; fetched: number }[]>`
    select lthing, count(*)::int a, count(detail_fetched_at)::int fetched from matters where cls = 'A' group by lthing`)
    .map((r) => [r.lthing, r.a === 0 ? 1 : r.fetched / r.a]));
  const complete = sessions.filter((x) => x.pending === 0 && x.done > 0 && (cover.get(x.lthing) ?? 1) >= 0.95).map((x) => x.lthing);
  return { lthing, first, starts: st?.starts ?? null, complete: new Set(complete) };
}

/** The seats at the END of a session (members on leave count; their stand-ins do not): who "sits" for each party. */
export async function composition(sql: Sql, lthing: number): Promise<{ id: number; name: string; seats: number }[]> {
  return sql<{ id: number; name: string; seats: number }[]>`
    select p.id, p.name, count(distinct st.member_id)::int as seats
    from seats st join parties p on p.id = st.party_id
    where st.lthing = ${lthing} and st.kind in ('þingmaður', 'með varamann')
      and coalesce(st.to_date, date '9999-12-31') >= coalesce((select max(to_date) from seats where lthing = ${lthing}), date '0001-01-01')
    group by p.id, p.name order by seats desc, p.name`;
}

export interface PartyPage {
  id: number; name: string; lthing: number | null; speechCount: number;
  /** members at the end of the party's latest session, then everyone else who sat for it that session */
  members: { id: number; name: string; constituency: string | null; kind: string; sitting: boolean; speeches: number }[];
  /** most speeches for this party (seat on the speech date), across the whole corpus */
  top: { id: number; name: string; speeches: number }[];
  recent: { id: string; started: string; type: string; memberId: number; memberName: string; lthing: number; cls: string | null; nr: number | null; title: string | null }[];
}

export async function partyPage(sql: Sql, id: number): Promise<PartyPage | null> {
  const [p] = await sql<{ name: string; lthing: number | null }[]>`
    select name, (select max(lthing) from seats where party_id = ${id}) as lthing from parties where id = ${id}`;
  if (!p) return null;
  // speeches given while seated for this party (seat on the speech date), restricted to members who ever sat for it
  const forParty = sql`
    sp.text_state = 'done' and sp.member_id in (select member_id from seats where party_id = ${id})
    and exists (select 1 from seats st where st.member_id = sp.member_id and st.party_id = ${id} and st.kind in ('þingmaður', 'varamaður')
      and sp.speech_date between coalesce(st.from_date, date '0001-01-01') and coalesce(st.to_date, date '9999-12-31'))`;
  const [members, counts, recent] = await Promise.all([
    p.lthing === null ? [] : sql<{ id: number; name: string; constituency: string | null; kind: string; sitting: boolean }[]>`
      select distinct on (st.member_id) st.member_id as id, m.name, st.constituency, st.kind,
        (st.kind in ('þingmaður', 'með varamann') and coalesce(st.to_date, date '9999-12-31')
          >= coalesce((select max(to_date) from seats where lthing = ${p.lthing}), date '0001-01-01')) as sitting
      from seats st join members m on m.id = st.member_id
      where st.party_id = ${id} and st.lthing = ${p.lthing}
      order by st.member_id, sitting desc, st.from_date desc nulls last`,
    sql<{ id: number; name: string; n: number }[]>`
      select sp.member_id as id, min(sp.member_name) as name, count(*)::int as n from speeches sp where ${forParty}
      group by sp.member_id order by n desc`,
    sql<{ id: string; started: string; type: string; member_id: number; member_name: string; lthing: number; matter_cls: string | null; matter_nr: number | null; title: string | null }[]>`
      select sp.id, sp.started::text, sp.type, sp.member_id, sp.member_name, sp.lthing, sp.matter_cls, sp.matter_nr, m.title
      from speeches sp left join matters m on m.lthing = sp.lthing and m.cls = sp.matter_cls and m.nr = sp.matter_nr
      where ${forParty} order by sp.started desc limit 20`,
  ]);
  const n = new Map(counts.map((c) => [c.id, c.n]));
  return {
    id, name: p.name, lthing: p.lthing,
    speechCount: counts.reduce((a, c) => a + c.n, 0),
    members: members
      .map((m) => ({ ...m, speeches: n.get(m.id) ?? 0 }))
      .sort((a, b) => Number(b.sitting) - Number(a.sitting) || a.name.localeCompare(b.name, "is")),
    top: counts.slice(0, 10).map((c) => ({ id: c.id, name: c.name, speeches: c.n })),
    recent: recent.map((r) => ({ id: r.id, started: r.started, type: r.type, memberId: r.member_id, memberName: r.member_name, lthing: r.lthing, cls: r.matter_cls, nr: r.matter_nr, title: r.title })),
  };
}

// ---------------------------------------------------------------- matter extras: rapporteurs, submissions, timeline

export interface MatterExtras {
  rapporteurs: { memberId: number; name: string }[];
  submissions: { sender: string; kind: string | null; received: string | null; pdfUrl: string | null }[];
  committees: { id: number; name: string }[];
  /** one axis, oldest first: documents issued, first speech of each debate stage, votes */
  timeline: { at: string; kind: "skjal" | "umræða" | "atkvæði"; label: string; href?: string }[];
}

export async function matterExtras(sql: Sql, lthing: number, cls: string, nr: number): Promise<MatterExtras> {
  const [rap, subs, comms, docs, stages, votes] = await Promise.all([
    sql<{ member_id: number; name: string }[]>`select member_id, name from matter_rapporteurs where lthing = ${lthing} and cls = ${cls} and nr = ${nr} order by name`,
    sql<{ sender: string; kind: string | null; received: string | null; pdf_url: string | null }[]>`
      select sender, kind, received::text, pdf_url from submissions where lthing = ${lthing} and cls = ${cls} and nr = ${nr} order by received nulls last, sender limit 300`,
    sql<{ id: number; name: string }[]>`
      select distinct c.id, c.name from committees c
      where c.id in (select committee_id from consultation_requests where lthing = ${lthing} and cls = ${cls} and nr = ${nr}
                     union select committee_id from submissions where lthing = ${lthing} and cls = ${cls} and nr = ${nr})`,
    sql<{ nr: number; type: string; issued: string | null }[]>`select nr, type, issued::text from documents where lthing = ${lthing} and matter_cls = ${cls} and matter_nr = ${nr} and issued is not null`,
    sql<{ debate: string; started: string; n: number }[]>`
      select debate, min(started)::text as started, count(*)::int n from speeches
      where lthing = ${lthing} and matter_cls = ${cls} and matter_nr = ${nr} and text_state = 'done' group by debate`,
    sql<{ at: string | null; kind_label: string; result: string | null; yes: number | null; no: number | null }[]>`
      select voted_at::text as at, kind_label, result, yes, no from votes where lthing = ${lthing} and cls = ${cls} and nr = ${nr} and voted_at is not null`,
  ]);
  const stageLabel = (d: string) => (/^[123]$/.test(d) ? `${d}. umræða hefst` : "Umræða");
  const raw: MatterExtras["timeline"] = [
    ...docs.map((d) => ({ at: d.issued!, kind: "skjal" as const, label: `Þingskjal ${d.nr}: ${d.type}`, href: `/thingskjal/${lthing}/${d.nr}` })),
    ...stages.map((s) => ({ at: s.started, kind: "umræða" as const, label: `${stageLabel(s.debate)} (${s.n} ${s.n === 1 ? "ræða" : "ræður"})` })),
    ...votes.filter((v) => v.result || v.yes !== null).map((v) => ({ at: v.at!, kind: "atkvæði" as const, label: `${v.kind_label}${v.result ? `: ${v.result}` : ""}${v.yes !== null ? ` (${v.yes}–${v.no ?? 0})` : ""}` })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  // a day of amendment votes is one line, not thirty: "18.6.2026 · 27 atkvæðagreiðslur, síðast: Þskj.: samþykkt (48–0)"
  const timeline: MatterExtras["timeline"] = [];
  for (const e of raw) {
    const prev = timeline[timeline.length - 1];
    if (e.kind === "atkvæði" && prev?.kind === "atkvæði" && prev.at.slice(0, 10) === e.at.slice(0, 10)) {
      const n = (Number(prev.label.match(/^(\d+) atkvæðagreiðslur/)?.[1]) || 1) + 1;
      timeline[timeline.length - 1] = { ...prev, label: `${n} atkvæðagreiðslur, síðast: ${e.label}`, href: "#atkvaedi" };
    } else timeline.push({ ...e, ...(e.kind === "atkvæði" ? { href: "#atkvaedi" } : {}) });
  }
  return {
    rapporteurs: rap.map((r) => ({ memberId: r.member_id, name: r.name })),
    submissions: subs.map((s) => ({ sender: s.sender, kind: s.kind, received: s.received, pdfUrl: submissionUrl(s.pdf_url) })),
    committees: comms, timeline,
  };
}

// ---------------------------------------------------------------- one document (þingskjal): ids + links, no text yet

export interface DocPage {
  lthing: number; nr: number; type: string; issued: string | null; htmlUrl: string | null; pdfUrl: string | null;
  /** the document on althingi.is (stored html link, else the confirmed /altext/<l>/s/<nnnn>.html pattern) */
  althingiUrl: string;
  matter: { cls: string; nr: number; title: string | null } | null;
  votes: { id: number; at: string | null; kind: string; result: string | null; yes: number | null; no: number | null; abstain: number | null; althingiUrl: string }[];
}

export async function docPage(sql: Sql, lthing: number, nr: number): Promise<DocPage | null> {
  const [d] = await sql<{ type: string; issued: string | null; html_url: string | null; pdf_url: string | null; matter_cls: string | null; matter_nr: number | null; title: string | null }[]>`
    select d.type, d.issued::text, d.html_url, d.pdf_url, d.matter_cls, d.matter_nr, m.title
    from documents d left join matters m on m.lthing = d.lthing and m.cls = d.matter_cls and m.nr = d.matter_nr
    where d.lthing = ${lthing} and d.nr = ${nr}`;
  if (!d) return null;
  const votes = await sql<{ id: number; at: string | null; kind_label: string; result: string | null; yes: number | null; no: number | null; abstain: number | null; html_url: string | null }[]>`
    select id, voted_at::text as at, kind_label, result, yes, no, abstain, html_url from votes where lthing = ${lthing} and doc_nr = ${nr} order by voted_at, id`;
  return {
    lthing, nr, type: d.type, issued: d.issued, htmlUrl: d.html_url, pdfUrl: d.pdf_url, althingiUrl: documentPageUrl(lthing, nr, d.html_url),
    matter: d.matter_cls && d.matter_nr !== null ? { cls: d.matter_cls, nr: d.matter_nr, title: d.title } : null,
    votes: votes.map((v) => ({ id: v.id, at: v.at, kind: v.kind_label, result: v.result, yes: v.yes, no: v.no, abstain: v.abstain, althingiUrl: votePageUrl(v.id, v.html_url) })),
  };
}

// ---------------------------------------------------------------- efnisflokkur and committee pages

export interface ListedMatter { lthing: number; cls: string; nr: number; title: string; type: string | null; status: string | null }

export async function topicPage(sql: Sql, id: number): Promise<{ id: number; name: string; parent: string | null; description: string | null; matters: ListedMatter[] } | null> {
  const [e] = await sql<{ name: string; parent_name: string | null; description: string | null }[]>`select name, parent_name, description from efnisflokkar where id = ${id}`;
  if (!e) return null;
  const matters = await sql<{ lthing: number; cls: string; nr: number; title: string; type_label: string | null; status_text: string | null }[]>`
    select m.lthing, m.cls, m.nr, m.title, m.type_label, m.status_text from matter_efnisflokkar x
    join matters m on (m.lthing, m.cls, m.nr) = (x.lthing, x.cls, x.nr)
    where x.efnisflokkur_id = ${id} order by m.lthing desc, m.nr limit 500`;
  return { id, name: e.name, parent: e.parent_name, description: e.description, matters: matters.map((m) => ({ lthing: m.lthing, cls: m.cls, nr: m.nr, title: m.title, type: m.type_label, status: m.status_text })) };
}

export interface CommitteeMatter extends ListedMatter { due: string | null; requests: number; submissions: number }

export async function committeePage(sql: Sql, id: number): Promise<{ id: number; name: string; matters: CommitteeMatter[] } | null> {
  const [c] = await sql<{ name: string }[]>`select name from committees where id = ${id}`;
  if (!c) return null;
  const rows = await sql<{ lthing: number; cls: string; nr: number; title: string; type_label: string | null; status_text: string | null; due: string | null; requests: number; submissions: number }[]>`
    with mm as (
      select lthing, cls, nr, max(due) as due, count(*)::int as requests from consultation_requests where committee_id = ${id} group by 1, 2, 3
      union
      select lthing, cls, nr, null, 0 from submissions where committee_id = ${id} group by 1, 2, 3
    ), agg as (select lthing, cls, nr, max(due) as due, max(requests) as requests from mm group by 1, 2, 3)
    select a.lthing, a.cls, a.nr, m.title, m.type_label, m.status_text, a.due::text, a.requests,
           (select count(*)::int from submissions s where (s.lthing, s.cls, s.nr) = (a.lthing, a.cls, a.nr)) as submissions
    from agg a join matters m on (m.lthing, m.cls, m.nr) = (a.lthing, a.cls, a.nr)
    order by a.due desc nulls last, a.lthing desc, a.nr desc limit 500`;
  return { id, name: c.name, matters: rows.map((r) => ({ lthing: r.lthing, cls: r.cls, nr: r.nr, title: r.title, type: r.type_label, status: r.status_text, due: r.due, requests: r.requests, submissions: r.submissions })) };
}

// ---------------------------------------------------------------- the whole debate on a matter (print view) and its feed

export interface TranscriptSpeech { id: string; started: string; date: string; memberName: string; party: string | null; type: string; debate: string; paragraphs: string[] }

export async function matterTranscript(sql: Sql, lthing: number, cls: string, nr: number, max = 400): Promise<TranscriptSpeech[]> {
  const rows = await sql<{ id: string; started: string; speech_date: string; member_id: number; member_name: string; type: string; debate: string; paras: string[] }[]>`
    select s.id, s.started::text, s.speech_date::text, s.member_id, s.member_name, s.type, s.debate,
           array(select text from paragraphs p where p.speech_id = s.id order by seq) as paras
    from speeches s where s.lthing = ${lthing} and s.matter_cls = ${cls} and s.matter_nr = ${nr} and s.text_state = 'done'
    order by s.started limit ${max}`;
  const parties = await partiesFor(sql, rows.map((r) => ({ speechId: r.id, memberId: r.member_id, date: r.speech_date })));
  return rows.map((r) => ({ id: r.id, started: r.started, date: r.speech_date, memberName: r.member_name, party: parties.get(r.id) ?? null, type: r.type, debate: r.debate, paragraphs: r.paras }));
}

export async function matterFeed(sql: Sql, lthing: number, cls: string, nr: number) {
  const [speeches, votes, docs] = await Promise.all([
    sql<{ id: string; started: string; member_name: string; type: string; text: string | null }[]>`
      select s.id, s.started::text, s.member_name, s.type, (select text from paragraphs where speech_id = s.id order by seq limit 1) as text
      from speeches s where s.lthing = ${lthing} and s.matter_cls = ${cls} and s.matter_nr = ${nr} and s.text_state = 'done'
      order by s.started desc limit 30`,
    sql<{ id: number; at: string; kind_label: string; result: string | null; yes: number | null; no: number | null; abstain: number | null }[]>`
      select id, voted_at::text as at, kind_label, result, yes, no, abstain from votes
      where lthing = ${lthing} and cls = ${cls} and nr = ${nr} and voted_at is not null order by voted_at desc limit 30`,
    sql<{ nr: number; type: string; issued: string; html_url: string | null }[]>`
      select nr, type, issued::text, html_url from documents
      where lthing = ${lthing} and matter_cls = ${cls} and matter_nr = ${nr} and issued is not null order by issued desc limit 30`,
  ]);
  return { speeches, votes, docs };
}

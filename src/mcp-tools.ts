// MCP tool implementations as plain functions (testable without the protocol). Shapes follow docs/PERSONAS.md:
// small chainable payloads, ids + source URLs everywhere, a `corpus` block on every response, derived/inferred flags,
// and a structured `why` when a search returns nothing.
import type { Sql } from "./db.ts";
import { parseQuery, describe } from "./explain.ts";
import { matterPage, memberPage, partiesFor, speechPage } from "./queries.ts";
import { phraseTsQuery, recallTsQuery, search } from "./search.ts";
import { fmtTime, citation, SITE } from "./pages.tsx";

export interface Ctx { sql: Sql; currentLthing: number }

const SNIPPET_MAX = 400;
const clip = (s: string, n = SNIPPET_MAX) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export async function corpusBlock(sql: Sql) {
  const [r] = await sql<{ n: number; d0: string | null; d1: string | null; sessions: number[] }[]>`
    select count(*)::int n, min(speech_date)::text d0, max(speech_date)::text d1,
           coalesce(array_agg(distinct lthing order by lthing) filter (where lthing is not null), '{}') as sessions
    from speeches where text_state = 'done'`;
  return {
    text_from: "2005",
    speeches_with_text: r?.n ?? 0,
    sessions_with_text: r?.sessions ?? [],
    text_dates: { from: r?.d0 ?? null, to: r?.d1 ?? null },
    note: "Ræðutexti er til frá 2005 (XML-öld). Eldri ræður eru ekki leitarbærar. 'Fyrst', 'aldrei' og samtölur eiga við textana í safninu (sjá text_dates/sessions_with_text), ekki allan feril Alþingis.",
  };
}

export interface SearchArgs {
  q: string; member_id?: number; party_id?: number; date_from?: string; date_to?: string; lthing?: number;
  speech_type?: string; office?: string; debate?: string[]; capacity?: string; matter?: string; sort?: "relevance" | "newest";
  limit?: number; cursor?: string;
}

function whyEmpty(q: string, parsed: ReturnType<typeof parseQuery>, filtered: boolean): string[] {
  const why: string[] = [];
  if (!q.trim()) why.push("empty_query");
  else if (parsed.empty) why.push("only_stopwords_or_numbers");
  if (parsed.numbers.length) why.push("numbers_must_be_within_8_tokens_of_a_query_word");
  if (filtered) why.push("filters_may_exclude_everything");
  why.push("text_corpus_starts_2005", "interjections_not_indexed", "all_query_words_must_match_in_the_same_paragraph");
  return why;
}

export async function searchSpeeches(ctx: Ctx, a: SearchArgs) {
  const { sql } = ctx;
  const m = a.matter?.match(/^([abAB])\/(\d{1,5})$/);
  const limit = Math.min(Math.max(a.limit ?? 10, 1), 100);
  const compact = limit > 25;
  const r = await search(sql, {
    q: a.q, memberId: a.member_id, partyId: a.party_id, dateFrom: a.date_from, dateTo: a.date_to, lthing: a.lthing,
    type: a.speech_type, office: a.office, debate: a.debate, capacity: a.capacity,
    matterCls: m ? m[1]!.toUpperCase() : undefined, matterNr: m ? Number(m[2]) : undefined,
    sort: a.sort, limit: Math.min(limit, 25), currentLthing: ctx.currentLthing, cursor: a.cursor,
  });
  const parties = await partiesFor(sql, r.hits.map((h) => ({ speechId: h.speechId, memberId: h.memberId, date: h.date })));
  const filtered = Boolean(a.member_id || a.party_id || a.date_from || a.date_to || a.lthing || a.speech_type || a.office || a.debate || a.capacity || a.matter);
  return {
    corpus: await corpusBlock(sql),
    query: { text: a.q, interpreted_as: r.query.description, dropped_stopwords: r.query.parsed.dropped, numbers: r.query.parsed.numbers },
    hits: r.hits.map((h) => ({
      speech_id: h.speechId, date: h.date, started: h.started, time: fmtTime(h.started),
      member: { id: h.memberId, name: h.memberName, party_at_date: parties.get(h.speechId) ?? null },
      speech_type: h.speechType, debate: h.debate,
      matter: h.matter ? { lthing: h.matter.lthing, class: h.matter.cls, nr: h.matter.nr, title: h.matter.title, url: `${SITE}/mal/${h.matter.lthing}/${h.matter.cls.toLowerCase()}/${h.matter.nr}` } : null,
      score: Math.round(h.score * 1000) / 1000, matching_paragraphs: h.matchingParagraphs,
      paragraphs: h.paragraphs.slice(0, compact ? 1 : 2).map((p) => ({
        mgr: p.seq + 1, text: clip(p.snippets[0]?.text ?? "", compact ? 200 : SNIPPET_MAX), url: `${SITE}/raeda/${h.speechId}#mgr-${p.seq + 1}`,
      })),
      url: `${SITE}/raeda/${h.speechId}`,
    })),
    matter_cards: r.matterCards.map((c) => ({ lthing: c.lthing, class: c.cls, nr: c.nr, title: c.title, url: `${SITE}/mal/${c.lthing}/${c.cls.toLowerCase()}/${c.nr}` })),
    next_cursor: r.nextCursor,
    ...(r.hits.length === 0 ? { why: whyEmpty(a.q, r.query.parsed, filtered) } : {}),
    derived: false,
  };
}

export async function getSpeech(ctx: Ctx, a: { speech_id: string; from?: number; to?: number }) {
  const s = await speechPage(ctx.sql, a.speech_id);
  if (!s) return { error: "speech_not_found", speech_id: a.speech_id, corpus: await corpusBlock(ctx.sql) };
  const [rev] = await ctx.sql<{ raw_sha256: string | null; fetched_at: Date | null; lemma_is_version: string | null }[]>`
    select raw_sha256, fetched_at, lemma_is_version from speeches where id = ${a.speech_id}`;
  const from = Math.max(1, a.from ?? 1);
  // budget: at most 40 paragraphs / ~12 KB of text per call, then `next_from`
  let bytes = 0;
  const out: { mgr: number; text: string; interjections: string[] }[] = [];
  let next: number | null = null;
  for (const p of s.paragraphs) {
    const n = p.seq + 1;
    if (n < from || (a.to !== undefined && n > a.to)) continue;
    if (out.length >= 40 || bytes + p.text.length > 12_000) { next = n; break; }
    bytes += p.text.length;
    out.push({ mgr: n, text: p.text, interjections: p.interjections });
  }
  return {
    corpus: await corpusBlock(ctx.sql),
    speech: {
      id: s.id, url: `${SITE}/raeda/${s.id}`, date: s.date, started: s.started, ended: s.ended, speech_type: s.type, debate: s.debate,
      member: { id: s.memberId, name: s.memberName, party_at_date: s.party }, office: s.office, capacity: s.capacity,
      matter: s.matter ? { lthing: s.matter.lthing, class: s.matter.cls, nr: s.matter.nr, title: s.matter.title } : null,
      audio_url: s.audioUrl, video_url: s.vodUrl, word_count: s.wordCount,
      prev_in_matter: s.prevId, next_in_matter: s.nextId, // same matter, by time: strong link
      citation: citation(s),
      revision: { raw_sha256: rev?.raw_sha256 ?? null, fetched_at: rev?.fetched_at ?? null, lemma_is_version: rev?.lemma_is_version ?? null },
    },
    paragraphs: out, paragraphs_total: s.paragraphs.length, next_from: next,
    interjections_note: "Framíköll (annarra þingmanna) eru birt hér en ekki leitarbær.",
    derived: false,
  };
}

/** Evidence window: paragraphs around one paragraph, with its cite string. */
export async function getContext(ctx: Ctx, a: { speech_id: string; mgr: number; window?: number }) {
  const s = await speechPage(ctx.sql, a.speech_id);
  if (!s) return { error: "speech_not_found", speech_id: a.speech_id };
  const w = Math.min(Math.max(a.window ?? 1, 0), 5);
  const picked = s.paragraphs.filter((p) => p.seq + 1 >= a.mgr - w && p.seq + 1 <= a.mgr + w);
  return {
    corpus: await corpusBlock(ctx.sql),
    speech_id: s.id, url: `${SITE}/raeda/${s.id}#mgr-${a.mgr}`, citation: citation(s, a.mgr - 1),
    member: { id: s.memberId, name: s.memberName, party_at_date: s.party }, started: s.started, speech_type: s.type,
    matter: s.matter ? { lthing: s.matter.lthing, class: s.matter.cls, nr: s.matter.nr, title: s.matter.title } : null,
    paragraphs: picked.map((p) => ({ mgr: p.seq + 1, text: p.text, interjections: p.interjections, is_target: p.seq + 1 === a.mgr })),
    derived: false,
  };
}

export async function getMatter(ctx: Ctx, a: { lthing: number; class?: string; nr: number }) {
  const cls = (a.class ?? "A").toUpperCase();
  const m = await matterPage(ctx.sql, a.lthing, cls, a.nr);
  if (!m) return { error: "matter_not_found", corpus: await corpusBlock(ctx.sql) };
  return {
    corpus: await corpusBlock(ctx.sql),
    matter: {
      lthing: m.lthing, class: m.cls, nr: m.nr, title: m.title, subtitle: m.subtitle, type: m.typeLabel, status: m.statusText,
      url: `${SITE}/mal/${m.lthing}/${m.cls.toLowerCase()}/${m.nr}`,
      detail_fetched: m.detailFetched,
      note: m.cls === "B" ? "B-mál: titill úr ræðuskrá, engin þingskjöl eða atkvæðagreiðslur." : undefined,
    },
    topics: m.topics, laws_amended: m.laws.map((l) => ({ year: l.year, nr: l.nr, url: `${SITE}/log/${l.year}/${l.nr}` })),
    related_matters: m.links.map((l) => ({ relation: l.kind, lthing: l.lthing, class: l.cls, nr: l.nr, title: l.title })),
    documents: m.documents.map((d) => ({ nr: d.nr, type: d.type, issued: d.issued, source_url: d.htmlUrl })),
    votes: m.votes.map((v) => ({ id: v.id, at: v.at, about: v.kind, method: v.method, result: v.result, yes: v.yes, no: v.no, abstain: v.abstain })),
    consultations: { requests: m.consultations.length, submissions_received: m.submissionCount },
    speeches: { total: m.speechCount, index: m.speeches.slice(0, 100).map((s) => ({ id: s.id, started: s.started, member: { id: s.memberId, name: s.memberName }, speech_type: s.type, debate: s.debate })) },
    derived: false,
  };
}

export async function getMember(ctx: Ctx, a: { member_id?: number; name?: string }) {
  let id = a.member_id;
  if (id === undefined && a.name) {
    const r = await ctx.sql<{ id: number; name: string }[]>`select id, name from members where name % ${a.name} order by similarity(name, ${a.name}) desc limit 5`;
    if (r.length !== 1 && !(r[0] && r[0].name.toLowerCase() === a.name.toLowerCase())) return { candidates: r, note: "Fleiri en einn þingmaður passar; notaðu member_id." };
    id = r[0]?.id;
  }
  const m = id === undefined ? null : await memberPage(ctx.sql, id);
  if (!m) return { error: "member_not_found", corpus: await corpusBlock(ctx.sql) };
  return {
    corpus: await corpusBlock(ctx.sql),
    member: { id: m.id, name: m.name, born: m.born, url: `${SITE}/thingmadur/${m.id}`, speeches_in_corpus: m.speechCount },
    seats: m.seats.map((s) => ({ lthing: s.lthing, kind: s.kind, party: s.party, constituency: s.constituency, from: s.from, to: s.to, sitting: s.kind !== "með varamann" })),
    seat_note: "'með varamann' = í leyfi, varamaður situr; flokkur á tilteknum degi er alltaf fundinn með þingsetu á þeim degi.",
    recent_speeches: m.recent.slice(0, 10).map((r) => ({ id: r.id, started: r.started, speech_type: r.type, matter_title: r.matterTitle })),
    derived: false,
  };
}

export async function listVotes(ctx: Ctx, a: { lthing: number; class?: string; nr?: number; date?: string; limit?: number }) {
  const cls = (a.class ?? "A").toUpperCase();
  const rows = await ctx.sql<{ id: number; nr: number; cls: string; at: string | null; kind_label: string; method: string | null; result: string | null; yes: number | null; no: number | null; abstain: number | null }[]>`
    select id, nr, cls, voted_at::text as at, kind_label, method, result, yes, no, abstain from votes
    where lthing = ${a.lthing}
      ${a.nr !== undefined ? ctx.sql`and cls = ${cls} and nr = ${a.nr}` : ctx.sql``}
      ${a.date ? ctx.sql`and voted_at::date = ${a.date}` : ctx.sql``}
    order by voted_at, id limit ${Math.min(a.limit ?? 50, 200)}`;
  return {
    corpus: await corpusBlock(ctx.sql),
    votes: rows.map((v) => ({ id: v.id, matter: { lthing: a.lthing, class: v.cls, nr: v.nr }, at: v.at, about: v.kind_label, method: v.method, result: v.result, yes: v.yes, no: v.no, abstain: v.abstain })),
    ballots_note: "Atkvæði einstakra þingmanna eru ekki enn í safninu; hér eru samtölur.",
    derived: false,
  };
}

export interface AggArgs {
  metric: "speeches" | "words"; group_by: "year" | "member" | "party" | "speech_type" | "lthing";
  q?: string; date_from?: string; date_to?: string; lthing?: number; speech_type?: string; member_id?: number; substantive_only?: boolean;
}

export async function aggregate(ctx: Ctx, a: AggArgs) {
  const { sql } = ctx;
  const parsed = a.q ? parseQuery(a.q) : null;
  const rq = parsed ? recallTsQuery(parsed) : null;
  const pq = parsed ? phraseTsQuery(parsed) : null;
  const key = {
    year: sql`extract(year from s.speech_date)::int::text`, member: sql`s.member_id::text || ': ' || s.member_name`,
    party: sql`coalesce(pt.name, '(óþekktur flokkur)')`, speech_type: sql`s.type`, lthing: sql`s.lthing::text`,
  }[a.group_by];
  const value = a.metric === "words" ? sql`coalesce(sum(s.word_count), 0)::int` : sql`count(*)::int`;
  const rows = await sql<{ key: string; n: number }[]>`
    select ${key} as key, ${value} as n
    from speeches s
    ${a.group_by === "party" ? sql`left join lateral (
        select p.name from seats st join parties p on p.id = st.party_id
        where st.member_id = s.member_id and st.kind in ('þingmaður', 'varamaður')
          and s.speech_date between coalesce(st.from_date, date '0001-01-01') and coalesce(st.to_date, date '9999-12-31')
        order by st.from_date desc nulls last limit 1) pt on true` : sql``}
    where s.text_state = 'done'
      ${a.date_from ? sql`and s.speech_date >= ${a.date_from}` : sql``}
      ${a.date_to ? sql`and s.speech_date <= ${a.date_to}` : sql``}
      ${a.lthing !== undefined ? sql`and s.lthing = ${a.lthing}` : sql``}
      ${a.speech_type ? sql`and s.type = ${a.speech_type}` : sql``}
      ${a.member_id !== undefined ? sql`and s.member_id = ${a.member_id}` : sql``}
      ${a.substantive_only ? sql`and s.type in ('ræða', 'flutningsræða', 'andsvar', 'svar') and coalesce(s.role_kind, '') <> 'forseti'` : sql``}
      ${rq || pq ? sql`and exists (select 1 from paragraphs p where p.speech_id = s.id
          ${rq ? sql`and p.search_vector @@ to_tsquery('simple', ${rq})` : sql``}
          ${pq ? sql`and p.seq_vector @@ to_tsquery('simple', ${pq})` : sql``})` : sql``}
    group by 1 order by ${a.group_by === "year" || a.group_by === "lthing" ? sql`1` : sql`2 desc, 1`} limit 50`;
  return {
    corpus: await corpusBlock(sql),
    metric: a.metric, group_by: a.group_by,
    query: a.q ? { text: a.q, interpreted_as: describe(parsed!), counts: "speeches with at least one matching paragraph" } : null,
    buckets: rows.map((r) => ({ key: r.key, value: r.n })),
    caveats: [
      "Tölur eiga við ræðutexta frá 2005 sem er kominn í safnið (sjá corpus).",
      ...(a.group_by === "party" ? ["Flokkur er fundinn með þingsetu á ræðudegi."] : []),
      ...(a.substantive_only ? [] : ["Telur allar ræðutegundir (líka andsvör og fundarstjórn); notaðu substantive_only til að sleppa fundarstjórn forseta."]),
    ],
    derived: false,
  };
}

export async function explainQuery(ctx: Ctx, a: { q: string }) {
  const p = parseQuery(a.q);
  return {
    query: a.q, interpreted_as: describe(p), parts: p.parts, dropped_stopwords: p.dropped, numbers: p.numbers,
    recall_tsquery: recallTsQuery(p), phrase_tsquery: phraseTsQuery(p),
    notes: [
      "Hvert orð er lemmað og leitað að öllum mögulegum lemmum; öll orð þurfa að koma fyrir í sömu málsgrein.",
      "Samsett orð sem eru í orðabók eru ekki klofin í fyrirspurn; ókunn samsett orð leita að heild eða öllum hlutum.",
      "Innan gæsalappa er leitað að nákvæmri röð (með smáorðum).",
    ],
    corpus: await corpusBlock(ctx.sql),
  };
}

export async function listSessions(ctx: Ctx) {
  const rows = await ctx.sql<{ lthing: number; period: string; starts: string | null; ends: string | null; done: number; pending: number; unavailable: number }[]>`
    select s.lthing, s.period, s.starts::text, s.ends::text,
           coalesce(c.done, 0)::int as done, coalesce(c.pending, 0)::int as pending, coalesce(c.unavailable, 0)::int as unavailable
    from sessions s left join (
      select lthing, count(*) filter (where text_state = 'done') done, count(*) filter (where text_state = 'pending') pending,
             count(*) filter (where text_state = 'unavailable') unavailable from speeches group by lthing) c using (lthing)
    where s.lthing >= 100 order by s.lthing desc`;
  return {
    corpus: await corpusBlock(ctx.sql),
    sessions: rows.map((r) => ({ lthing: r.lthing, period: r.period, starts: r.starts, ends: r.ends, speeches_with_text: r.done, speeches_pending: r.pending, speeches_index_only: r.unavailable, text_complete: r.done > 0 && r.pending === 0 })),
    derived: false,
  };
}

/** Earliest paragraphs matching a query, plus a per-year strip — answers "who said it first" within the corpus. */
export async function firstUse(ctx: Ctx, a: { q: string; limit?: number }) {
  const parsed = parseQuery(a.q);
  const rq = recallTsQuery(parsed), pq = phraseTsQuery(parsed);
  const sql = ctx.sql;
  if (!rq && !pq) return { error: "nothing_searchable", why: whyEmpty(a.q, parsed, false), corpus: await corpusBlock(sql) };
  const cond = sql`
    ${rq ? sql`and p.search_vector @@ to_tsquery('simple', ${rq})` : sql``}
    ${pq ? sql`and p.seq_vector @@ to_tsquery('simple', ${pq})` : sql``}`;
  const first = await sql<{ speech_id: string; seq: number; started: string; member_id: number; member_name: string; type: string; text: string; speech_date: string }[]>`
    select p.speech_id, p.seq, s.started::text, s.member_id, s.member_name, s.type, p.text, s.speech_date::text
    from paragraphs p join speeches s on s.id = p.speech_id where true ${cond} order by s.started, p.speech_id, p.seq limit ${Math.min(a.limit ?? 5, 20)}`;
  const years = await sql<{ y: number; n: number }[]>`
    select extract(year from s.speech_date)::int y, count(distinct s.id)::int n
    from paragraphs p join speeches s on s.id = p.speech_id where true ${cond} group by 1 order by 1`;
  const parties = await partiesFor(sql, first.map((f) => ({ speechId: f.speech_id, memberId: f.member_id, date: f.speech_date })));
  return {
    corpus: await corpusBlock(sql),
    query: { text: a.q, interpreted_as: describe(parsed) },
    earliest: first.map((f) => ({
      speech_id: f.speech_id, mgr: f.seq + 1, started: f.started, member: { id: f.member_id, name: f.member_name, party_at_date: parties.get(f.speech_id) ?? null },
      speech_type: f.type, text: clip(f.text), url: `${SITE}/raeda/${f.speech_id}#mgr-${f.seq + 1}`,
    })),
    speeches_per_year: years.map((y) => ({ year: y.y, speeches: y.n })),
    caveat: "„Fyrst“ á aðeins við ræðutexta í safninu (frá 2005; sjá corpus.text_dates fyrir þau tímabil sem eru komin inn); eldri ræður eru ekki leitarbærar.",
    derived: false,
  };
}

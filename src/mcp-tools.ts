import { documentPageUrl, lawPageUrl, matterPageUrl, memberPageUrl, speechPageUrl, votePageUrl } from "./althingi-urls.ts";
// MCP tool implementations as plain functions (testable without the protocol). Shapes follow docs/PERSONAS.md:
// small chainable payloads, ids + source URLs everywhere, a one-line `corpus` boundary wherever a count or an absence
// could be misread (the full object on list_sessions, first_use and zero-hit searches), derived/inferred flags,
// and a structured `why` when a search returns nothing.
import type { Sql } from "./db.ts";
import { parseQuery, describe } from "./explain.ts";
import { lawPage, matterPage, memberPage, partiesFor, speechPage } from "./queries.ts";
import { phraseTsQuery, recallTsQuery, search } from "./search.ts";
import { fmtTime, citation, SITE } from "./pages.tsx";
import { FINAL_CODES, RESULT_EN, finalVoteIndex, matterOutcomes, matterStatus, partyTallies, voteResult } from "./outcomes.ts";

export interface Ctx { sql: Sql; currentLthing: number }

const SNIPPET_MAX = 400;
const clip = (s: string, n = SNIPPET_MAX) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The text era: speech XML (and the bulk dump) starts with session 131, which opened on 2004-10-01. */
export const TEXT_ERA = { lthing: 131, en: "session 131 (October 2004)", is: "131. þingi (október 2004)" } as const;

export interface CorpusDetail {
  text_from: string; speeches_with_text: number; sessions_with_text: number[];
  text_dates: { from: string | null; to: string | null }; note: string;
}

/** "131–150, 157–158" from a sorted list of session numbers (the corpus need not be contiguous while it fills). */
export function sessionRanges(xs: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < xs.length; i++) {
    let j = i;
    while (j + 1 < xs.length && xs[j + 1] === xs[j]! + 1) j++;
    out.push(i === j ? `${xs[i]}` : `${xs[i]}–${xs[j]}`);
    i = j;
  }
  return out.join(", ");
}

// the corpus stats scan every speech row: computed at most once a minute per pool, not on every tool call
const CORPUS_TTL_MS = 60_000;
const corpusCache = new WeakMap<Sql, { at: number; p: Promise<CorpusDetail> }>();

/** The full boundary object: list_sessions, first_use and zero-hit searches (where absence could be misread). */
export function corpusDetail(sql: Sql): Promise<CorpusDetail> {
  const hit = corpusCache.get(sql);
  if (hit && Date.now() - hit.at < CORPUS_TTL_MS) return hit.p;
  const p = (async () => {
    const [r] = await sql<{ n: number; d0: string | null; d1: string | null; sessions: number[] }[]>`
      select count(*)::int n, min(speech_date)::text d0, max(speech_date)::text d1,
             coalesce(array_agg(distinct lthing order by lthing) filter (where lthing is not null), '{}') as sessions
      from speeches where text_state = 'done'`;
    return {
      text_from: TEXT_ERA.en,
      speeches_with_text: r?.n ?? 0,
      sessions_with_text: r?.sessions ?? [],
      text_dates: { from: r?.d0 ?? null, to: r?.d1 ?? null },
      note: `Ræðutexti er til frá ${TEXT_ERA.is}. Eldri ræður eru ekki leitarbærar. 'Fyrst', 'aldrei' og samtölur eiga við textana í safninu (sjá text_dates/sessions_with_text), ekki allan feril Alþingis.`,
    };
  })();
  p.catch(() => corpusCache.delete(sql));
  corpusCache.set(sql, { at: Date.now(), p });
  return p;
}

/** One line for every response where a count or an absence could be misread (replaces the ~500-byte object). */
export async function corpusBlock(sql: Sql): Promise<string> {
  const d = await corpusDetail(sql);
  if (!d.speeches_with_text) return `No speech text ingested yet; the text era starts at ${TEXT_ERA.en}.`;
  return `Speech text: sessions ${sessionRanges(d.sessions_with_text)} (${d.text_dates.from} to ${d.text_dates.to}, ${d.speeches_with_text} speeches); the text era starts at ${TEXT_ERA.en}, older speeches are not searchable. 'First', 'never' and totals hold only within this.`;
}

export interface SearchArgs {
  q: string; member_id?: number; party_id?: number; date_from?: string; date_to?: string; lthing?: number;
  speech_type?: string; office?: string; debate?: string[]; capacity?: string; matter?: string; sort?: "relevance" | "newest" | "oldest";
  limit?: number; cursor?: string;
}

function whyEmpty(q: string, parsed: ReturnType<typeof parseQuery>, filtered: boolean, range?: { from: string | null; to: string | null; dateFrom?: string; dateTo?: string }): string[] {
  const why: string[] = [];
  if (range?.dateFrom && range.to && range.dateFrom > range.to) why.push("date_range_after_last_speech_in_corpus");
  if (range?.dateTo && range.from && range.dateTo < range.from) why.push("date_range_before_first_speech_in_corpus");
  if (!q.trim()) why.push("empty_query");
  else if (parsed.empty) why.push("only_stopwords_or_numbers");
  if (parsed.numbers.length) why.push("numbers_must_be_within_8_tokens_of_a_query_word");
  if (filtered) why.push("filters_may_exclude_everything");
  why.push("text_corpus_starts_session_131_october_2004", "interjections_not_indexed", "all_query_words_must_match_in_the_same_paragraph");
  return why;
}

export async function searchSpeeches(ctx: Ctx, a: SearchArgs) {
  const { sql } = ctx;
  const m = a.matter?.match(/^([abAB])\/(\d{1,5})$/);
  const limit = Math.min(Math.max(a.limit ?? 10, 1), 100);
  const compact = limit > 25;
  const base = {
    q: a.q, memberId: a.member_id, partyId: a.party_id, dateFrom: a.date_from, dateTo: a.date_to, lthing: a.lthing,
    type: a.speech_type, office: a.office, debate: a.debate, capacity: a.capacity,
    matterCls: m ? m[1]!.toUpperCase() : undefined, matterNr: m ? Number(m[2]) : undefined,
    sort: a.sort, currentLthing: ctx.currentLthing,
  };
  // the engine pages 25 speeches at a time; a larger `limit` is served by following the cursor here
  const r = await search(sql, { ...base, limit: Math.min(limit, 25), cursor: a.cursor, withTotal: !a.cursor });
  while (r.hits.length < limit && r.nextCursor) {
    const more = await search(sql, { ...base, limit: Math.min(limit - r.hits.length, 25), cursor: r.nextCursor });
    r.hits.push(...more.hits);
    r.nextCursor = more.nextCursor;
  }
  const parties = await partiesFor(sql, r.hits.map((h) => ({ speechId: h.speechId, memberId: h.memberId, date: h.date })));
  const filtered = Boolean(a.member_id || a.party_id || a.date_from || a.date_to || a.lthing || a.speech_type || a.office || a.debate || a.capacity || a.matter);
  const [corpus, detail] = await Promise.all([corpusBlock(sql), corpusDetail(sql)]);
  return {
    corpus,
    ...(r.hits.length === 0 ? { corpus_detail: detail } : {}),
    query: { text: a.q, interpreted_as: r.query.description, dropped_stopwords: r.query.parsed.dropped, numbers: r.query.parsed.numbers },
    ...(r.total !== undefined ? { total: r.totalCapped ? `${r.total}+` : r.total, total_counts: "speeches with at least one matching paragraph, all pages" } : {}),
    hits: r.hits.map((h) => ({
      speech_id: h.speechId, date: h.date, started: h.started, time: fmtTime(h.started),
      member: { id: h.memberId, name: h.memberName, party_at_date: parties.get(h.speechId) ?? null },
      speech_type: h.speechType, debate: h.debate, provisional: h.provisional,
      matter: h.matter ? { lthing: h.matter.lthing, class: h.matter.cls, nr: h.matter.nr, title: h.matter.title, url: `${SITE}/mal/${h.matter.lthing}/${h.matter.cls.toLowerCase()}/${h.matter.nr}`, althingi_url: matterPageUrl(h.matter.lthing, h.matter.cls, h.matter.nr) } : null,
      score: Math.round(h.score * 1000) / 1000, matching_paragraphs: h.matchingParagraphs,
      paragraphs: h.paragraphs.slice(0, compact ? 1 : 2).map((p) => ({
        mgr: p.seq + 1, text: clip(p.snippets[0]?.text ?? "", compact ? 200 : SNIPPET_MAX), url: `${SITE}/raeda/${h.speechId}#mgr-${p.seq + 1}`,
      })),
      url: `${SITE}/raeda/${h.speechId}`, althingi_url: h.althingiUrl,
    })),
    matter_cards: r.matterCards.map((c) => ({ lthing: c.lthing, class: c.cls, nr: c.nr, title: c.title, url: `${SITE}/mal/${c.lthing}/${c.cls.toLowerCase()}/${c.nr}`, althingi_url: c.althingiUrl })),
    next_cursor: r.nextCursor,
    ...(r.hits.length === 0 ? { why: whyEmpty(a.q, r.query.parsed, filtered, { from: detail.text_dates.from, to: detail.text_dates.to, dateFrom: a.date_from, dateTo: a.date_to }) } : {}),
    derived: false,
  };
}

export async function getSpeech(ctx: Ctx, a: { speech_id: string; from?: number; to?: number }) {
  const s = await speechPage(ctx.sql, a.speech_id);
  if (!s) return { error: "speech_not_found", hint: "Speech ids look like rad20180306T163325 and come from search_speeches, get_matter or get_member.", speech_id: a.speech_id, corpus: await corpusBlock(ctx.sql) };
  const [rev] = await ctx.sql<{ raw_sha256: string | null; fetched_at: Date | null; lemma_is_version: string | null }[]>`
    select raw_sha256, fetched_at, lemma_is_version from speeches where id = ${a.speech_id}`;
  const [link] = await ctx.sql<{ reply_to_id: string | null; reply_to_inferred: boolean }[]>`select reply_to_id, reply_to_inferred from speeches where id = ${a.speech_id}`;
  const replies = await ctx.sql<{ id: string; member_name: string | null; type: string; inferred: boolean }[]>`
    select id, member_name, type, reply_to_inferred as inferred from speeches where reply_to_id = ${a.speech_id} order by started limit 50`;
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
    speech: {
      id: s.id, url: `${SITE}/raeda/${s.id}`, althingi_url: s.althingiUrl, date: s.date, started: s.started, ended: s.ended, speech_type: s.type, debate: s.debate,
      member: { id: s.memberId, name: s.memberName, party_at_date: s.party, althingi_url: s.memberId === null ? null : memberPageUrl(s.memberId) }, office: s.office, capacity: s.capacity,
      matter: s.matter ? { lthing: s.matter.lthing, class: s.matter.cls, nr: s.matter.nr, title: s.matter.title, althingi_url: matterPageUrl(s.matter.lthing, s.matter.cls, s.matter.nr) } : null,
      audio_url: s.audioUrl, video_url: s.vodUrl, word_count: s.wordCount,
      provisional: s.provisional, // true: Alþingi's provisional text (bráðabirgðatexti); replaced when the final arrives
      text_source: s.textSource,
      prev_in_matter: s.prevId, next_in_matter: s.nextId, // same matter, by time: strong link
      reply_to: link?.reply_to_id ? { speech_id: link.reply_to_id, url: `${SITE}/raeda/${link.reply_to_id}`, inferred: link.reply_to_inferred } : null,
      replies: replies.map((r) => ({ speech_id: r.id, member_name: r.member_name, speech_type: r.type, url: `${SITE}/raeda/${r.id}`, inferred: r.inferred })),
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
  if (!s) return { error: "speech_not_found", hint: "Speech ids look like rad20180306T163325 and come from search_speeches, get_matter or get_member.", speech_id: a.speech_id, corpus: await corpusBlock(ctx.sql) };
  const w = Math.min(Math.max(a.window ?? 1, 0), 5);
  const picked = s.paragraphs.filter((p) => p.seq + 1 >= a.mgr - w && p.seq + 1 <= a.mgr + w);
  return {
    speech_id: s.id, url: `${SITE}/raeda/${s.id}#mgr-${a.mgr}`, althingi_url: s.althingiUrl, citation: citation(s, a.mgr - 1),
    member: { id: s.memberId, name: s.memberName, party_at_date: s.party }, started: s.started, speech_type: s.type,
    matter: s.matter ? { lthing: s.matter.lthing, class: s.matter.cls, nr: s.matter.nr, title: s.matter.title } : null,
    paragraphs: picked.map((p) => ({ mgr: p.seq + 1, text: p.text, interjections: p.interjections, is_target: p.seq + 1 === a.mgr })),
    derived: false,
  };
}

export async function getMatter(ctx: Ctx, a: { lthing: number; class?: string; nr: number }) {
  const cls = (a.class ?? "A").toUpperCase();
  const m = await matterPage(ctx.sql, a.lthing, cls, a.nr);
  if (!m) return { error: "matter_not_found", hint: "Check lthing (session number, see list_sessions), class (A = bills/resolutions, B = other business) and nr.", corpus: await corpusBlock(ctx.sql) };
  const [sponsors, rapporteurs, events] = await Promise.all([
    ctx.sql<{ seq: number; abbr: string | null; member_id: number | null; name: string | null; office: string | null }[]>`
      select s.seq, s.abbr, s.member_id, mb.name, nullif(s.office, '') as office from matter_sponsors s left join members mb on mb.id = s.member_id
      where s.lthing = ${m.lthing} and s.cls = ${m.cls} and s.nr = ${m.nr} order by s.seq`,
    ctx.sql<{ member_id: number; name: string }[]>`select member_id, name from matter_rapporteurs where lthing = ${m.lthing} and cls = ${m.cls} and nr = ${m.nr} order by name`,
    ctx.sql<{ at: string; kind: string; fundur: number }[]>`select at::text, kind, fundur from sitting_events where lthing = ${m.lthing} and cls = ${m.cls} and nr = ${m.nr} order by at`,
  ]);
  // vote type and method codes (not on MatterPage): derive missing results and mark the final vote (src/outcomes.ts)
  const codes = new Map((await ctx.sql<{ id: number; code: string | null; method_code: string | null }[]>`
    select id, coalesce(kind_code2, kind_code) as code, method_code from votes where lthing = ${m.lthing} and cls = ${m.cls} and nr = ${m.nr}`).map((r) => [r.id, r]));
  const votes = m.votes.map((v) => ({ ...v, code: codes.get(v.id)?.code ?? null, ...voteResult({ ...v, method_code: codes.get(v.id)?.method_code ?? null }) }));
  const fi = finalVoteIndex(votes);
  const finalTally = fi >= 0 ? (await partyTallies(ctx.sql, [votes[fi]!.id])).get(votes[fi]!.id) ?? [] : [];
  const st = matterStatus(m.statusText, events.some((e) => e.kind === "frvAfgreittSemLög"), fi >= 0 ? votes[fi]! : null);
  return {
    corpus: await corpusBlock(ctx.sql),
    matter: {
      lthing: m.lthing, class: m.cls, nr: m.nr, title: m.title, subtitle: m.subtitle || null, type: m.typeLabel,
      status: st.status, status_source: st.status_source, // althingi | sitting_event | final_vote (derived) | null
      url: `${SITE}/mal/${m.lthing}/${m.cls.toLowerCase()}/${m.nr}`, althingi_url: m.althingiUrl,
      detail_fetched: m.detailFetched,
      note: m.cls === "B" ? "B-mál: titill úr ræðuskrá, engin þingskjöl eða atkvæðagreiðslur." : undefined,
    },
    sponsors: sponsors.map((x) => ({ order: x.seq, member: x.member_id === null ? null : { id: x.member_id, name: x.name, url: `${SITE}/thingmadur/${x.member_id}` }, abbr: x.abbr, office: x.office })),
    sponsors_note: "Flutningsmenn: the first is the lead sponsor (fyrsti flutningsmaður); a minister sponsors government bills (office set).",
    rapporteurs: rapporteurs.map((r) => ({ id: r.member_id, name: r.name })),
    sitting_events: events.map((e) => ({ at: e.at, kind: e.kind, fundur: e.fundur })),
    topics: m.topics, laws_amended: m.laws.map((l) => ({ year: l.year, nr: l.nr, url: `${SITE}/log/${l.year}/${l.nr}`, althingi_url: lawPageUrl(l.year, l.nr) })),
    related_matters: m.links.map((l) => ({ relation: l.kind, lthing: l.lthing, class: l.cls, nr: l.nr, title: l.title })),
    documents: m.documents.map((d) => ({ nr: d.nr, type: d.type, issued: d.issued, source_url: d.htmlUrl, althingi_url: d.althingiUrl })),
    votes: votes.map((v, i) => ({
      id: v.id, at: v.at, about: v.kind, type_code: v.code, method: v.method, result: v.result, result_en: v.result ? RESULT_EN[v.result] ?? null : null,
      ...(v.result_derived ? { result_derived: true } : {}), yes: v.yes, no: v.no, abstain: v.abstain, is_final: i === fi,
      ...(i === fi ? { by_party: finalTally } : {}), althingi_url: v.althingiUrl,
    })),
    final_vote_id: fi >= 0 ? votes[fi]!.id : null,
    votes_note: `is_final marks the last vote on the bill or resolution as a whole (type_code ${[...FINAL_CODES].join(" or ")}); by_party (party on the vote date) is inlined on it, get_vote(id) has every ballot. result_derived = filled from the counts or the method because Alþingi left it empty.`,
    consultations: { requests: m.consultations.length, submissions_received: m.submissionCount },
    speeches: { total: m.speechCount, index: m.speeches.slice(0, 100).map((s) => ({ id: s.id, started: s.started, member: { id: s.memberId, name: s.memberName }, speech_type: s.type, debate: s.debate, althingi_url: speechPageUrl(m.lthing, s.id) })) },
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
  if (!m) return { error: "member_not_found", hint: "Try get_member with a name (fuzzy), or check the id.", corpus: await corpusBlock(ctx.sql) };
  return {
    corpus: await corpusBlock(ctx.sql),
    member: { id: m.id, name: m.name, born: m.born, url: `${SITE}/thingmadur/${m.id}`, althingi_url: m.althingiUrl, speeches_in_corpus: m.speechCount },
    seats: m.seats.map((s) => ({ lthing: s.lthing, kind: s.kind, party: s.party, constituency: s.constituency, from: s.from, to: s.to, sitting: s.kind !== "með varamann" })),
    seat_note: "'með varamann' = í leyfi, varamaður situr; flokkur á tilteknum degi er alltaf fundinn með þingsetu á þeim degi.",
    recent_speeches: m.recent.slice(0, 10).map((r) => ({ id: r.id, started: r.started, speech_type: r.type, matter_title: r.matterTitle, althingi_url: speechPageUrl(r.lthing, r.id) })),
    derived: false,
  };
}

export async function listVotes(ctx: Ctx, a: { lthing: number; class?: string; nr?: number; date?: string; doc_nr?: number; after_id?: number; limit?: number }) {
  const cls = (a.class ?? "A").toUpperCase();
  const rows = await ctx.sql<{ id: number; nr: number; cls: string; at: string | null; kind_label: string; method: string | null; method_code: string | null; result: string | null; yes: number | null; no: number | null; abstain: number | null; doc_nr: number | null; html_url: string | null }[]>`
    select id, nr, cls, voted_at::text as at, kind_label, method, method_code, result, yes, no, abstain, doc_nr, html_url from votes
    where lthing = ${a.lthing}
      ${a.nr !== undefined ? ctx.sql`and cls = ${cls} and nr = ${a.nr}` : ctx.sql``}
      ${a.date ? ctx.sql`and voted_at::date = ${a.date}` : ctx.sql``}
      ${a.doc_nr !== undefined ? ctx.sql`and doc_nr = ${a.doc_nr}` : ctx.sql``}
      ${a.after_id !== undefined ? ctx.sql`and id > ${a.after_id}` : ctx.sql``}
    order by id limit ${Math.min(a.limit ?? 50, 200)}`;
  return {
    votes: rows.map((v) => ({
      id: v.id, althingi_url: votePageUrl(v.id, v.html_url),
      matter: { lthing: a.lthing, class: v.cls, nr: v.nr, althingi_url: matterPageUrl(a.lthing, v.cls, v.nr) },
      document_nr: v.doc_nr, document_althingi_url: v.doc_nr === null ? null : documentPageUrl(a.lthing, v.doc_nr),
      at: v.at, about: v.kind_label, method: v.method, ...resultFields(v), yes: v.yes, no: v.no, abstain: v.abstain })),
    next_after_id: rows.length === Math.min(a.limit ?? 50, 200) ? rows[rows.length - 1]!.id : null,
    ballots_note: "Counts only here; call get_vote(vote_id) for each member's ballot, or member_votes for one member's record. althingi_url has the official page.",
    derived: false,
  };
}

export interface AggArgs {
  metric: "speeches" | "words"; group_by: "year" | "member" | "party" | "speech_type" | "lthing" | "matter";
  q?: string; date_from?: string; date_to?: string; lthing?: number; speech_type?: string; member_id?: number; substantive_only?: boolean;
}

/** The speech filters shared by aggregate and topic_timeline; with a query, speeches with at least one matching paragraph. */
function speechWhere(sql: Sql, a: Omit<AggArgs, "metric" | "group_by">, parsed: ReturnType<typeof parseQuery> | null) {
  const rq = parsed ? recallTsQuery(parsed) : null;
  const pq = parsed ? phraseTsQuery(parsed) : null;
  return sql`s.text_state = 'done'
      ${a.date_from ? sql`and s.speech_date >= ${a.date_from}` : sql``}
      ${a.date_to ? sql`and s.speech_date <= ${a.date_to}` : sql``}
      ${a.lthing !== undefined ? sql`and s.lthing = ${a.lthing}` : sql``}
      ${a.speech_type ? sql`and s.type = ${a.speech_type}` : sql``}
      ${a.member_id !== undefined ? sql`and s.member_id = ${a.member_id}` : sql``}
      ${a.substantive_only ? sql`and s.type in ('ræða', 'flutningsræða', 'andsvar', 'svar') and coalesce(s.role_kind, '') <> 'forseti'` : sql``}
      ${rq || pq ? sql`and exists (select 1 from paragraphs p where p.speech_id = s.id
          ${rq ? sql`and p.search_vector @@ to_tsquery('simple', ${rq})` : sql``}
          ${pq ? sql`and p.seq_vector @@ to_tsquery('simple', ${pq})` : sql``})` : sql``}`;
}

const matterKey = (l: number, c: string, n: number) => `${l}/${c}/${n}`;

export async function aggregate(ctx: Ctx, a: AggArgs) {
  const { sql } = ctx;
  const parsed = a.q ? parseQuery(a.q) : null;
  // key = the grouping value as a string; member/party/matter buckets also carry their ids, name/title and a url
  const sel = {
    year: sql`extract(year from s.speech_date)::int::text as key, null::int as id, null::text as name, null::text as cls, null::int as nr`,
    member: sql`coalesce(s.member_id::text, s.speaker_abbr, '?') as key, s.member_id as id, min(coalesce(s.member_name, s.speaker_abbr)) as name, null::text as cls, null::int as nr`,
    party: sql`coalesce(pt.id::text, '?') as key, pt.id, coalesce(pt.name, '(óþekktur flokkur)') as name, null::text as cls, null::int as nr`,
    speech_type: sql`s.type as key, null::int as id, null::text as name, null::text as cls, null::int as nr`,
    lthing: sql`s.lthing::text as key, s.lthing as id, null::text as name, null::text as cls, null::int as nr`,
    matter: sql`coalesce(s.lthing || '/' || s.matter_cls || '/' || s.matter_nr, '(ekkert mál)') as key, s.lthing as id, min(m.title) as name, s.matter_cls as cls, s.matter_nr as nr`,
  }[a.group_by];
  const group = {
    year: sql`1`, member: sql`1, 2`, party: sql`1, 2, 3`, speech_type: sql`1`, lthing: sql`1, 2`, matter: sql`1, 2, 4, 5`,
  }[a.group_by];
  const value = a.metric === "words" ? sql`coalesce(sum(s.word_count), 0)::int` : sql`count(*)::int`;
  const rows = await sql<{ key: string; id: number | null; name: string | null; cls: string | null; nr: number | null; n: number }[]>`
    select ${sel}, ${value} as n
    from speeches s
    ${a.group_by === "party" ? sql`left join lateral (
        select p.id, p.name from seats st join parties p on p.id = st.party_id
        where st.member_id = s.member_id and st.kind in ('þingmaður', 'varamaður')
          and s.speech_date between coalesce(st.from_date, date '0001-01-01') and coalesce(st.to_date, date '9999-12-31')
        order by st.from_date desc nulls last limit 1) pt on true` : sql``}
    ${a.group_by === "matter" ? sql`left join matters m on (m.lthing, m.cls, m.nr) = (s.lthing, s.matter_cls, s.matter_nr)` : sql``}
    where ${speechWhere(sql, a, parsed)}
    group by ${group} order by ${a.group_by === "year" || a.group_by === "lthing" ? sql`1` : sql`n desc, 1`} limit 50`;
  const bucket = (r: (typeof rows)[number]) => {
    const b = { key: r.key, value: r.n };
    if (a.group_by === "member") return { ...b, id: r.id, name: r.name, url: r.id === null ? null : site.member(r.id) };
    if (a.group_by === "party") return { ...b, id: r.id, name: r.name, url: r.id === null ? null : `${SITE}/flokkur/${r.id}` };
    if (a.group_by === "matter") return r.cls && r.nr !== null
      ? { ...b, matter: { lthing: r.id!, class: r.cls, nr: r.nr, title: r.name, url: site.matter(r.id!, r.cls, r.nr) } }
      : { ...b, matter: null };
    return b;
  };
  return {
    corpus: await corpusBlock(sql),
    metric: a.metric, group_by: a.group_by,
    query: a.q ? { text: a.q, interpreted_as: describe(parsed!), counts: "speeches with at least one matching paragraph" } : null,
    buckets: rows.map(bucket),
    caveats: [
      `Tölur eiga við ræðutexta frá ${TEXT_ERA.is} sem er kominn í safnið (sjá corpus).`,
      ...(a.group_by === "party" ? ["Flokkur er fundinn með þingsetu á ræðudegi."] : []),
      ...(a.group_by === "matter" ? ["Mál = þingmálið sem ræðan var flutt undir; get_matter(lthing, class, nr) gefur afdrif þess, topic_timeline tekur saman eftir árum."] : []),
      ...(a.substantive_only ? [] : ["Telur allar ræðutegundir (líka andsvör og fundarstjórn); notaðu substantive_only til að sleppa fundarstjórn forseta."]),
    ],
    derived: false,
  };
}

/**
 * How a topic moved through parliament: per year, the speeches matching `q` and the matters most of them were given
 * under, with each matter's status and final vote (per-party tally). One scan for the counts, then three queries for
 * the outcomes of at most years × top_matters matters (src/outcomes.ts).
 */
export async function topicTimeline(ctx: Ctx, a: { q: string; date_from?: string; date_to?: string; lthing?: number; member_id?: number; top_matters?: number }) {
  const { sql } = ctx;
  const parsed = parseQuery(a.q);
  if (!recallTsQuery(parsed) && !phraseTsQuery(parsed)) return { error: "nothing_searchable", hint: "q needs at least one Icelandic content word (stopwords and bare numbers are dropped); check it with explain_query.", why: whyEmpty(a.q, parsed, false), corpus: await corpusBlock(sql) };
  const top = Math.min(Math.max(a.top_matters ?? 3, 1), 5);
  const rows = await sql<{ y: number; total: number; lthing: number | null; cls: string | null; nr: number | null; n: number | null; title: string | null; type_label: string | null }[]>`
    with hits as (
      select extract(year from s.speech_date)::int as y, s.lthing, s.matter_cls as cls, s.matter_nr as nr, count(*)::int as n
      from speeches s where ${speechWhere(sql, a, parsed)}
      group by 1, 2, 3, 4
    ), years as (select y, sum(n)::int as total from hits group by y),
    ranked as (select *, row_number() over (partition by y order by n desc, lthing, nr) as rk from hits where cls is not null and nr is not null)
    select yr.y, yr.total, r.lthing, r.cls, r.nr, r.n, m.title, m.type_label
    from years yr left join ranked r on r.y = yr.y and r.rk <= ${top}
    left join matters m on (m.lthing, m.cls, m.nr) = (r.lthing, r.cls, r.nr)
    order by yr.y, r.n desc nulls last, r.lthing, r.nr`;
  const keys = new Map<string, { lthing: number; cls: string; nr: number; title: string | null; type: string | null }>();
  for (const r of rows) if (r.lthing !== null && r.cls && r.nr !== null) keys.set(matterKey(r.lthing, r.cls, r.nr), { lthing: r.lthing, cls: r.cls, nr: r.nr, title: r.title, type: r.type_label });
  const outcomes = await matterOutcomes(sql, [...keys.values()]);
  const years = new Map<number, { year: number; speeches: number; top_matters: { matter: string; title: string | null; speeches: number }[] }>();
  for (const r of rows) {
    const y = years.get(r.y) ?? { year: r.y, speeches: r.total, top_matters: [] };
    if (r.lthing !== null && r.cls && r.nr !== null) y.top_matters.push({ matter: matterKey(r.lthing, r.cls, r.nr), title: r.title, speeches: r.n ?? 0 });
    years.set(r.y, y);
  }
  return {
    corpus: await corpusBlock(sql),
    query: { text: a.q, interpreted_as: describe(parsed), counts: "speeches with at least one matching paragraph" },
    years: [...years.values()],
    matters: [...keys].map(([k, m]) => {
      const o = outcomes.get(k);
      const f = o?.final_vote ?? null;
      return {
        key: k, lthing: m.lthing, class: m.cls, nr: m.nr, title: m.title, type: m.type, url: site.matter(m.lthing, m.cls, m.nr),
        status: o?.status ?? null, status_source: o?.status_source ?? null,
        // compact: get_matter / get_vote(final_vote.id) have the labels, the method and every ballot
        final_vote: f ? { id: f.id, at: f.at, result: f.result, ...(f.result_derived ? { result_derived: true } : {}), yes: f.yes, no: f.no, abstain: f.abstain, by_party: f.by_party } : null,
      };
    }),
    note: `Per year: speeches matching q and the ${top} matters (þingmál) most of them were given under; a session spans two calendar years, so one matter can appear in both. matters[] has each one's status (status_source: althingi, or derived from a sitting event / the final vote) and final vote (the last vote on the bill or resolution as a whole) with a per-party tally. For the debate itself: search_speeches(q, lthing, matter='a/<nr>'); for every ballot: get_vote(final_vote.id).`,
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
    corpus: await corpusBlock(ctx.sql), corpus_detail: await corpusDetail(ctx.sql),
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
  const first = await sql<{ speech_id: string; seq: number; started: string; member_id: number; member_name: string; type: string; text: string; speech_date: string; lthing: number; html_url: string | null }[]>`
    select p.speech_id, p.seq, s.started::text, s.member_id, s.member_name, s.type, p.text, s.speech_date::text, s.lthing, s.html_url
    from paragraphs p join speeches s on s.id = p.speech_id where true ${cond} order by s.started, p.speech_id, p.seq limit ${Math.min(a.limit ?? 5, 20)}`;
  const years = await sql<{ y: number; n: number }[]>`
    select extract(year from s.speech_date)::int y, count(distinct s.id)::int n
    from paragraphs p join speeches s on s.id = p.speech_id where true ${cond} group by 1 order by 1`;
  const parties = await partiesFor(sql, first.map((f) => ({ speechId: f.speech_id, memberId: f.member_id, date: f.speech_date })));
  return {
    corpus: await corpusBlock(sql), corpus_detail: await corpusDetail(sql),
    query: { text: a.q, interpreted_as: describe(parsed) },
    earliest: first.map((f) => ({
      speech_id: f.speech_id, mgr: f.seq + 1, started: f.started, member: { id: f.member_id, name: f.member_name, party_at_date: parties.get(f.speech_id) ?? null },
      speech_type: f.type, text: clip(f.text), url: `${SITE}/raeda/${f.speech_id}#mgr-${f.seq + 1}`, althingi_url: speechPageUrl(f.lthing, f.speech_id, f.html_url),
    })),
    speeches_per_year: years.map((y) => ({ year: y.y, speeches: y.n })),
    caveat: `„Fyrst“ á aðeins við ræðutexta í safninu (frá ${TEXT_ERA.is}; sjá corpus_detail.text_dates fyrir þau tímabil sem eru komin inn); eldri ræður eru ekki leitarbærar.`,
    derived: false,
  };
}

// ---------------------------------------------------------------- votes per member (ballots), laws, sittings

/** result (derived when Alþingi left it empty, flagged), result_en: the same on every tool that shows a vote. */
const resultFields = (v: { method: string | null; method_code: string | null; result: string | null; yes: number | null; no: number | null; abstain: number | null }) => {
  const r = voteResult(v);
  return { result: r.result, result_en: r.result ? RESULT_EN[r.result] ?? null : null, ...(r.result_derived ? { result_derived: true } : {}) };
};

const CHOICE_EN: Record<string, string> = {
  "já": "yes", nei: "no", "greiðir ekki atkvæði": "abstains (present, not voting)", "boðaði fjarvist": "reported absence", fjarverandi: "absent",
};
const site = {
  matter: (l: number, c: string, n: number) => `${SITE}/mal/${l}/${c.toLowerCase()}/${n}`,
  member: (id: number) => `${SITE}/thingmadur/${id}`,
  law: (y: number, n: number) => `${SITE}/log/${y}/${n}`,
};

/** One vote with every member's ballot (verbatim Icelandic choice + English gloss) and party on the vote date. */
export async function getVote(ctx: Ctx, a: { vote_id: number }) {
  const { sql } = ctx;
  const [v] = await sql<{ id: number; lthing: number; cls: string; nr: number; at: string | null; d: string | null; kind_label: string; method: string | null; method_code: string | null; result: string | null; yes: number | null; no: number | null; abstain: number | null; doc_nr: number | null; html_url: string | null; title: string | null }[]>`
    select v.id, v.lthing, v.cls, v.nr, v.voted_at::text as at, v.voted_at::date::text as d, v.kind_label, v.method, v.method_code, v.result, v.yes, v.no, v.abstain, v.doc_nr, v.html_url, m.title
    from votes v left join matters m on (m.lthing, m.cls, m.nr) = (v.lthing, v.cls, v.nr) where v.id = ${a.vote_id}`;
  if (!v) return { error: "vote_not_found", hint: "Vote ids come from get_matter.votes[].id, list_votes or member_votes.", vote_id: a.vote_id };
  const ballots = await sql<{ member_id: number; name: string | null; choice: string; party: string | null }[]>`
    select b.member_id, m.name, b.choice, (
      select p.name from seats st join parties p on p.id = st.party_id
      where st.member_id = b.member_id and st.kind in ('þingmaður', 'varamaður')
        and coalesce(${v.d}::date, current_date) between coalesce(st.from_date, date '0001-01-01') and coalesce(st.to_date, date '9999-12-31')
      order by st.from_date desc nulls last limit 1) as party
    from ballots b left join members m on m.id = b.member_id where b.vote_id = ${a.vote_id} order by b.choice, m.name`;
  const [un] = await sql<{ n: number }[]>`select count(*)::int n from ballots_unresolved where vote_id = ${a.vote_id}`;
  const byParty = new Map<string, Record<string, number>>();
  for (const b of ballots) {
    const k = b.party ?? "(óþekktur flokkur)";
    const r = byParty.get(k) ?? {};
    r[b.choice] = (r[b.choice] ?? 0) + 1;
    byParty.set(k, r);
  }
  return {
    vote: {
      id: v.id, at: v.at, about: v.kind_label, method: v.method, ...resultFields(v), yes: v.yes, no: v.no, abstain: v.abstain,
      matter: { lthing: v.lthing, class: v.cls, nr: v.nr, title: v.title, url: site.matter(v.lthing, v.cls, v.nr), althingi_url: matterPageUrl(v.lthing, v.cls, v.nr) },
      document_nr: v.doc_nr, document_althingi_url: v.doc_nr === null ? null : documentPageUrl(v.lthing, v.doc_nr),
      url: `${site.matter(v.lthing, v.cls, v.nr)}#atkvaedi`, althingi_url: votePageUrl(v.id, v.html_url),
    },
    ballots: ballots.map((b) => ({ member: { id: b.member_id, name: b.name, party_at_date: b.party, url: site.member(b.member_id) }, choice: b.choice, choice_en: CHOICE_EN[b.choice] ?? null })),
    by_party: [...byParty].map(([party, counts]) => ({ party, counts })),
    ballots_total: ballots.length, ballots_unresolved: un?.n ?? 0,
    note: ballots.length === 0
      ? "No per-member ballots for this vote: voice votes / presiding officer declarations have none, and very recent votes may not be ingested yet."
      : "Choices are verbatim from Alþingi: já, nei, greiðir ekki atkvæði (present, abstains), boðaði fjarvist, fjarverandi.",
    derived: false,
  };
}

/** How one member voted: ballots newest first, filterable by session, matter or choice. */
export async function memberVotes(ctx: Ctx, a: { member_id: number; lthing?: number; class?: string; nr?: number; choice?: string; before_id?: number; limit?: number }) {
  const { sql } = ctx;
  const lim = Math.min(Math.max(a.limit ?? 50, 1), 200);
  const cls = (a.class ?? "A").toUpperCase();
  const [m] = await sql<{ name: string }[]>`select name from members where id = ${a.member_id}`;
  if (!m) return { error: "member_not_found", hint: "Resolve the member with get_member (by name) first.", member_id: a.member_id };
  const rows = await sql<{ id: number; lthing: number; cls: string; nr: number; at: string | null; kind_label: string; method: string | null; method_code: string | null; result: string | null; yes: number | null; no: number | null; abstain: number | null; choice: string; title: string | null; html_url: string | null }[]>`
    select v.id, v.lthing, v.cls, v.nr, v.voted_at::text as at, v.kind_label, v.method, v.method_code, v.result, v.yes, v.no, v.abstain, b.choice, mt.title, v.html_url
    from ballots b join votes v on v.id = b.vote_id left join matters mt on (mt.lthing, mt.cls, mt.nr) = (v.lthing, v.cls, v.nr)
    where b.member_id = ${a.member_id}
      ${a.lthing !== undefined ? sql`and v.lthing = ${a.lthing}` : sql``}
      ${a.nr !== undefined ? sql`and v.cls = ${cls} and v.nr = ${a.nr}` : sql``}
      ${a.choice ? sql`and b.choice = ${a.choice}` : sql``}
      ${a.before_id !== undefined ? sql`and v.id < ${a.before_id}` : sql``}
    order by v.id desc limit ${lim}`;
  const tally = await sql<{ choice: string; n: number }[]>`
    select b.choice, count(*)::int n from ballots b join votes v on v.id = b.vote_id where b.member_id = ${a.member_id}
      ${a.lthing !== undefined ? sql`and v.lthing = ${a.lthing}` : sql``}
      ${a.nr !== undefined ? sql`and v.cls = ${cls} and v.nr = ${a.nr}` : sql``}
    group by 1 order by 2 desc`;
  return {
    member: { id: a.member_id, name: m.name, url: site.member(a.member_id), althingi_url: memberPageUrl(a.member_id) },
    tally: tally.map((t) => ({ choice: t.choice, choice_en: CHOICE_EN[t.choice] ?? null, n: t.n })),
    votes: rows.map((r) => ({
      vote_id: r.id, at: r.at, about: r.kind_label, ...resultFields(r), yes: r.yes, no: r.no, abstain: r.abstain,
      choice: r.choice, choice_en: CHOICE_EN[r.choice] ?? null,
      matter: { lthing: r.lthing, class: r.cls, nr: r.nr, title: r.title, url: site.matter(r.lthing, r.cls, r.nr) },
      althingi_url: votePageUrl(r.id, r.html_url),
    })),
    next_before_id: rows.length === lim ? rows[rows.length - 1]!.id : null,
    note: "Per-member ballots exist only for recorded (electronic or roll-call) votes in ingested sessions; see list_sessions.",
    derived: false,
  };
}

/** A law in the current law collection (lagasafn): metadata, amendment history, matters, and article text on request. */
export async function getLaw(ctx: Ctx, a: { year?: number; nr?: number; title?: string; article?: string; include_text?: boolean }) {
  const { sql } = ctx;
  let year = a.year, nr = a.nr;
  if ((year === undefined || nr === undefined) && a.title) {
    const r = await sql<{ year: number; nr: number; title: string }[]>`
      select year, nr, title from laws_current where title % ${a.title} or title ilike ${"%" + a.title + "%"}
      order by similarity(title, ${a.title}) desc limit 8`;
    if (r.length !== 1) return { candidates: r.map((x) => ({ ...x, url: site.law(x.year, x.nr) })), note: r.length ? "Several laws match; call again with year and nr." : "No law title matches; try fewer words." };
    year = r[0]!.year; nr = r[0]!.nr;
  }
  if (year === undefined || nr === undefined) return { error: "law_not_specified", hint: "Pass year and nr (lög nr. 34/1991 = year 1991, nr 34) or a title." };
  const l = await lawPage(sql, year, nr);
  const arts = l.law ? await sql<{ article_id: string; heading: string | null; text: string }[]>`
    select article_id, heading, text from law_articles where year = ${year} and nr = ${nr} and edition = ${l.law.edition}
    order by nullif(regexp_replace(article_id, '\\D', '', 'g'), '')::int nulls last, article_id` : [];
  const want = a.article?.replace(/\s*\.?\s*gr\.?$/i, "").trim();
  // text budget ~20 KB per call (Claude Code caps tool output at 25k tokens); the index tells what else to ask for
  let budget = 20_000;
  const picked = (want ? arts.filter((x) => x.article_id === want || x.article_id === `G${want}` || x.heading?.replace(/\s+/g, "") === `${want}.gr.`) : a.include_text ? arts : [])
    .filter((x) => (budget -= Math.min(x.text.length, 6000)) > 0 || x === arts[0]);
  if (!l.law && !l.matters.length && !l.amendedBy.length) return { error: "law_not_found", hint: "Not in the current law collection and no matter in the corpus amends it. Check year/nr, or search by title.", year, nr };
  return {
    law: {
      year, nr, id: `${nr}/${year}`, title: l.law?.title ?? null, chapter: l.law?.chapter ?? null, in_force: l.law?.inForce ?? null, edition: l.law?.edition ?? null,
      in_current_collection: l.law !== null, url: site.law(year, nr), althingi_url: lawPageUrl(year, nr),
      enacted_by_matter: l.law?.matter ? { lthing: l.law.matter.lthing, class: "A", nr: l.law.matter.nr, title: l.law.matter.title, url: site.matter(l.law.matter.lthing, "A", l.law.matter.nr) } : null,
    },
    articles_index: arts.map((x) => ({ article: x.article_id.replace(/^G/, ""), heading: x.heading })),
    articles_truncated: budget <= 0,
    articles: picked.map((x) => ({ article: x.article_id.replace(/^G/, ""), heading: x.heading, text: clip(x.text, 6000) })),
    amended_by: l.amendedBy.map((x) => ({ year: x.year, nr: x.nr, title: x.title, effective: x.effective, url: site.law(x.year, x.nr) })),
    amends: l.amends.map((x) => ({ year: x.year, nr: x.nr, title: x.title, url: site.law(x.year, x.nr) })),
    matters_amending: l.matters.map((x) => ({ lthing: x.lthing, class: x.cls, nr: x.nr, title: x.title, status: x.status, url: site.matter(x.lthing, x.cls, x.nr) })),
    note: "Text is the consolidated law collection (lagasafn) edition shown; it is not legal advice and may lag Stjórnartíðindi.",
    derived: false,
  };
}

/** One sitting (þingfundur): agenda, timeline events and the speeches in order. Find by (lthing, fundur) or by date. */
export async function getSitting(ctx: Ctx, a: { lthing?: number; fundur?: number; date?: string }) {
  const { sql } = ctx;
  let key: { lthing: number; fundur: number } | undefined;
  if (a.lthing !== undefined && a.fundur !== undefined) key = { lthing: a.lthing, fundur: a.fundur };
  else if (a.date) {
    const r = await sql<{ lthing: number; fundur: number }[]>`select lthing, fundur from sittings where starts::date = ${a.date} order by starts`;
    if (r.length > 1) return { candidates: r, note: "Several sittings that day; pass lthing and fundur." };
    key = r[0];
  }
  if (!key) return { error: "sitting_not_found", hint: "Pass lthing + fundur, or a date (YYYY-MM-DD) with a sitting. list_sittings lists them.", ...a };
  const [st] = await sql<{ name: string | null; starts: string | null; ends: string | null }[]>`select name, starts::text, ends::text from sittings where lthing = ${key.lthing} and fundur = ${key.fundur}`;
  if (!st) return { error: "sitting_not_found", hint: "Sittings come from the open data dump; list_sittings shows what is ingested.", ...key };
  const [agenda, events, speeches] = await Promise.all([
    sql<{ seq: number; cls: string | null; nr: number | null; title: string | null; doc_nr: number | null; off_agenda: boolean | null }[]>`
      select seq, cls, nr, title, doc_nr, off_agenda from agenda_items where lthing = ${key.lthing} and fundur = ${key.fundur} order by seq`,
    sql<{ at: string; kind: string; cls: string; nr: number; doc_nr: number | null }[]>`
      select at::text, kind, cls, nr, doc_nr from sitting_events where lthing = ${key.lthing} and fundur = ${key.fundur} order by at`,
    sql<{ id: string; started: string; member_id: number | null; member_name: string; type: string; matter_cls: string | null; matter_nr: number | null }[]>`
      select id, started::text, member_id, coalesce(member_name, speaker_abbr, '') as member_name, type, matter_cls, matter_nr
      from speeches where lthing = ${key.lthing} and fundur = ${key.fundur} order by started limit 500`,
  ]);
  const EVENT: Record<string, string> = { fundurhefst: "sitting opened", fundiSlitið: "sitting closed", "umræðuLokið": "debate closed", "umræðuOgAtkvæðagreiðsluFrestað": "debate and vote postponed", frvAfgreittSemLög: "bill passed as law" };
  return {
    sitting: { lthing: key.lthing, fundur: key.fundur, name: st.name, starts: st.starts, ends: st.ends, day_url: st.starts ? `${SITE}/dagur/${st.starts.slice(0, 10)}` : null },
    agenda: agenda.map((x) => ({ seq: x.seq + 1, matter: x.cls && x.nr !== null ? { lthing: key.lthing, class: x.cls, nr: x.nr, url: site.matter(key.lthing, x.cls, x.nr) } : null, title: x.title, document_nr: x.doc_nr, off_agenda: x.off_agenda })),
    events: events.map((e) => ({ at: e.at, kind: e.kind, kind_en: EVENT[e.kind] ?? null, matter: e.cls ? { class: e.cls, nr: e.nr } : null, document_nr: e.doc_nr })),
    speeches: speeches.map((x) => ({ id: x.id, started: x.started, member: { id: x.member_id, name: x.member_name }, speech_type: x.type, matter: x.matter_cls ? { class: x.matter_cls, nr: x.matter_nr } : null, url: `${SITE}/raeda/${x.id}` })),
    derived: false,
  };
}

export async function listSittings(ctx: Ctx, a: { lthing: number; date_from?: string; date_to?: string; limit?: number }) {
  const { sql } = ctx;
  const rows = await sql<{ fundur: number; name: string | null; starts: string | null; ends: string | null; items: number; speeches: number }[]>`
    select s.fundur, s.name, s.starts::text, s.ends::text,
      (select count(*)::int from agenda_items a where a.lthing = s.lthing and a.fundur = s.fundur) as items,
      (select count(*)::int from speeches p where p.lthing = s.lthing and p.fundur = s.fundur) as speeches
    from sittings s where s.lthing = ${a.lthing}
      ${a.date_from ? sql`and s.starts::date >= ${a.date_from}` : sql``}
      ${a.date_to ? sql`and s.starts::date <= ${a.date_to}` : sql``}
    order by s.fundur desc limit ${Math.min(a.limit ?? 50, 200)}`;
  return { lthing: a.lthing, sittings: rows.map((r) => ({ ...r, day_url: r.starts ? `${SITE}/dagur/${r.starts.slice(0, 10)}` : null })), derived: false };
}

// ---------------------------------------------------------------- failures: never a raw Postgres message to the agent

const TEXT_TOOLS = new Set(["search_speeches", "aggregate", "first_use", "topic_timeline", "search"]);

/** Concrete smaller calls to try after a timeout: one year of the range, the per-year count to choose that year, one session. */
export function retrySuggestions(tool: string, args: Record<string, unknown>, lastDate: string | null): { tool: string; arguments: Record<string, unknown>; why: string }[] {
  if (!TEXT_TOOLS.has(tool)) return [{ tool, arguments: args, why: "Retry once; the database was busy." }];
  const q = (args.q ?? args.query) as string | undefined;
  const from = args.date_from as string | undefined, to = args.date_to as string | undefined;
  const y = Number((to ?? lastDate ?? new Date().toISOString()).slice(0, 4));
  const name = tool === "search" ? "search_speeches" : tool;
  const base: Record<string, unknown> = tool === "search" ? { q } : { ...args, cursor: undefined };
  const out: { tool: string; arguments: Record<string, unknown>; why: string }[] = [];
  if (!(from && to && from.slice(0, 4) === to.slice(0, 4))) {
    const yFrom = from && from > `${y}-01-01` ? from : `${y}-01-01`;
    const yTo = to && to < `${y}-12-31` ? to : `${y}-12-31`;
    out.push({ tool: name, arguments: { ...base, date_from: yFrom, date_to: yTo }, why: "The same call over one year (the last year of the range)." });
  }
  if (q && name !== "aggregate") {
    out.push({ tool: "aggregate", arguments: { metric: "speeches", group_by: "year", q, date_from: from, date_to: to }, why: "Speeches per year for this query; then search the years that matter one at a time." });
  }
  if (args.lthing === undefined) out.push({ tool: name, arguments: { ...base, lthing: "<session number from list_sessions>" }, why: "Or restrict to one session (löggjafarþing)." });
  return out.map((s) => ({ ...s, arguments: Object.fromEntries(Object.entries(s.arguments).filter(([, v]) => v !== undefined)) }));
}

/** A thrown error inside a tool, as an actionable isError payload. Postgres details go to the log, not the agent. */
export async function toolFailure(ctx: Ctx, tool: string, args: Record<string, unknown>, e: unknown) {
  const err = e as { code?: string; message?: string } | null;
  const timeout = err?.code === "57014"; // query_canceled: the MCP pool's statement_timeout
  console.error(JSON.stringify({ mcp_tool_error: tool, code: err?.code ?? null, message: String(err?.message ?? e).slice(0, 300) }));
  let detail: CorpusDetail | null = null, corpus: string | undefined;
  try { detail = await corpusDetail(ctx.sql); corpus = await corpusBlock(ctx.sql); } catch { /* the database itself may be down */ }
  if (timeout) {
    return {
      error: "timeout",
      hint: "The query hit the server's time limit; this says nothing about whether matching speeches exist. Narrow date_from/date_to (one year at a time), add lthing (see list_sessions), or run aggregate(group_by='year', q) first to find the years with hits. The `retry` calls are ready to use.",
      retry: retrySuggestions(tool, args, detail?.text_dates.to ?? null),
      ...(corpus ? { corpus } : {}),
    };
  }
  return {
    error: "internal_error",
    hint: "The server could not answer this call (not a statement about the data). Retry once; if it fails again, narrow the arguments or use another tool.",
    retry: [{ tool, arguments: args, why: "Retry once." }],
    ...(corpus ? { corpus } : {}),
  };
}

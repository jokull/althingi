import { matterPageUrl, speechPageUrl } from "./althingi-urls.ts";
// Search v2 (docs/DECISIONS.md §9), query shape v3 (docs/PERFORMANCE.md §3.2). One statement per page; snippets are
// computed in-process for the returned hits only.
//   recall  : words -> AND of OR-groups of lemmas over paragraphs.search_vector (all candidate readings)
//   phrase  : "quoted" -> adjacent best-guess lemmas over paragraphs.seq_vector (<->)
//   cand    : a MATERIALIZED CTE of (speech_id, seq) straight from the GIN, ANDed with a pkey range for dates (the id is
//             the date) — ids only, no tsvector is ever read for a paragraph that is not ranked, and the planner can
//             never turn `@@` into a heap filter (which detoasts the whole table: docs/PERFORMANCE.md §1)
//   window  : a common word's candidates are capped (RANK_CAP): ranked within the newest sessions that fit
//   rank    : ts_rank_cd(.., 1) x speech-type x debate-stage x matter-title match x recency, facts from speech_index
//   shape   : results grouped by speech (best 2 paragraphs each), keyset paging, no OFFSET; total in the same statement
import { isStopword } from "lemma-is";
import { Lru } from "./cache.ts";
import { corpusState, type SessionInfo } from "./corpus.ts";
import type { Sql } from "./db.ts";
import { type ParsedQuery, describe, parseQuery } from "./explain.ts";
import { type Snippet, snippets } from "./lemma.ts";
import { snippetFromTokens } from "./snippet.ts";

export interface SearchParams {
  q: string;
  memberId?: number;
  type?: string;
  lthing?: number;
  dateFrom?: string; // ISO date
  dateTo?: string;
  matterCls?: string;
  matterNr?: number;
  /** party id: resolved through seats ON THE SPEECH DATE (never by session) */
  partyId?: number;
  /** minister portfolio abbreviation as in the speech file ("fjmrh."), prefix match */
  office?: string;
  /** debate codes: 1 2 3 * S E F T */
  debate?: string[];
  /** decoded tegflm label, e.g. "ráðherra" */
  capacity?: string;
  limit?: number;
  sort?: "relevance" | "newest" | "oldest";
  /** also compute the number of matching speeches (capped at TOTAL_CAP) */
  withTotal?: boolean;
  /** the running session; gets a small recency boost */
  currentLthing?: number;
  /** opaque keyset cursor from a previous page */
  cursor?: string;
}

export interface ParagraphHit {
  seq: number;
  score: number;
  snippets: Snippet[];
}

export interface SpeechHit {
  speechId: string;
  date: string;
  started: string;
  /** null: dump-only speaker not resolved to a member id yet (abbreviation-only) */
  memberId: number | null;
  memberName: string;
  speechType: string;
  debate: string;
  matter: { lthing: number; cls: string; nr: number; title: string | null } | null;
  /** text is Alþingi's provisional version (raedur_bradabirgda) */
  provisional: boolean;
  /** the speech's page on althingi.is (text, audio and video there) */
  althingiUrl: string | null;
  /** score of the best paragraph (after boosts) */
  score: number;
  matchingParagraphs: number;
  /** up to 2 best paragraphs */
  paragraphs: ParagraphHit[];
}

export interface MatterCard {
  lthing: number;
  cls: string;
  nr: number;
  title: string;
  /** the matter's page on althingi.is */
  althingiUrl: string;
}

export interface SearchResult {
  /** milliseconds: the main SQL query vs everything else (lemmatizing the query, snippets, matter cards) */
  timing?: { dbMs: number; appMs: number };
  hits: SpeechHit[];
  /** matters whose TITLE matches every query word (e.g. "fjárlög 2026"), current session first; shown above the hits */
  matterCards: MatterCard[];
  nextCursor: string | null;
  /** matching speeches when requested: exact up to TOTAL_CAP, else TOTAL_CAP with `totalCapped` */
  total?: number;
  totalCapped?: boolean;
  /** no words to search: the hits are the filtered speeches, newest first */
  browse?: boolean;
  /**
   * The ranked window when the query was too common to rank whole-corpus (docs/PERFORMANCE.md §3.2): hits and `total`
   * cover speeches from `from` on (`to` for oldest-first); `capped` = even that window exceeded RANK_CAP paragraphs.
   */
  window?: { from: string | null; to: string | null; capped: boolean };
  /** the query as understood: shown to the user and returned by the MCP explain tool */
  query: { description: string; parsed: ParsedQuery };
}

const MAX_LIMIT = 25;
export const TOTAL_CAP = 10_000;
/** paragraphs ranked per query at most: ~15 µs each warm, ~200 µs each cold (one heap page of paragraphs); 3,000 ≈ 45 ms warm / 0.6 s cold */
export const RANK_CAP = 3_000;

/** `rad20170101` — speech ids are timestamps, so a date is a pkey prefix on paragraphs (and speech_index). */
export const idFloor = (date: string): string => `rad${date.replace(/-/g, "")}`;
/** exclusive upper bound: the id prefix of the day after */
export const idCeil = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return `rad${d.toISOString().slice(0, 10).replace(/-/g, "")}`;
};

// paragraph counts per lemma (vocab.ndoc, refreshed nightly): only an estimate for the candidate cap
const ndocCache = new Lru<Promise<Map<string, number>>>(2000);
async function ndoc(sql: Sql, lemmas: string[]): Promise<Map<string, number>> {
  const key = [...lemmas].sort().join("\u0001");
  const hit = ndocCache.get(key);
  if (hit) return hit;
  const p = sql<{ word: string; ndoc: number }[]>`select word, ndoc from vocab where word = any(${lemmas})`
    .then((rows) => new Map(rows.map((r) => [r.word, r.ndoc])));
  ndocCache.set(key, p);
  p.catch(() => ndocCache.delete(key));
  return p;
}

/**
 * Estimated candidate paragraphs: per AND-part the sum of its alternatives' counts, the minimum over parts. Phrase
 * lemmas that are stopwords are skipped: vocab counts come from search_vector (stopwords dropped), while the phrase
 * index keeps them, so "á" reads as rare in vocab and is in nearly every paragraph of seq_vector. A phrase made only
 * of stopwords is treated as matching everything.
 */
export function estimateCandidates(p: ParsedQuery, counts: Map<string, number>, total = Number.MAX_SAFE_INTEGER): number {
  let est = Number.POSITIVE_INFINITY;
  for (const part of p.parts) {
    const alts = part.kind === "word" ? [...part.lemmas, ...(part.allOf ?? []).flat()] : part.lemmas.filter((l) => !isStopword(l));
    if (part.kind === "phrase" && !alts.length) { est = Math.min(est, total); continue; }
    const known = alts.filter((l) => counts.has(l));
    if (!known.length) continue; // unknown lemma (not in vocab): matches nothing
    const n = part.kind === "phrase" ? Math.min(...known.map((l) => counts.get(l)!)) : known.reduce((a, l) => a + counts.get(l)!, 0);
    est = Math.min(est, n);
  }
  return Number.isFinite(est) ? est : 0;
}

/**
 * The newest sessions whose share of the corpus keeps `est × share` within the cap: the search is ranked within them.
 * `oldest` mirrors it from the other end. Returns the floor/ceiling date, or null when no window is needed.
 */
export function rankWindow(est: number, sessions: SessionInfo[], total: number, oldest = false, cap = RANK_CAP): { from: string | null; to: string | null } {
  if (est <= cap || total <= 0) return { from: null, to: null };
  const ordered = [...sessions].filter((s) => s.done > 0).sort((a, b) => (oldest ? a.lthing - b.lthing : b.lthing - a.lthing));
  let acc = 0;
  for (const s of ordered) {
    acc += s.done;
    if (est * (acc / total) >= cap) return oldest ? { from: null, to: s.last_date } : { from: s.first_date, to: null };
  }
  return { from: null, to: null };
}
const enc = (c: unknown[]) => Buffer.from(JSON.stringify(c)).toString("base64url");
function dec(s: string): [number, string, string] {
  const c = JSON.parse(Buffer.from(s, "base64url").toString());
  if (!Array.isArray(c) || c.length !== 3) throw new Error("bad cursor");
  return c as [number, string, string];
}

const lex = (s: string): string => `'${s.replace(/'/g, "''").replace(/\\/g, "\\\\")}'`;

/** AND of OR-groups for the recall side. */
export function recallTsQuery(p: ParsedQuery): string | null {
  const parts = p.parts
    .filter((x) => x.kind === "word" && (x.lemmas.length || x.allOf?.length))
    .map((x) => {
      const grp = (g: string[]) => (g.length === 1 ? lex(g[0]!) : `(${g.map(lex).join(" | ")})`);
      const alts = [...x.lemmas.map(lex), ...(x.allOf && x.allOf.length >= 2 ? [`(${x.allOf.map(grp).join(" & ")})`] : [])];
      return alts.length === 1 ? alts[0]! : `(${alts.join(" | ")})`;
    });
  return parts.length ? parts.join(" & ") : null;
}

/**
 * A number counts only when it sits within `maxGap` tokens of one of the query's words (both directions), over the
 * sequence vector: "fjárlög 2026", "síðustu fjárlögum fyrir þetta ár, árið 2026" (gap 5, found by the judge: 4 was too tight).
 * A year elsewhere in the paragraph does not count.
 */
export function numberProximityTsQuery(p: ParsedQuery, maxGap = 8): string | null {
  if (p.numbers.length === 0) return null;
  const lemmas = new Set<string>();
  for (const part of p.parts) {
    if (part.kind !== "word") continue;
    part.lemmas.forEach((l) => lemmas.add(l));
    part.allOf?.flat().forEach((l) => lemmas.add(l));
  }
  const ls = [...lemmas].slice(0, 8);
  if (ls.length === 0) return null;
  const perNumber = p.numbers.map((n) => {
    const terms: string[] = [];
    for (const l of ls) for (let d = 1; d <= maxGap; d++) terms.push(`(${lex(l)} <${d}> ${lex(n)})`, `(${lex(n)} <${d}> ${lex(l)})`);
    return `(${terms.join(" | ")})`;
  });
  return perNumber.join(" & ");
}

/** AND of adjacency chains for the phrase side. */
export function phraseTsQuery(p: ParsedQuery): string | null {
  const parts = p.parts
    .filter((x) => x.kind === "phrase" && x.lemmas.length)
    .map((x) => (x.lemmas.length === 1 ? lex(x.lemmas[0]!) : `(${x.lemmas.map(lex).join(" <-> ")})`));
  return parts.length ? parts.join(" & ") : null;
}

// a page is immutable until the next ingest: memoized by (params, corpus_state.version); docs/PERFORMANCE.md §3.4
const pageLru = new Lru<Promise<SearchResult>>(500);
/** one speech in the ranked list of a query: its best score, time, best (≤ 2) paragraphs, and the list-wide totals */
interface RankRow { speech_id: string; score: number; started: string; seqs: number[]; scores: number[]; n_par: number; total: number; n_cand: number }
// the ranked list per (query, filters, sort, corpus version): paging and repeats read it, never the database
const rankedLru = new Lru<Promise<RankRow[]>>(300);
export async function search(sql: Sql, p: SearchParams): Promise<SearchResult> {
  const version = (await corpusState(sql)).version;
  const key = `${version}|${JSON.stringify(p)}`;
  let r = pageLru.get(key);
  if (!r) {
    r = searchUncached(sql, p, version);
    pageLru.set(key, r);
    r.catch(() => pageLru.delete(key));
  }
  const res = await r;
  // callers append pages to `hits` (mcp-tools) and read timing: hand out a copy, keep the cached object pristine
  return { ...res, hits: [...res.hits], timing: res.timing ? { ...res.timing } : undefined };
}

async function searchUncached(sql: Sql, p: SearchParams, version: number): Promise<SearchResult> {
  const tStart = performance.now();
  // postgres.js has no "join fragments" helper: fold a list of fragments into one
  const fold = (frags: ReturnType<Sql>[]) => frags.reduce((acc, f) => sql`${acc} ${f}`, sql``);
  const rawQ = p.q.trim().slice(0, 200);
  const parsed = parseQuery(rawQ);
  const explained = { description: describe(parsed), parsed };
  const recall = recallTsQuery(parsed);
  const phrase = phraseTsQuery(parsed);
  const prox = numberProximityTsQuery(parsed);
  // exact surface form of each quoted phrase earns a boost over lemma-folded matches ("virðulegi forseti" vs "virðulegur forseti")
  const exactBoost = parsed.parts
    .filter((x) => x.kind === "phrase" && x.text)
    .map((x) => sql`case when p.text ilike ${"%" + x.text.replace(/[%_\\]/g, "\\$&") + "%"} then 1.5 else 1.0 end`);
  const filtered = p.memberId !== undefined || !!p.type || p.lthing !== undefined || !!p.dateFrom || !!p.dateTo ||
    (!!p.matterCls && p.matterNr !== undefined) || p.partyId !== undefined || !!p.office || !!p.debate?.length || !!p.capacity;
  // no words but filters ("Bergþór Ólason andsvar", "forsætisráðherra síðustu viku"): list the filtered speeches
  const browse = (!recall && !phrase) && filtered && parsed.numbers.length === 0;
  if (!browse && (parsed.empty || (!recall && !phrase))) return { hits: [], matterCards: [], nextCursor: null, query: explained };

  const limit = Math.min(Math.max(p.limit ?? 10, 1), MAX_LIMIT);
  const oldest = p.sort === "oldest";
  const newest = p.sort === "newest" || (browse && !oldest);
  const byTime = newest || oldest;
  const cur = p.cursor ? dec(p.cursor) : null;
  const current = p.currentLthing ?? 0;

  const rq = recall ? sql`to_tsquery('simple', ${recall})` : null;
  const pq = phrase ? sql`to_tsquery('simple', ${phrase})` : null;
  // weights are {D, C, B, A}: whole-word lemmas are A (1.0); compound constituents are D, raised from the default 0.1 to 0.3
  // so genuine head-compounds (lögreglustjóraembætti) are not buried under passing mentions (docs/EVAL-phase0.md D2/D5)
  const W = sql`'{0.3,0.2,0.4,1.0}'::float4[]`;
  // normalisation flag 1 (log length). Flag 0 was tried and judged a net regression (docs/EVAL-phase0.md v4: fewer relevant
  // hits, q02/q19 lost precision): long paragraphs with one passing mention then beat short substantive ones.
  const rank = rq ? sql`ts_rank_cd(${W}, p.search_vector, ${rq}, 1)` : pq ? sql`ts_rank_cd(${W}, p.seq_vector, ${pq}, 1)` : sql`1.0`;
  const titleBoost = rq ? sql`case when f.title_vec @@ ${rq} then 1.3 else 1.0 end` : sql`1.0`;

  // ---- the window: dates (and a session) become a pkey range; a common word is ranked within the newest sessions only
  const state = await corpusState(sql);
  const session = p.lthing !== undefined ? state.sessions.find((s) => s.lthing === p.lthing) : undefined;
  let from = p.dateFrom, to = p.dateTo;
  if (session?.first_date && (!from || session.first_date > from)) from = session.first_date;
  if (session?.last_date && (!to || session.last_date < to)) to = session.last_date;
  let window: SearchResult["window"];
  const selective = p.memberId !== undefined || p.partyId !== undefined || (!!p.matterCls && p.matterNr !== undefined);
  if (!browse && !selective) {
    const lemmas = new Set<string>();
    for (const part of parsed.parts) { part.lemmas.forEach((l) => lemmas.add(l)); part.allOf?.flat().forEach((l) => lemmas.add(l)); }
    let est = estimateCandidates(parsed, await ndoc(sql, [...lemmas]), state.speechesDone * 4); // ~4 paragraphs per speech
    // an explicit date range already narrows the candidates in proportion to its share of the corpus
    if ((from || to) && state.speechesDone > 0) {
      const inRange = state.sessions.filter((s) => s.done > 0 && (!from || !s.last_date || s.last_date >= from) && (!to || !s.first_date || s.first_date <= to))
        .reduce((a, s) => a + s.done, 0);
      est = est * (inRange / state.speechesDone);
    }
    // a phrase candidate costs a positional recheck (one paragraphs page each) before anything is ranked, so its
    // window is a quarter of the cap: "hér á landi" was 1.6 s with the full cap, i.e. a 2 s web timeout under load
    const hasPhrase = parsed.parts.some((x) => x.kind === "phrase");
    const w = rankWindow(est, state.sessions, state.speechesDone, oldest, hasPhrase ? RANK_CAP / 4 : RANK_CAP);
    if (w.from && (!from || w.from > from)) { from = w.from; window = { from, to: null, capped: false }; }
    if (w.to && (!to || w.to < to)) { to = w.to; window = { from: null, to, capped: false }; }
  }
  const idFrom = from ? idFloor(from) : null;
  const idTo = to ? idCeil(to) : null;
  // speech-level filters (speech_index, indexed): applied to the candidate ids before anything is ranked
  const siFilters = () => sql`
        ${p.memberId !== undefined ? sql`and si.member_id = ${p.memberId}` : sql``}
        ${p.type ? sql`and si.type = ${p.type}` : sql``}
        ${p.lthing !== undefined ? sql`and si.lthing = ${p.lthing}` : sql``}
        ${p.matterCls && p.matterNr !== undefined ? sql`and si.matter_cls = ${p.matterCls} and si.matter_nr = ${p.matterNr}` : sql``}
        ${p.partyId !== undefined ? sql`and si.party_id = ${p.partyId}` : sql``}
        ${p.debate?.length ? sql`and si.debate = any(${p.debate})` : sql``}
        ${idFrom ? sql`and si.id >= ${idFrom}` : sql``}
        ${idTo ? sql`and si.id < ${idTo}` : sql``}`;
  // office / capacity live on speeches only (rare filters): one pkey lookup per candidate speech
  const speechFilters = () => sql`
        ${p.office ? sql`and exists (select 1 from speeches s where s.id = si.id and s.office ilike ${p.office.replace(/[%_\\]/g, "\\$&") + "%"})` : sql``}
        ${p.capacity ? sql`and exists (select 1 from speeches s where s.id = si.id and s.speaker_capacity = ${p.capacity})` : sql``}`;
  const needSi = p.memberId !== undefined || !!p.type || p.lthing !== undefined || (!!p.matterCls && p.matterNr !== undefined)
    || p.partyId !== undefined || !!p.debate?.length || !!p.office || !!p.capacity;

  const cursorCond = () => cur
    ? newest
      ? sql`and (started, speech_id) < (${cur[1]}::timestamp, ${cur[2]})`
      : oldest
        ? sql`and (started, speech_id) > (${cur[1]}::timestamp, ${cur[2]})`
        : sql`and (score, started, speech_id) < (${cur[0]}::float8, ${cur[1]}::timestamp, ${cur[2]})`
    : sql``;
  const pageOrder = newest ? sql`order by started desc, speech_id desc` : oldest ? sql`order by started, speech_id` : sql`order by score desc, started desc, speech_id desc`;

  type Row = {
    speech_id: string; seq: number; text: string; score: number; speech_date: string; started_txt: string;
    member_id: number | null; member_name: string; type: string; debate: string; matter_cls: string | null; matter_nr: number | null;
    lthing: number; title: string | null; rn: number; n_par: number; provisional: boolean; html_url: string | null;
    tok_lemma: string[] | null; tok_start: number[] | null; tok_len: number[] | null; total: number | null; n_cand: number | null;
  };
  const tDb = performance.now();
  let rows: Row[];
  if (browse) {
    rows = await sql<Row[]>`
      with best as (
        select si.id as speech_id, si.started, 1.0::float8 as score from speech_index si
        where true ${siFilters()} ${speechFilters()} ${cursorCond()}
        ${pageOrder} limit ${limit + 1}
      )
      select b.speech_id, 0 as seq, coalesce(p.text, '') as text, b.score, s.speech_date::text, s.started::text as started_txt,
             s.member_id, coalesce(s.member_name, s.speaker_abbr, '') as member_name, s.type, s.debate, s.matter_cls, s.matter_nr, s.lthing, m.title,
             1 as rn, 1 as n_par, s.provisional, s.html_url, null::text[] as tok_lemma, null::int[] as tok_start, null::smallint[] as tok_len,
             ${p.withTotal && !p.cursor ? sql`(select count(*)::int from (select 1 from speech_index si where true ${siFilters()} ${speechFilters()} limit ${TOTAL_CAP + 1}) x)` : sql`null::int`} as total,
             null::int as n_cand
      from best b join speeches s on s.id = b.speech_id
      left join matters m on m.lthing = s.lthing and m.cls = s.matter_cls and m.nr = s.matter_nr
      left join paragraphs p on p.speech_id = b.speech_id and p.seq = 0
      ${newest ? sql`order by b.started desc, b.speech_id desc` : sql`order by b.started, b.speech_id`}`;
  } else {
    // A: the ranked speech list for this query + filters (every candidate up to RANK_CAP, scored once), memoized per
    // corpus version; B: text, facts and tokens for the page's rows only. Pages 2..n and repeats never rank again.
    const rankKey = `${version}|${JSON.stringify({ ...p, cursor: undefined, limit: undefined, withTotal: undefined, currentLthing: current })}`;
    let ranked = rankedLru.get(rankKey);
    if (!ranked) {
      ranked = sql<RankRow[]>`
      with cand as materialized (
        ${rq
          // recall words: the narrow paragraph_index (ids only, GIN over para_vec); phrase/number conditions recheck
          // the sequence vector of those candidates only
          ? sql`select p.speech_id, p.seq, p.q from paragraph_index p
          where para_vec(p.speech_id, p.seq) @@ ${rq}
          ${pq || prox ? sql`and exists (select 1 from paragraphs q where q.speech_id = p.speech_id and q.seq = p.seq
            ${pq ? sql`and q.seq_vector @@ ${pq}` : sql``}
            ${prox ? sql`and q.seq_vector @@ to_tsquery('simple', ${prox})` : sql``})` : sql``}`
          // phrase-only queries: the sequence GIN on paragraphs (positions are needed, so the recheck reads the row)
          : sql`select p.speech_id, p.seq, null::real as q from paragraphs p
          where p.seq_vector @@ ${pq}
          ${prox ? sql`and p.seq_vector @@ to_tsquery('simple', ${prox})` : sql``}`}
          ${idFrom ? sql`and p.speech_id >= ${idFrom}` : sql``}
          ${idTo ? sql`and p.speech_id < ${idTo}` : sql``}
          ${needSi ? sql`and p.speech_id in (select si.id from speech_index si where true ${siFilters()} ${speechFilters()})` : sql``}
      ),
      filtered as (
        select c.speech_id, c.seq, c.q, si.started, si.type, si.debate, si.lthing, si.title_vec
        from cand c join speech_index si on si.id = c.speech_id
      ),
      stats as (select count(distinct speech_id)::int as total, count(*)::int as n_cand from filtered),
      -- the cap keeps the most substantive candidates (static score), newest first among equals
      -- the cap keeps the most substantive candidates; the kept set is then re-sorted by id so the pkey lookups into
      -- paragraphs walk the heap in physical order (ids are the physical order, correlation -0.9998)
      capped as (select * from ${byTime ? sql`filtered` : sql`(select * from filtered order by q desc nulls last, speech_id desc, seq limit ${RANK_CAP}) x order by speech_id desc, seq`}),
      scored as (
        ${byTime
          ? sql`select f.*, 1.0::float8 as score from capped f`
          : sql`select f.*,
             (${rank}
               * case f.type when 'ræða' then 1.0 when 'flutningsræða' then 1.0 when 'svar' then 1.0
                             when 'andsvar' then 0.8 when 'grein fyrir atkvæði' then 0.6
                             when 'um atkvæðagreiðslu' then 0.6 when 'um fundarstjórn' then 0.4 else 0.8 end
               * case when f.debate in ('1', '2', '3') then 1.0 else 0.9 end
               * least(1.0, ln(1 + length(p.text) / 6.0) / ln(44.0)) -- one-liners ("Virðulegi forseti.") must not beat substantive paragraphs
               * ${titleBoost}
               * ${exactBoost.length ? exactBoost.reduce((acc, f) => sql`${acc} * ${f}`) : sql`1.0`}
               * case when f.lthing = ${current} then 1.1 else 1.0 end)::float8 as score
            from capped f join paragraphs p on p.speech_id = f.speech_id and p.seq = f.seq`}
      ),
      ranked as (
        select h.*, row_number() over (partition by speech_id order by score desc, seq) as rn,
               count(*) over (partition by speech_id) as n_par
        from scored h
      )
      select speech_id, max(score)::float8 as score, max(started)::text as started,
             (array_agg(seq order by rn))[1:2] as seqs, (array_agg(score order by rn))[1:2] as scores, max(n_par)::int as n_par,
             (select total from stats) as total, (select n_cand from stats) as n_cand
      from ranked where rn <= 2 group by speech_id
      ${newest ? sql`order by 3 desc, 1 desc` : oldest ? sql`order by 3, 1` : sql`order by 2 desc, 3 desc, 1 desc`}`
        .then((r) => r.map((x) => ({ ...x, score: Number(x.score) })));
      rankedLru.set(rankKey, ranked);
      ranked.catch(() => rankedLru.delete(rankKey));
    }
    const list = await ranked;
    // keyset position in the cached list (the cursor is what the previous page returned for its last speech)
    const after = (x: RankRow) => !cur ? true
      : newest ? x.started < cur[1] || (x.started === cur[1] && x.speech_id < cur[2])
      : oldest ? x.started > cur[1] || (x.started === cur[1] && x.speech_id > cur[2])
      : x.score < cur[0] || (x.score === cur[0] && (x.started < cur[1] || (x.started === cur[1] && x.speech_id < cur[2])));
    const start = cur ? list.findIndex(after) : 0;
    const slice = start < 0 ? [] : list.slice(start, start + limit + 1);
    const keys = slice.flatMap((x) => x.seqs.map((seq) => ({ speech_id: x.speech_id, seq })));
    const page = keys.length ? await sql<Omit<Row, "score" | "rn" | "n_par" | "total" | "n_cand">[]>`
      select p.speech_id, p.seq, p.text, s.speech_date::text, s.started::text as started_txt,
             s.member_id, coalesce(s.member_name, s.speaker_abbr, '') as member_name, s.type, s.debate, s.matter_cls, s.matter_nr, s.lthing, m.title,
             s.provisional, s.html_url, t.lemma as tok_lemma, t.start as tok_start, t.len as tok_len
      from unnest(${keys.map((k) => k.speech_id)}::text[], ${keys.map((k) => k.seq)}::int[]) as k(sid, sq)
      join paragraphs p on p.speech_id = k.sid and p.seq = k.sq
      join speeches s on s.id = k.sid
      left join matters m on m.lthing = s.lthing and m.cls = s.matter_cls and m.nr = s.matter_nr
      left join paragraph_tokens t on t.speech_id = p.speech_id and t.seq = p.seq` : [];
    const byKey = new Map(page.map((r) => [`${r.speech_id}\u0001${r.seq}`, r]));
    rows = [];
    for (const x of slice) {
      x.seqs.forEach((seq, i) => {
        const r = byKey.get(`${x.speech_id}\u0001${seq}`);
        if (r) rows.push({ ...r, score: Number(x.scores[i] ?? x.score), rn: i + 1, n_par: x.n_par, total: list[0]?.total ?? 0, n_cand: list[0]?.n_cand ?? 0 });
      });
    }
  }
  const dbMs = performance.now() - tDb;
  const total = p.withTotal && !p.cursor ? (rows[0]?.total ?? 0) : undefined;
  if (!byTime && (rows[0]?.n_cand ?? 0) > RANK_CAP) window = { from: from ?? null, to: to ?? null, capped: true };
  const cards = rq
    ? await sql<{ lthing: number; cls: string; nr: number; title: string; html_url: string | null }[]>`
        select lthing, cls, nr, title, html_url from matters m
        where m.title_vector @@ ${rq}
          ${fold(parsed.numbers.map((n) => sql`and m.title ~ ${`(^|[^0-9])${n}([^0-9]|$)`}`))}
        order by (lthing = ${current}) desc, lthing desc, nr limit 3`
    : [];

  const plain = rawQ.replace(/"/g, " ");
  // lemmas to highlight: whole-word candidates, compound parts and phrase lemmas
  const wanted = new Set<string>();
  for (const part of parsed.parts) {
    part.lemmas.forEach((l) => wanted.add(l));
    part.allOf?.flat().forEach((l) => wanted.add(l));
  }
  const bySpeech = new Map<string, SpeechHit & { _startedTxt: string }>();
  for (const r of rows) {
    let h = bySpeech.get(r.speech_id);
    if (!h) {
      h = {
        speechId: r.speech_id, date: r.speech_date, started: r.started_txt, _startedTxt: r.started_txt,
        memberId: r.member_id, memberName: r.member_name, speechType: r.type, debate: r.debate,
        matter: r.matter_cls && r.matter_nr !== null ? { lthing: r.lthing, cls: r.matter_cls, nr: r.matter_nr, title: r.title } : null,
        provisional: r.provisional ?? false, althingiUrl: speechPageUrl(r.lthing, r.speech_id, r.html_url),
        score: r.score, matchingParagraphs: Number(r.n_par), paragraphs: [],
      };
      bySpeech.set(r.speech_id, h);
    }
    // fast path: stored tokens. Fallback (rare): lemma-is, e.g. when the match was a non-best candidate reading.
    if (browse) {
      const t = r.text.length > 320 ? `${r.text.slice(0, 320).replace(/\s+\S*$/, "")} …` : r.text;
      h.paragraphs.push({ seq: r.seq, score: r.score, snippets: [{ text: t, segments: [{ text: t, highlight: false }], score: 0, start: 0, end: t.length } as Snippet] });
      continue;
    }
    const fast = r.tok_lemma && r.tok_start && r.tok_len
      ? snippetFromTokens(r.text, { lemma: r.tok_lemma, start: r.tok_start, len: r.tok_len }, wanted)
      : null;
    h.paragraphs.push({ seq: r.seq, score: r.score, snippets: fast ?? snippets(plain, r.text) });
  }
  const all = [...bySpeech.values()];
  const page = all.slice(0, limit);
  const last = page[page.length - 1];
  const elapsed = performance.now() - tStart;
  return {
    timing: { dbMs, appMs: elapsed - dbMs },
    query: explained,
    matterCards: cards.map((c) => ({ lthing: c.lthing, cls: c.cls, nr: c.nr, title: c.title, althingiUrl: matterPageUrl(c.lthing, c.cls, c.nr, c.html_url) })),
    nextCursor: all.length > limit && last ? enc([last.score, last._startedTxt, last.speechId]) : null,
    hits: page.map(({ _startedTxt, ...h }) => h),
    ...(total !== undefined ? { total: Math.min(total, TOTAL_CAP), totalCapped: total > TOTAL_CAP } : {}),
    ...(browse ? { browse: true } : {}),
    ...(window ? { window } : {}),
  };
}

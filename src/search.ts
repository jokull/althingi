// Search v2 (docs/DECISIONS.md §9). One indexed query per page; snippets are computed in-process for the returned hits only.
//   recall  : words -> AND of OR-groups of lemmas over paragraphs.search_vector (all candidate readings)
//   phrase  : "quoted" -> adjacent best-guess lemmas over paragraphs.seq_vector (<->)
//   rank    : ts_rank_cd(.., 1) x speech-type x debate-stage x matter-title match x recency
//   shape   : results grouped by speech (best 2 paragraphs each), keyset paging, no OFFSET
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
  memberId: number;
  memberName: string;
  speechType: string;
  debate: string;
  matter: { lthing: number; cls: string; nr: number; title: string | null } | null;
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
  /** the query as understood: shown to the user and returned by the MCP explain tool */
  query: { description: string; parsed: ParsedQuery };
}

const MAX_LIMIT = 25;
export const TOTAL_CAP = 10_000;
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

export async function search(sql: Sql, p: SearchParams): Promise<SearchResult> {
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
  const titleBoost = rq ? sql`case when m.title_vector @@ ${rq} then 1.3 else 1.0 end` : sql`1.0`;
  // the WHERE clause, shared by the page query and the total count (a fresh fragment per use)
  const where = () => sql`
        ${rq ? sql`and p.search_vector @@ ${rq}` : sql``}
        ${pq ? sql`and p.seq_vector @@ ${pq}` : sql``}
        ${browse ? sql`and p.seq = 0` : sql``}
        ${p.memberId !== undefined ? sql`and s.member_id = ${p.memberId}` : sql``}
        ${p.type ? sql`and s.type = ${p.type}` : sql``}
        ${p.lthing !== undefined ? sql`and s.lthing = ${p.lthing}` : sql``}
        ${p.dateFrom ? sql`and s.speech_date >= ${p.dateFrom}` : sql``}
        ${p.dateTo ? sql`and s.speech_date <= ${p.dateTo}` : sql``}
        ${p.matterCls && p.matterNr !== undefined ? sql`and s.matter_cls = ${p.matterCls} and s.matter_nr = ${p.matterNr}` : sql``}
        ${p.partyId !== undefined ? sql`and exists (
            select 1 from seats st
            where st.member_id = s.member_id and st.party_id = ${p.partyId} and st.kind in ('þingmaður', 'varamaður')
              and s.speech_date between coalesce(st.from_date, date '0001-01-01') and coalesce(st.to_date, date '9999-12-31'))` : sql``}
        ${p.office ? sql`and s.office ilike ${p.office.replace(/[%_\\]/g, "\\$&") + "%"}` : sql``}
        ${p.debate?.length ? sql`and s.debate = any(${p.debate})` : sql``}
        ${p.capacity ? sql`and s.speaker_capacity = ${p.capacity}` : sql``}
        ${prox ? sql`and p.seq_vector @@ to_tsquery('simple', ${prox})` : sql``}`;

  const tDb = performance.now();
  const rows = await sql<
    {
      speech_id: string; seq: number; text: string; score: number; speech_date: string; started: Date; started_txt: string;
      member_id: number; member_name: string; type: string; debate: string; matter_cls: string | null; matter_nr: number | null;
      lthing: number; title: string | null; rn: number; n_par: number;
      tok_lemma: string[] | null; tok_start: number[] | null; tok_len: number[] | null;
    }[]
  >`
    with hits as (
      select p.speech_id, p.seq, p.text, s.speech_date::text, s.started, s.started::text as started_txt,
             s.member_id, s.member_name, s.type, s.debate, s.matter_cls, s.matter_nr, s.lthing, m.title,
             (${rank}
               * case s.type when 'ræða' then 1.0 when 'flutningsræða' then 1.0 when 'svar' then 1.0
                             when 'andsvar' then 0.8 when 'grein fyrir atkvæði' then 0.6
                             when 'um atkvæðagreiðslu' then 0.6 when 'um fundarstjórn' then 0.4 else 0.8 end
               * case when s.debate in ('1', '2', '3') then 1.0 else 0.9 end
               * least(1.0, ln(1 + length(p.text) / 6.0) / ln(44.0)) -- one-liners ("Virðulegi forseti.") must not beat substantive paragraphs
               * ${titleBoost}
               * ${exactBoost.length ? exactBoost.reduce((acc, f) => sql`${acc} * ${f}`) : sql`1.0`}
               * case when s.lthing = ${current} then 1.1 else 1.0 end)::float8 as score
      from paragraphs p
      join speeches s on s.id = p.speech_id
      left join matters m on m.lthing = s.lthing and m.cls = s.matter_cls and m.nr = s.matter_nr
      where true ${where()}
    ),
    ranked as (
      select h.*, row_number() over (partition by speech_id order by score desc, seq) as rn,
             count(*) over (partition by speech_id) as n_par
      from hits h
    ),
    best as (
      select speech_id, score, started from ranked
      where rn = 1
        ${cur
          ? newest
            ? sql`and (started, speech_id) < (${cur[1]}::timestamp, ${cur[2]})`
            : oldest
              ? sql`and (started, speech_id) > (${cur[1]}::timestamp, ${cur[2]})`
              : sql`and (score, started, speech_id) < (${cur[0]}::float8, ${cur[1]}::timestamp, ${cur[2]})`
          : sql``}
      ${newest ? sql`order by started desc, speech_id desc` : oldest ? sql`order by started, speech_id` : sql`order by score desc, started desc, speech_id desc`}
      limit ${limit + 1}
    )
    select r.*, t.lemma as tok_lemma, t.start as tok_start, t.len as tok_len
    from ranked r join best b on b.speech_id = r.speech_id
    left join paragraph_tokens t on t.speech_id = r.speech_id and t.seq = r.seq
    where r.rn <= 2
    ${newest ? sql`order by b.started desc, r.speech_id desc, r.rn` : oldest ? sql`order by b.started, r.speech_id, r.rn` : sql`order by b.score desc, b.started desc, r.speech_id desc, r.rn`}`;

  const dbMs = performance.now() - tDb;
  let total: number | undefined;
  if (p.withTotal && !p.cursor) {
    const [c] = await sql<{ n: number }[]>`
      select count(*)::int as n from (
        select distinct p.speech_id from paragraphs p join speeches s on s.id = p.speech_id
        where true ${where()} limit ${TOTAL_CAP + 1}) x`;
    total = c?.n ?? 0;
  }
  const cards = rq
    ? await sql<{ lthing: number; cls: string; nr: number; title: string }[]>`
        select lthing, cls, nr, title from matters m
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
    matterCards: [...cards],
    nextCursor: all.length > limit && last ? enc([last.score, last._startedTxt, last.speechId]) : null,
    hits: page.map(({ _startedTxt, ...h }) => h),
    ...(total !== undefined ? { total: Math.min(total, TOTAL_CAP), totalCapped: total > TOTAL_CAP } : {}),
    ...(browse ? { browse: true } : {}),
  };
}

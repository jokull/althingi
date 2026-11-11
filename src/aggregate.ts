// Aggregates and first-use over speech_index (docs/PERFORMANCE.md §3.2): one group-by over the narrow speech-level table,
// party already resolved on the speech date, dates as pkey ranges, the GIN for the query. Never a pass over `speeches`.
import type { Fragment } from "postgres";
import type { Sql } from "./db.ts";
import { type ParsedQuery, parseQuery } from "./explain.ts";
import { idCeil, idFloor, phraseTsQuery, recallTsQuery } from "./search.ts";

export type GroupBy = "year" | "member" | "party" | "speech_type" | "lthing" | "matter";
export interface AggArgs {
  metric: "speeches" | "words"; group_by: GroupBy;
  q?: string; date_from?: string; date_to?: string; lthing?: number; speech_type?: string; member_id?: number; party_id?: number;
  substantive_only?: boolean; limit?: number;
}
export interface Bucket { key: string; id: number | string | null; name: string | null; n: number }

/** The query conditions on speech_index, plus the paragraph-level recheck that makes multi-word queries exact. */
export function queryConds(sql: Sql, parsed: ParsedQuery | null): { cond: Fragment; exact: boolean } {
  const rq = parsed ? recallTsQuery(parsed) : null;
  const pq = parsed ? phraseTsQuery(parsed) : null;
  if (!rq && !pq) return { cond: sql``, exact: true };
  // speech-level recall: every lemma of the query (phrase lemmas included) somewhere in the speech
  const lex = new Set<string>();
  for (const part of parsed!.parts) { part.lemmas.forEach((l) => lex.add(l)); part.allOf?.flat().forEach((l) => lex.add(l)); }
  const parts = parsed!.parts.filter((x) => x.lemmas.length || x.allOf?.length);
  const speechLevel = rq && !pq && parts.length === 1 ? rq : null;
  const cond = speechLevel
    ? sql`and speech_vec(si.id) @@ to_tsquery('simple', ${speechLevel})`
    // AND of all lexemes at speech level narrows the candidates; the paragraph recheck keeps "same paragraph" semantics
    : sql`and speech_vec(si.id) @@ to_tsquery('simple', ${[...lex].map((l) => `'${l.replace(/'/g, "''").replace(/\\/g, "\\\\")}'`).join(" & ")})
         and exists (select 1 from paragraphs p where p.speech_id = si.id
           ${rq ? sql`and p.search_vector @@ to_tsquery('simple', ${rq})` : sql``}
           ${pq ? sql`and p.seq_vector @@ to_tsquery('simple', ${pq})` : sql``})`;
  return { cond, exact: true };
}

export function filterConds(sql: Sql, a: { date_from?: string; date_to?: string; lthing?: number; speech_type?: string; member_id?: number; party_id?: number; substantive_only?: boolean }): Fragment {
  return sql`
    ${a.date_from ? sql`and si.id >= ${idFloor(a.date_from)}` : sql``}
    ${a.date_to ? sql`and si.id < ${idCeil(a.date_to)}` : sql``}
    ${a.lthing !== undefined ? sql`and si.lthing = ${a.lthing}` : sql``}
    ${a.speech_type ? sql`and si.type = ${a.speech_type}` : sql``}
    ${a.member_id !== undefined ? sql`and si.member_id = ${a.member_id}` : sql``}
    ${a.party_id !== undefined ? sql`and si.party_id = ${a.party_id}` : sql``}
    ${a.substantive_only ? sql`and si.substantive` : sql``}`;
}

export async function aggregateBuckets(sql: Sql, a: AggArgs): Promise<Bucket[]> {
  const parsed = a.q ? parseQuery(a.q) : null;
  const { cond } = queryConds(sql, parsed);
  if (parsed && !recallTsQuery(parsed) && !phraseTsQuery(parsed)) return []; // nothing searchable: no buckets
  const value = a.metric === "words" ? sql`coalesce(sum(si.word_count), 0)::int` : sql`count(*)::int`;
  const limit = Math.min(Math.max(a.limit ?? 50, 1), 500);
  const g = {
    year: { sel: sql`si.year::text as key, si.year as id, null::text as name`, by: sql`si.year`, order: sql`si.year` },
    lthing: { sel: sql`si.lthing::text as key, si.lthing as id, null::text as name`, by: sql`si.lthing`, order: sql`si.lthing` },
    speech_type: { sel: sql`si.type as key, null::int as id, si.type as name`, by: sql`si.type`, order: sql`n desc, key` },
    member: { sel: sql`si.member_id::text || ': ' || si.member_name as key, si.member_id as id, si.member_name as name`, by: sql`si.member_id, si.member_name`, order: sql`n desc, key` },
    party: { sel: sql`coalesce(pt.name, '(óþekktur flokkur)') as key, si.party_id as id, pt.name as name`, by: sql`si.party_id, pt.name`, order: sql`n desc, key` },
    matter: { sel: sql`si.lthing || '/' || si.matter_cls || '/' || si.matter_nr as key, si.lthing || '/' || si.matter_cls || '/' || si.matter_nr as id, m.title as name`, by: sql`si.lthing, si.matter_cls, si.matter_nr, m.title`, order: sql`n desc, key` },
  }[a.group_by];
  return sql<Bucket[]>`
    select ${g.sel}, ${value} as n
    from speech_index si
    ${a.group_by === "party" ? sql`left join parties pt on pt.id = si.party_id` : sql``}
    ${a.group_by === "matter" ? sql`left join matters m on (m.lthing, m.cls, m.nr) = (si.lthing, si.matter_cls, si.matter_nr)` : sql``}
    where true ${a.group_by === "matter" ? sql`and si.matter_cls is not null` : sql``} ${cond} ${filterConds(sql, a)}
    group by ${g.by} order by ${g.order} limit ${limit}`;
}

export interface FirstUse {
  earliest: { speech_id: string; seq: number; started: string; member_id: number | null; member_name: string; type: string; text: string; speech_date: string; lthing: number; html_url: string | null }[];
  years: { year: number; n: number }[];
}

/** Earliest matching paragraphs (exact, paragraph level) and a per-year strip of matching speeches. */
export async function firstUse(sql: Sql, parsed: ParsedQuery, limit = 5): Promise<FirstUse> {
  const rq = recallTsQuery(parsed), pq = phraseTsQuery(parsed);
  const { cond } = queryConds(sql, parsed);
  const lim = Math.min(Math.max(limit, 1), 20);
  // the oldest candidate speeches (ids sort by time) from the materialized GIN result, then their matching paragraphs
  const earliest = await sql<FirstUse["earliest"][number][]>`
    with cand as materialized (select si.id from speech_index si where true ${cond}),
    oldest as (select id from cand order by id limit ${lim * 4})
    select p.speech_id, p.seq, s.started::text, s.member_id, coalesce(s.member_name, s.speaker_abbr, '') as member_name, s.type, p.text, s.speech_date::text, s.lthing, s.html_url
    from oldest o join paragraphs p on p.speech_id = o.id join speeches s on s.id = o.id
    where true ${rq ? sql`and p.search_vector @@ to_tsquery('simple', ${rq})` : sql``} ${pq ? sql`and p.seq_vector @@ to_tsquery('simple', ${pq})` : sql``}
    order by s.started, p.speech_id, p.seq limit ${lim}`;
  const years = await sql<{ year: number; n: number }[]>`
    select si.year, count(*)::int as n from speech_index si where true ${cond} group by si.year order by si.year`;
  return { earliest, years };
}

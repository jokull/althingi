// Did-you-mean and member-name lookup. Candidates come from the corpus itself (vocab view), never from BÍN.
import type { Sql } from "./db.ts";
import { parseQuery } from "./explain.ts";

export interface Suggestion { word: string; suggestions: string[] }

/** For each query word none of whose lemma readings occurs in the corpus, propose the closest corpus words. */
export async function suggest(sql: Sql, q: string): Promise<Suggestion[]> {
  const parsed = parseQuery(q);
  const out: Suggestion[] = [];
  for (const part of parsed.parts) {
    if (part.kind !== "word") continue;
    // "known" is checked against the live index, not the vocab view: vocab is a materialized view that is only as fresh
    // as its last refresh, and a stale one told users "orkuskortur finnst ekki í safninu" above eight hits.
    const lex = [...part.lemmas, ...(part.allOf ?? []).flat()];
    const tq = lex.map((l) => `'${l.replace(/'/g, "''").replace(/\\/g, "\\\\")}'`).join(" | ");
    const known = await sql`select 1 from vocab where word = any(${lex}) limit 1`;
    if (known.length) continue;
    // count, not `limit 1`: with LIMIT the planner seq-scans ~1M paragraphs hoping for an early match, and for a word
    // that is nowhere that scan runs to the end (statement timeout, 2026-11-11). Without it, the GIN index answers.
    // Only words missing from vocab get here, so the count is small.
    if (tq) {
      const [row] = await sql<{ n: number }[]>`select count(*)::int n from paragraphs where search_vector @@ to_tsquery('simple', ${tq})`;
      if ((row?.n ?? 0) > 0) continue;
    }
    const word = part.lemmas[0] ?? "";
    const near = await sql<{ word: string }[]>`
      select word from vocab
      where word % ${word} and similarity(word, ${word}) >= 0.3
      order by similarity(word, ${word}) desc, ndoc desc
      limit 3`;
    out.push({ word, suggestions: near.map((r) => r.word) });
  }
  return out;
}

export interface MemberMatch { id: number; name: string; score: number }

/** Names matching the query (trigram similarity). The web layer routes only a single clear winner. */
export async function findMembers(sql: Sql, q: string, limit = 5): Promise<MemberMatch[]> {
  const s = q.trim().slice(0, 100);
  if (s.length < 4 || !/\p{L}+\s+\p{L}+/u.test(s)) return []; // a name has at least two parts
  return sql<MemberMatch[]>`
    select id, name, similarity(name, ${s})::float8 as score from members
    where name % ${s} order by score desc, id limit ${limit}`;
}

/** A confident single member: top score >= 0.55 and clearly ahead of the runner-up. */
export function clearWinner(m: MemberMatch[]): MemberMatch | null {
  const [a, b] = m;
  if (!a || a.score < 0.55) return null;
  return !b || a.score - b.score >= 0.15 ? a : null;
}

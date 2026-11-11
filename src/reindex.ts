// Re-derive lemma_text, lemma_seq and paragraph_tokens from the stored paragraph text. No recrawl, ever.
// Targets paragraphs whose token row is missing or was built by another lemma-is version; newest speeches first.
import type { Sql } from "./db.ts";
import { writeTokens } from "./db.ts";
import { analyze, lemmaVersion } from "./lemma.ts";

export interface ReindexStats { paragraphs: number; speechesMarked: number; version: string }

export async function reindex(sql: Sql, opts: { batch?: number; limit?: number; log?: (s: string) => void } = {}): Promise<ReindexStats> {
  const version = lemmaVersion();
  const batch = opts.batch ?? 2000;
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  let done = 0;
  while (done < limit) {
    const rows = await sql<{ speech_id: string; seq: number; text: string }[]>`
      select p.speech_id, p.seq, p.text
      from paragraphs p
      join speeches s on s.id = p.speech_id
      left join paragraph_tokens t on t.speech_id = p.speech_id and t.seq = p.seq
      where t.speech_id is null or t.lemma_is_version <> ${version}
      order by s.started desc, p.speech_id, p.seq
      limit ${Math.min(batch, limit - done)}`;
    if (rows.length === 0) break;
    const out = rows.map((r) => ({ r, a: analyze(r.text) }));
    await sql.begin(async (tx) => {
      await tx`
        update paragraphs p set lemma_text = v.lt, lemma_parts = v.lp, lemma_seq = v.ls
        from unnest(${out.map((o) => o.r.speech_id)}::text[], ${out.map((o) => o.r.seq)}::int[],
                    ${out.map((o) => o.a.lemmaText)}::text[], ${out.map((o) => o.a.lemmaParts)}::text[],
                    ${out.map((o) => o.a.lemmaSeq)}::text[]) as v(sid, sq, lt, lp, ls)
        where p.speech_id = v.sid and p.seq = v.sq`;
      await writeTokens(tx, out.map((o) => ({ speechId: o.r.speech_id, seq: o.r.seq, tokens: o.a.tokens })), version);
    });
    done += rows.length;
    opts.log?.(`reindex: ${done} paragraphs`);
  }
  const marked = await sql`
    update speeches s set lemma_is_version = ${version}
    where s.text_state = 'done' and s.lemma_is_version is distinct from ${version}
      and not exists (
        select 1 from paragraphs p left join paragraph_tokens t on t.speech_id = p.speech_id and t.seq = p.seq
        where p.speech_id = s.id and (t.speech_id is null or t.lemma_is_version <> ${version}))
    returning s.id`;
  return { paragraphs: done, speechesMarked: marked.length, version };
}

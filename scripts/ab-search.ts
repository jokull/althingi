#!/usr/bin/env bun
// Print the top N speech hits for each query as JSON lines — for blind A/B judging of index/lemmatizer variants.
// Usage: DATABASE_URL=… bun scripts/ab-search.ts [--n 10] "query one" "query two" …
import { parseArgs } from "node:util";
import { connect } from "../src/db.ts";
import { lemmaVersion } from "../src/lemma.ts";
import { search } from "../src/search.ts";

const { values: v, positionals } = parseArgs({ options: { n: { type: "string" } }, allowPositionals: true });
const sql = connect();
try {
  const [cur] = await sql<{ l: number }[]>`select max(lthing) as l from speeches`;
  for (const q of positionals) {
    const r = await search(sql, { q, limit: Number(v.n ?? 10), currentLthing: cur?.l ?? 0 });
    console.log(JSON.stringify({
      q, lemma: lemmaVersion(), parsed: r.query.description,
      hits: r.hits.map((h, i) => ({
        rank: i + 1, speechId: h.speechId, member: h.memberName, matter: h.matter?.title ?? null,
        paragraphs: h.paragraphs.map((p) => ({ seq: p.seq, text: p.snippets[0]?.text ?? "" })),
      })),
    }));
  }
} finally {
  await sql.end();
}

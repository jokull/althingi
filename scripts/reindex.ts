#!/usr/bin/env bun
// bun scripts/reindex.ts [--limit N] [--batch N]  — see src/reindex.ts. Safe to run while the web app is up; not while a crawler writes the same rows.
import { parseArgs } from "node:util";
import { connect, migrate } from "../src/db.ts";
import { reindex } from "../src/reindex.ts";

const { values: v } = parseArgs({ options: { limit: { type: "string" }, batch: { type: "string" } } });
const sql = connect();
try {
  await migrate(sql);
  const t0 = Date.now();
  const s = await reindex(sql, {
    limit: v.limit ? Number(v.limit) : undefined,
    batch: v.batch ? Number(v.batch) : undefined,
    log: (l) => console.log(`${new Date().toISOString().slice(11, 19)} ${l}`),
  });
  console.log(`done: ${s.paragraphs} paragraphs, ${s.speechesMarked} speeches marked as ${s.version} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const size = await sql`
    select pg_size_pretty(pg_total_relation_size('paragraphs')) as paragraphs,
           pg_size_pretty(pg_total_relation_size('paragraph_tokens')) as tokens,
           pg_size_pretty(pg_database_size(current_database())) as database,
           (select count(*)::int from speeches where text_state = 'done') as speeches_done`;
  console.table(size);
} finally {
  await sql.end();
}

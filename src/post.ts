// Post-ingest hooks (docs/INGEST.md §5, docs/PERFORMANCE.md §3.3): the speech-level index reconciliation, the corpus
// state row, the vocab MV refresh, a hook for sitemaps/cache purge, the run's close.
import type { Sql } from "./db.ts";
import { refreshCorpusState, refreshSpeechIndex, setState } from "./db.ts";

/**
 * - speech_index: rows missing or older than their speech's text (saveSpeechText writes them in its own transaction,
 *   so this catches reindexes and anything written by older code), then the whole current session (party, member and
 *   type fixes from `derive` do not touch fetched_at). Batches of 500 ids; a session is ~2.5k rows, < 2 s.
 * - corpus_state_refresh(): the one row the web layer reads (counts, dates, sessions, complete flags, version).
 * - `refresh materialized view concurrently vocab` (nightly and after a dump drop; not per poll). Falls back to a plain
 *   refresh when the MV has never been populated (concurrently refuses that).
 * - marks sitemaps dirty in ingest_state (there is no sitemap generator yet; whatever builds them reads this key) and runs
 *   $POST_INGEST_HOOK (e.g. a `cf cache purge` wrapper) with the run id as its argument, when set.
 */
export async function post(sql: Sql, o: { runId: number; log: (s: string) => void; refreshVocab: boolean }): Promise<void> {
  const t0 = Date.now();
  let n = 0;
  for (;;) {
    const stale = (await sql<{ id: string }[]>`select speech_index_stale(500) as id`).map((r) => r.id);
    if (!stale.length) break;
    n += await refreshSpeechIndex(sql, stale);
    if (stale.length < 500) break;
  }
  const [cur] = await sql<{ l: number | null }[]>`select max(lthing) as l from speeches where text_state = 'done'`;
  if (cur?.l) {
    const ids = (await sql<{ id: string }[]>`select id from speeches where lthing = ${cur.l} and text_state = 'done'`).map((r) => r.id);
    for (let i = 0; i < ids.length; i += 500) n += await refreshSpeechIndex(sql, ids.slice(i, i + 500));
  }
  o.log(`post: speech_index ${n} rows refreshed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (o.refreshVocab) {
    const t1 = Date.now();
    try { await sql`refresh materialized view concurrently vocab`; }
    catch { await sql`refresh materialized view vocab`; }
    o.log(`post: vocab refreshed in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
  }
  o.log(`post: corpus_state version ${await refreshCorpusState(sql)}`);
  await setState(sql, "sitemaps_dirty_since_run", o.runId);
  const hook = process.env.POST_INGEST_HOOK;
  if (hook) {
    const p = Bun.spawnSync([hook, String(o.runId)], { stdout: "inherit", stderr: "inherit" });
    o.log(`post: hook ${hook} exited ${p.exitCode}`);
  }
}

/**
 * One-off: build speech_index for every speech with text, newest session first, 500 ids per statement (each a short
 * transaction beside the live site). Re-running only touches rows that are missing or stale unless `force`.
 */
export async function backfillSpeechIndex(sql: Sql, o: { log: (s: string) => void; force?: boolean; from?: number; to?: number }): Promise<number> {
  const sessions = await sql<{ lthing: number }[]>`
    select distinct lthing from speeches where text_state = 'done'
      ${o.from !== undefined ? sql`and lthing >= ${o.from}` : sql``} ${o.to !== undefined ? sql`and lthing <= ${o.to}` : sql``}
    order by lthing desc`;
  let total = 0;
  for (const { lthing } of sessions) {
    const t0 = Date.now();
    const ids = (await sql<{ id: string }[]>`
      select s.id from speeches s ${o.force ? sql`` : sql`left join speech_index si on si.id = s.id`}
      where s.lthing = ${lthing} and s.text_state = 'done' ${o.force ? sql`` : sql`and (si.id is null or si.built_at < s.fetched_at)`}
      order by s.started desc`).map((r) => r.id);
    let n = 0;
    for (let i = 0; i < ids.length; i += 500) n += await refreshSpeechIndex(sql, ids.slice(i, i + 500));
    total += n;
    if (ids.length) o.log(`backfill ${lthing}: ${n} rows in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  o.log(`backfill: corpus_state version ${await refreshCorpusState(sql)}`);
  return total;
}

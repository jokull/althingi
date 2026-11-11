// Post-ingest hooks (docs/INGEST.md §5): vocab MV refresh, a hook for sitemaps/cache purge, the run's close.
import type { Sql } from "./db.ts";
import { setState } from "./db.ts";

/**
 * - `refresh materialized view concurrently vocab` (nightly and after a dump drop; not per poll). Falls back to a plain
 *   refresh when the MV has never been populated (concurrently refuses that).
 * - marks sitemaps dirty in ingest_state (there is no sitemap generator yet; whatever builds them reads this key) and runs
 *   $POST_INGEST_HOOK (e.g. a `cf cache purge` wrapper) with the run id as its argument, when set.
 */
export async function post(sql: Sql, o: { runId: number; log: (s: string) => void; refreshVocab: boolean }): Promise<void> {
  if (o.refreshVocab) {
    const t0 = Date.now();
    try { await sql`refresh materialized view concurrently vocab`; }
    catch { await sql`refresh materialized view vocab`; }
    o.log(`post: vocab refreshed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  await setState(sql, "sitemaps_dirty_since_run", o.runId);
  const hook = process.env.POST_INGEST_HOOK;
  if (hook) {
    const p = Bun.spawnSync([hook, String(o.runId)], { stdout: "inherit", stderr: "inherit" });
    o.log(`post: hook ${hook} exited ${p.exitCode}`);
  }
}

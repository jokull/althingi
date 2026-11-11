// The corpus in one row (docs/PERFORMANCE.md §3.1/§3.4): counts, date range, per-session state, and a version that
// changes on every ingest `post`. Written by corpus_state_refresh() (sql/0008); the request path only ever READS it —
// through this module, which refreshes it off the request path every 30 s and serves the last good copy on error.
import type { Sql } from "./db.ts";

export interface SessionInfo {
  lthing: number; period: string | null; starts: string | null; ends: string | null;
  done: number; pending: number; unavailable: number; first_date: string | null; last_date: string | null; complete: boolean;
}
export interface CorpusState {
  version: number; speechesDone: number; from: string | null; to: string | null; lastIngest: Date | null;
  firstLthing: number; currentLthing: number;
  /** newest first */
  sessions: SessionInfo[];
  complete: Set<number>;
  updatedAt: Date | null;
}

const EMPTY: CorpusState = { version: 0, speechesDone: 0, from: null, to: null, lastIngest: null, firstLthing: 0, currentLthing: 0, sessions: [], complete: new Set(), updatedAt: null };

/** One pkey read; no aggregation. */
export async function readCorpusState(sql: Sql): Promise<CorpusState> {
  const [r] = await sql<{ version: string; speeches_done: number; date_from: string | null; date_to: string | null; last_ingest: Date | null; first_lthing: number | null; current_lthing: number | null; sessions: SessionInfo[]; updated_at: Date }[]>`
    select version, speeches_done, date_from::text, date_to::text, last_ingest, first_lthing, current_lthing, sessions, updated_at from corpus_state where id = 1`;
  if (!r) return EMPTY;
  return {
    version: Number(r.version), speechesDone: r.speeches_done, from: r.date_from, to: r.date_to, lastIngest: r.last_ingest,
    firstLthing: r.first_lthing ?? 0, currentLthing: r.current_lthing ?? 0, sessions: r.sessions,
    complete: new Set(r.sessions.filter((s) => s.complete).map((s) => s.lthing)), updatedAt: r.updated_at,
  };
}

const REFRESH_MS = 30_000;
const cache = new WeakMap<Sql, { state: CorpusState; at: number; inflight: Promise<CorpusState> | null }>();

/**
 * The cached state for this pool. The first call reads synchronously (one row); later calls return the copy at hand and
 * kick off a background refresh when it is older than 30 s. A failed refresh keeps the last good copy.
 */
export async function corpusState(sql: Sql): Promise<CorpusState> {
  let e = cache.get(sql);
  if (!e) {
    const state = await readCorpusState(sql);
    e = { state, at: Date.now(), inflight: null };
    cache.set(sql, e);
    return state;
  }
  if (Date.now() - e.at > REFRESH_MS && !e.inflight) {
    const c = e;
    c.inflight = readCorpusState(sql).then((s) => { c.state = s; c.at = Date.now(); return s; })
      .catch(() => c.state).finally(() => { c.inflight = null; });
  }
  return e.state;
}

/** Forget the cached copy (tests, and right after an ingest in the same process). */
export function resetCorpusState(sql: Sql): void { cache.delete(sql); }

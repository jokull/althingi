// XML service steps (L1–L3 of docs/INGEST.md). Network steps are filled in by the service phase.
import { existsSync, readFileSync } from "node:fs";
import { type Sql, upsertSpeechIndex } from "./db.ts";
import { lemmaText } from "./lemma.ts";
import { parseMatterDetail, parseSpeechList } from "./parse.ts";

/**
 * Zero requests: re-read matter details and speech lists already in the raw cache and record their speaker sightings
 * (member ids for non-MP ministers, vod links). This is how the mini learns DMK = 1448 from its 805 cached details.
 */
export async function replayRaw(sql: Sql, log: (s: string) => void = () => {}): Promise<number> {
  const rows = await sql<{ url: string; path: string }[]>`
    select url, path from raw_fetch where status = 200 and path is not null
      and (url like '%/thingmalalisti/thingmal/%' or url like '%/raedulisti/%' or url like '%/thingmadur/raedur/%')`;
  let n = 0;
  for (const r of rows) {
    if (!existsSync(r.path)) continue;
    const xml = readFileSync(r.path, "utf8");
    const entries = r.url.includes("/thingmal/") ? parseMatterDetail(xml).speeches : parseSpeechList(xml);
    const source = r.url.includes("/thingmal/") ? "matter-detail" : r.url.includes("dagur=") ? "day-list" : r.url.includes("/raedulisti/") ? "matter-speeches" : "member-list";
    n += await upsertSpeechIndex(sql, entries, lemmaText, source);
  }
  log(`replay: ${rows.length} cached service files re-read, ${n} new index rows`);
  return n;
}

export async function runService(_sql: Sql, step: string | undefined, _o: unknown): Promise<{ requests: number; files: number; rows: number }> {
  throw new Error(`service ${step}: not implemented yet`);
}

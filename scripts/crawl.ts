#!/usr/bin/env bun
// Resumable, polite crawler for the Alþingi XML service — kept as thin aliases over src/service.ts
// (the layered driver is scripts/ingest.ts; docs/INGEST.md §5). Same commands and flags as before:
//   bun scripts/crawl.ts reference --from 157 --to 157      sessions, members, matter lists
//   bun scripts/crawl.ts index     --from 157 --to 157      per-member speech lists -> speech index rows (queue)
//   bun scripts/crawl.ts seats     --from 157 --to 157      per-member seat history (party over time)
//   bun scripts/crawl.ts text [--from-date D --to-date D] [--lthing N] [--limit N]   fetch + ingest speech texts
//   bun scripts/crawl.ts matters   --lthing N [--limit N]   A-mál detail: status, documents, votes+counts, consultations, submissions, links
//   bun scripts/crawl.ts committees --from N --to N          committee lists per session
//   bun scripts/crawl.ts status
// Raw bodies are written to $RAW_DIR (default ~/althingi/raw) BEFORE parsing, so parser fixes replay without recrawl.
import { parseArgs } from "node:util";
import { connect, migrate, tryCrawlLock } from "../src/db.ts";
import { Blocked, Fetcher, RateLimited } from "../src/fetcher.ts";
import { ServiceClient, lists, matters, members, reconcile, texts } from "../src/service.ts";

const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { stopping = true; log(`${sig}: finishing the current request, then stopping`); });
}

const { positionals, values: v } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: "string" }, to: { type: "string" },
    lthing: { type: "string" },
    "from-date": { type: "string" }, "to-date": { type: "string" },
    limit: { type: "string" },
    "max-age-hours": { type: "string" },
  },
});
const cmd = positionals[0];
const fromL = Number(v.from ?? v.lthing ?? 157);
const toL = Number(v.to ?? v.lthing ?? fromL);
const maxAgeMs = v["max-age-hours"] ? Number(v["max-age-hours"]) * 3_600_000 : Number.POSITIVE_INFINITY;

const sql = connect();
const fetcher = new Fetcher({ log });
const client = new ServiceClient(sql, undefined, fetcher);
const o = { ...v, log, stopping: () => stopping, "max-age-hours": v["max-age-hours"] ?? String(Number.POSITIVE_INFINITY) };

async function status() {
  const by = await sql`select text_state, count(*)::int n from speeches group by 1 order by 1`;
  const pend = Number(by.find((r) => r.text_state === "pending")?.n ?? 0);
  console.table(by);
  const per = await sql`select lthing, count(*)::int speeches, count(*) filter (where text_state='done')::int done from speeches group by 1 order by 1 desc limit 10`;
  console.table(per);
  console.log(`pending: ${pend} speeches ≈ ${(pend * 5.3 / 86400).toFixed(1)} days at 5 s/request`);
}

try {
  if (!cmd || !["reference", "index", "seats", "text", "matters", "committees", "status"].includes(cmd)) {
    console.error("usage: crawl.ts reference|index|seats|text|matters|committees|status [--from N --to N] [--lthing N] [--from-date D --to-date D] [--limit N] [--max-age-hours H]");
    process.exit(2);
  }
  await migrate(sql);
  if (cmd !== "status") {
    if (!(await tryCrawlLock(sql))) { console.error("another crawler holds the lock; refusing to run two"); process.exit(3); }
    log(`${cmd}: UA=${process.env.CRAWL_UA ?? "althingi-search/0.1 (jokull@solberg.is)"} raw=${client.rawDir}`);
  }
  if (cmd === "reference") await lists(client, fromL, toL, { ...o, only: ["sessions", "members", "matters"] });
  if (cmd === "index") await reconcile(client, fromL, toL, { ...o, maxAgeMs });
  if (cmd === "seats") await members(client, fromL, toL, { ...o, all: true });
  if (cmd === "text") await texts(client, o);
  if (cmd === "matters") await matters(client, fromL, toL, o);
  if (cmd === "committees") await lists(client, fromL, toL, { ...o, only: ["committees"] });
  if (cmd === "status") await status();
} catch (e) {
  if (e instanceof Blocked) { console.error(`STOPPED: ${e.message}`); process.exitCode = 4; }
  else if (e instanceof RateLimited) { console.error(`STOPPED: ${e.message}`); process.exitCode = 5; }
  else throw e;
} finally {
  log(`done after ${fetcher.requests} requests`);
  await sql.end();
}

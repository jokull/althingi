#!/usr/bin/env bun
// Layered ingest driver (docs/INGEST.md §5). Every step is idempotent and resumable; every run writes an ingest_runs row.
//
//   bun scripts/ingest.ts dump hash     --drop PATH [--from N --to N]   hash files into dump_files (new/changed are queued)
//   bun scripts/ingest.ts dump speeches [--from N --to N] [--limit N]   raedur/ then raedur_bradabirgda/ (sha no-op)
//   bun scripts/ingest.ts dump sittings [--from N --to N]               fundir/, dagskra/, lidaskjol/
//   bun scripts/ingest.ts dump misc     [--from N --to N]               utbyting/, fjarvist(ir)/, inn/
//   bun scripts/ingest.ts dump drop     --drop PATH [--from N --to N]   all of the above, then derive and post
//   bun scripts/ingest.ts derive [--replay-raw]                          aliases, member ids, reply_to_id (zero requests)
//   bun scripts/ingest.ts post                                          vocab MV refresh, post-ingest hook
//   bun scripts/ingest.ts service lists|members|matters|texts|poll|index …   XML service (crawl lock, 5 s)
//   bun scripts/ingest.ts laws [--zip PATH]                             lagasafn: parse a local zip, or conditional GET
//   bun scripts/ingest.ts status
// Dump, derive and laws steps never take the crawl lock: they run beside the crawler. Exit codes: 3 lock held,
// 4 blocked (403/challenge), 5 rate limited (429), 6 crawl paused.
import { parseArgs } from "node:util";
import { type LockName, type Sql, connect, finishRun, migrate, startRun, tryLock } from "../src/db.ts";
import { derive, unresolvedSpeakers } from "../src/derive.ts";
import { type Filter, type StepResult, dumpMisc, dumpSittings, dumpSpeeches, hashDrop } from "../src/dump-ingest.ts";
import { Blocked, RateLimited } from "../src/fetcher.ts";
import { post } from "../src/post.ts";
import { runService } from "../src/service.ts";
import { runLaws } from "../src/laws-ingest.ts";

const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

const { positionals, values: v } = parseArgs({
  allowPositionals: true,
  options: {
    drop: { type: "string" }, from: { type: "string" }, to: { type: "string" }, lthing: { type: "string" },
    limit: { type: "string" }, "replay-raw": { type: "boolean" }, zip: { type: "string" },
    "from-date": { type: "string" }, "to-date": { type: "string" }, "max-age-hours": { type: "string" },
    weekly: { type: "boolean" }, touched: { type: "boolean" }, provisional: { type: "boolean" }, date: { type: "string" },
  },
});
const [group, sub] = positionals;
const f: Filter = {
  from: v.from ?? v.lthing ? Number(v.from ?? v.lthing) : undefined,
  to: v.to ?? v.lthing ? Number(v.to ?? v.lthing) : undefined,
};

const USAGE = "usage: ingest.ts dump hash|speeches|sittings|misc|drop | derive | post | service lists|members|matters|texts|poll|index | laws | status";

const sql = connect();
let runId = 0;
let requests = 0;

function report(name: string, r: StepResult) {
  const notes = Object.entries(r.notes).map(([k, n]) => `${k}=${n}`).join(", ");
  log(`${name}: ${r.files} files, ${r.rows} rows written, ${r.skipped} skipped, ${r.errors} errors${notes ? ` (${notes})` : ""}`);
}

async function locked<T>(name: LockName, fn: () => Promise<T>): Promise<T> {
  if (!(await tryLock(sql, name))) { console.error(`the ${name} lock is held by another process; refusing to run two`); process.exit(3); }
  return fn();
}

async function dump(step: string | undefined, sqlc: Sql): Promise<{ files: number; rows: number }> {
  let files = 0, rows = 0;
  const add = (name: string, r: StepResult) => { report(name, r); files += r.files; rows += r.rows; };
  if (step === "hash" || step === "drop") {
    if (!v.drop) { console.error("--drop PATH is required"); process.exit(2); }
    const h = await hashDrop(sqlc, v.drop, f, log);
    log(`dump hash: drop ${h.dropId}${h.reused ? " (unchanged tree, reused)" : ""}, ${h.files} files, ${h.changed} queued`);
    files += h.changed;
  }
  if (step === "speeches" || step === "drop") add("dump speeches", await dumpSpeeches(sqlc, f, log, { limit: v.limit ? Number(v.limit) : undefined }));
  // misc before sittings: utbyting's documents name the matter of the rare vote whose lid file has no <mál>
  if (step === "misc" || step === "drop") add("dump misc", await dumpMisc(sqlc, f, log));
  if (step === "sittings" || step === "drop") add("dump sittings", await dumpSittings(sqlc, f, log));
  return { files, rows };
}

async function status() {
  console.table(await sql`select lthing, count(*)::int speeches, count(*) filter (where text_state = 'done')::int done,
    count(*) filter (where member_id is null)::int unresolved, count(*) filter (where provisional)::int provisional
    from speeches group by 1 order by 1 desc limit 12`);
  console.table(await sql`select dir, count(*)::int files, count(*) filter (where parsed_at is null)::int queued from dump_files group by 1 order by 1`);
  console.table(await sql`select id, kind, started, finished, status, requests, files, rows from ingest_runs order by id desc limit 8`);
  log(`unresolved speakers: ${await unresolvedSpeakers(sql)}`);
}

let status_ = "ok";
let note: string | null = null;
try {
  if (!group || !["dump", "derive", "post", "service", "laws", "status"].includes(group)) { console.error(USAGE); process.exit(2); }
  await migrate(sql);
  if (group === "status") { await status(); }
  else {
    runId = await startRun(sql, [group, sub].filter(Boolean).join(" "));
    let files = 0, rows = 0;
    if (group === "dump") {
      ({ files, rows } = await locked("dump", () => dump(sub, sql)));
      if (sub === "drop") {
        const c = await locked("derive", () => derive(sql, log));
        rows += Object.values(c).reduce((a, b) => a + b, 0);
        await post(sql, { runId, log, refreshVocab: true });
      }
    } else if (group === "derive") {
      const c = await locked("derive", async () => {
        if (v["replay-raw"]) {
          const { replayRaw } = await import("../src/service.ts");
          rows += await replayRaw(sql, log);
        }
        return derive(sql, log);
      });
      rows += Object.values(c).reduce((a, b) => a + b, 0);
      log(`derive: ${rows} rows written; unresolved speakers ${await unresolvedSpeakers(sql)}`);
    } else if (group === "post") {
      await post(sql, { runId, log, refreshVocab: true });
    } else if (group === "service") {
      const r = await locked("crawl", () => runService(sql, sub, { ...v, filter: f, log }));
      requests = r.requests; files = r.files; rows = r.rows;
    } else if (group === "laws") {
      const r = await locked("laws", () => runLaws(sql, { zip: v.zip, log }));
      requests = r.requests; files = r.files; rows = r.rows;
    }
    await finishRun(sql, runId, { status: status_, requests, files, rows });
  }
} catch (e) {
  if (e instanceof Blocked) { status_ = "blocked"; note = e.message; process.exitCode = 4; }
  else if (e instanceof RateLimited) { status_ = "rate-limited"; note = e.message; process.exitCode = 5; }
  else if ((e as Error).name === "CrawlPaused") { status_ = "paused"; note = (e as Error).message; process.exitCode = 6; }
  else { status_ = "error"; note = (e as Error).stack ?? String(e); process.exitCode = 1; }
  console.error(`STOPPED: ${(e as Error).message}`);
  if (runId) await finishRun(sql, runId, { status: status_, requests, note }).catch(() => {});
} finally {
  await sql.end();
}

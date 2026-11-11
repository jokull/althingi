#!/usr/bin/env bun
// Resumable, polite crawler for the Alþingi XML service.
//   bun scripts/crawl.ts reference --from 157 --to 157      sessions, members, matter lists
//   bun scripts/crawl.ts index     --from 157 --to 157      per-member speech lists -> speech index rows (queue)
//   bun scripts/crawl.ts seats     --from 157 --to 157      per-member seat history (party over time)
//   bun scripts/crawl.ts text [--from-date D --to-date D] [--lthing N] [--limit N]   fetch + ingest speech texts
//   bun scripts/crawl.ts matters   --lthing N [--limit N]   A-mál detail: status, documents, votes+counts, consultations, submissions, links
//   bun scripts/crawl.ts committees --from N --to N          committee lists per session
//   bun scripts/crawl.ts status
// Raw bodies are written to $RAW_DIR (default ~/althingi/raw) BEFORE parsing, so parser fixes replay without recrawl.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  connect, markSpeechError, matterDetailQueue, upsertCommittees, upsertMatterDetail, migrate, nextPending, recordFetch, recordedFetch, tryCrawlLock,
  upsertMatters, upsertMembers, upsertSeats, upsertSessions, upsertSpeechIndex,
} from "../src/db.ts";
import { Blocked, Fetcher, RateLimited, normalizeUrl } from "../src/fetcher.ts";
import { ingestSpeechXml, sha256 } from "../src/ingest.ts";
import { lemmaText } from "../src/lemma.ts";
import { parseCommittees, parseMatterDetail, parseMatterList, parseMembers, parseSeats, parseSessions, parseSpeechList } from "../src/parse.ts";

const BASE = "https://www.althingi.is/altext/xml";
const RAW_DIR = process.env.RAW_DIR ?? join(homedir(), "althingi", "raw");
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

/** Fetch `url` unless we already hold a fresh-enough 200 on disk. Returns the body, or null on 404. */
async function cached(url: string, relPath: string, ageMs = maxAgeMs): Promise<string | null> {
  const norm = normalizeUrl(url);
  const rec = await recordedFetch(sql, norm);
  if (rec?.status === 404 && Date.now() - rec.fetched_at.getTime() < ageMs) return null;
  if (rec?.status === 200 && rec.path && existsSync(rec.path) && Date.now() - rec.fetched_at.getTime() < ageMs) {
    return readFileSync(rec.path, "utf8");
  }
  const r = await fetcher.get(norm);
  if (r.status === 404) {
    await recordFetch(sql, { url: norm, status: 404, bytes: 0, sha256: null, path: null });
    return null;
  }
  if (r.status !== 200) throw new Error(`unexpected ${r.status} for ${norm}`);
  const path = join(RAW_DIR, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, r.body);
  await recordFetch(sql, { url: norm, status: 200, bytes: r.bytes, sha256: sha256(r.body), path });
  return r.body;
}

/**
 * XML_MIRROR: an unpacked copy of Alþingi's bulk export (butar.althingi.is/altext/althingistidindi/xmlfiles.zip,
 * pointed to by Alþingi staff, 2026-11-11), laid out `<lthing>/raedur/radYYYYMMDDTHHMMSS.xml`. Files are byte-identical
 * to the XML service's speech files, so a hit replaces one request. Only final texts (`raedur/`), never
 * `raedur_bradabirgda/` (provisional).
 */
const MIRROR = process.env.XML_MIRROR;
let mirrorHits = 0;
function fromMirror(xmlUrl: string): string | null {
  if (!MIRROR) return null;
  const m = /^\/xml\/(\d+)\/raedur\/(rad\d{8}T\d{6}\.xml)$/.exec(new URL(xmlUrl).pathname);
  const p = m && join(MIRROR, m[1]!, "raedur", m[2]!);
  if (!p || !existsSync(p)) return null;
  const body = readFileSync(p, "utf8");
  if (!body.includes("<ræða")) return null; // not a speech file: fall back to the service
  if (++mirrorHits % 1000 === 0) log(`text: ${mirrorHits} read from the local mirror`);
  return body;
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

async function memberIds(): Promise<number[]> {
  const ids = new Set<number>();
  for (const n of range(fromL, toL)) {
    const xml = await cached(`${BASE}/thingmenn/?lthing=${n}`, `lists/thingmenn_${n}.xml`);
    if (xml) for (const m of parseMembers(xml)) ids.add(m.id);
  }
  return [...ids].sort((a, b) => b - a);
}

async function reference() {
  const s = await cached(`${BASE}/loggjafarthing/`, "lists/loggjafarthing.xml");
  if (s) await upsertSessions(sql, parseSessions(s));
  for (const n of range(fromL, toL)) {
    if (stopping) return;
    const m = await cached(`${BASE}/thingmenn/?lthing=${n}`, `lists/thingmenn_${n}.xml`);
    if (m) await upsertMembers(sql, parseMembers(m));
    const l = await cached(`${BASE}/thingmalalisti/?lthing=${n}`, `lists/thingmalalisti_${n}.xml`);
    if (l) await upsertMatters(sql, parseMatterList(l));
    log(`reference: session ${n} done (${fetcher.requests} requests)`);
  }
}

async function indexSpeeches() {
  const ids = await memberIds();
  log(`index: ${ids.length} members for sessions ${fromL}-${toL}`);
  let added = 0;
  for (const [i, id] of ids.entries()) {
    if (stopping) break;
    const xml = await cached(`${BASE}/thingmenn/thingmadur/raedur/?nr=${id}`, `lists/raedur_member_${id}.xml`);
    if (!xml) continue;
    const entries = parseSpeechList(xml).filter((e) => e.lthing >= fromL && e.lthing <= toL);
    added += await upsertSpeechIndex(sql, entries);
    if ((i + 1) % 10 === 0 || i + 1 === ids.length) log(`index: ${i + 1}/${ids.length} members, +${added} new speeches queued`);
  }
}

async function seats() {
  const ids = await memberIds();
  for (const [i, id] of ids.entries()) {
    if (stopping) break;
    const xml = await cached(`${BASE}/thingmenn/thingmadur/thingseta/?nr=${id}`, `lists/thingseta_${id}.xml`);
    if (xml) await upsertSeats(sql, parseSeats(xml));
    if ((i + 1) % 20 === 0 || i + 1 === ids.length) log(`seats: ${i + 1}/${ids.length} members`);
  }
}

async function text() {
  const limit = v.limit ? Number(v.limit) : Number.POSITIVE_INFINITY;
  const filter = { lthing: v.lthing ? Number(v.lthing) : undefined, from: v["from-date"], to: v["to-date"] };
  let done = 0, failed = 0;
  const t0 = Date.now();
  while (!stopping && done + failed < limit) {
    const batch = await nextPending(sql, Math.min(50, limit - done - failed), filter);
    if (batch.length === 0) { log("text: queue empty"); break; }
    for (const sp of batch) {
      if (stopping || done + failed >= limit) break;
      try {
        // speech files never change once published: cache forever. A local copy of Alþingi's own bulk export wins.
        const xml = fromMirror(sp.xml_url) ?? await cached(sp.xml_url, `speeches/${sp.lthing}/${sp.id}.xml`, Number.POSITIVE_INFINITY);        if (xml === null) { await markSpeechError(sql, sp.id, "404"); failed++; continue; }
        await ingestSpeechXml(sql, sp.id, xml);
        done++;
      } catch (e) {
        if (e instanceof Blocked || e instanceof RateLimited) throw e;
        await markSpeechError(sql, sp.id, (e as Error).message);
        failed++;
        log(`text: ${sp.id} failed: ${(e as Error).message}`);
      }
      if ((done + failed) % 25 === 0) {
        const rate = (done + failed) / ((Date.now() - t0) / 1000);
        log(`text: ${done} ok, ${failed} failed, ${rate.toFixed(2)} speeches/s`);
      }
    }
  }
  log(`text: finished — ${done} ok, ${failed} failed`);
}

async function matters() {
  const limit = v.limit ? Number(v.limit) : Number.POSITIVE_INFINITY;
  let done = 0;
  for (const lthing of range(fromL, toL)) {
    while (!stopping && done < limit) {
      const batch = await matterDetailQueue(sql, lthing, Math.min(50, limit - done));
      if (batch.length === 0) break;
      for (const { nr } of batch) {
        if (stopping || done >= limit) break;
        const xml = await cached(`${BASE}/thingmalalisti/thingmal/?lthing=${lthing}&malnr=${nr}`, `matters/${lthing}/${nr}.xml`, Number.POSITIVE_INFINITY);
        if (xml === null) { await sql`update matters set detail_fetched_at = now() where lthing = ${lthing} and cls = 'A' and nr = ${nr}`; continue; }
        await upsertMatterDetail(sql, parseMatterDetail(xml), lemmaText);
        done++;
        if (done % 25 === 0) log(`matters: ${done} done (session ${lthing}, last #${nr})`);
      }
    }
  }
  log(`matters: finished — ${done} details`);
}

async function committees() {
  for (const n of range(fromL, toL)) {
    if (stopping) break;
    const xml = await cached(`${BASE}/nefndir/?lthing=${n}`, `lists/nefndir_${n}.xml`);
    if (xml) await upsertCommittees(sql, parseCommittees(xml));
    log(`committees: session ${n} done`);
  }
}

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
    log(`${cmd}: UA=${process.env.CRAWL_UA ?? "althingi-search/0.1 (jokull@solberg.is)"} raw=${RAW_DIR}`);
  }
  if (cmd === "reference") await reference();
  if (cmd === "index") await indexSpeeches();
  if (cmd === "seats") await seats();
  if (cmd === "text") await text();
  if (cmd === "matters") await matters();
  if (cmd === "committees") await committees();
  if (cmd === "status") await status();
} catch (e) {
  if (e instanceof Blocked) { console.error(`STOPPED: ${e.message}`); process.exitCode = 4; }
  else if (e instanceof RateLimited) { console.error(`STOPPED: ${e.message}`); process.exitCode = 5; }
  else throw e;
} finally {
  log(`done after ${fetcher.requests} requests`);
  await sql.end();
}

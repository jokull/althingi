// XML service steps (L1–L3 of docs/INGEST.md §2, §5). One network client: the caller holds the crawl lock.
//   lists    sessions, members, matter list, document list, votes list, committees per session (≤ 6 req/session)
//   members  seat history for members without seats (1 req each)
//   matters  matter detail queue (newest session first); --weekly re-fetches non-terminal A-matters of the current
//            session; --touched re-fetches matters that had speeches or votes today
//   texts    speech files for pending rows (and with --provisional, rows holding only a provisional text)
//   poll     raedulisti/?dagur=today + atkvaedagreidslur/?dagur=today → index rows, vod links, votes → texts
//   index    per-member speech lists for the current session (weekly reconcile, owner decision §8.6)
// Raw bodies go to RAW_DIR before parsing; list endpoints are fetched conditionally when validators exist; a body with
// an unchanged sha is not re-parsed. 403/429 stop the run and pause the crawler for 24 h.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Sql, crawlPausedUntil, markSpeechError, nextPending, pauseCrawl, recordFetch, recordedFetch, upsertCommittees,
  upsertDocumentList, upsertMatterDetail, upsertMatters, upsertMembers, upsertSeats, upsertSessions, upsertSpeechIndex, upsertVoteList,
} from "./db.ts";
import { Blocked, Fetcher, RateLimited, normalizeUrl } from "./fetcher.ts";
import { ingestSpeechXml, sha256 } from "./ingest.ts";
import { lemmaText } from "./lemma.ts";
import {
  parseCommittees, parseDocumentList, parseMatterDetail, parseMatterList, parseMembers, parseSeats, parseSessions, parseSpeechList, parseVoteList,
} from "./parse.ts";

export const BASE = "https://www.althingi.is/altext/xml";
const HOUR = 3_600_000;

export class CrawlPaused extends Error {
  constructor(until: Date) { super(`crawler paused until ${until.toISOString()} (a 403/429 was seen)`); this.name = "CrawlPaused"; }
}

/**
 * `changed`: the body's sha differs from the stored one. `unchanged`: a NETWORK check (304, or a 200 with the stored sha)
 * confirmed the stored body is current — the documented no-op; callers skip the parse. A plain disk hit is neither.
 */
export interface Got { body: string; changed: boolean; fromCache: boolean; unchanged: boolean }

/** The raw-cache client: every response is written to disk and recorded in raw_fetch before anyone parses it. */
export class ServiceClient {
  readonly fetcher: Fetcher;
  constructor(readonly sql: Sql, readonly rawDir = process.env.RAW_DIR ?? join(homedir(), "althingi", "raw"), fetcher?: Fetcher, readonly mirror = process.env.XML_MIRROR) {
    this.fetcher = fetcher ?? new Fetcher();
  }
  get requests() { return this.fetcher.requests; }

  /**
   * Body of `url`, from disk when a 200 younger than `maxAgeMs` is recorded; otherwise fetched — conditionally when a
   * stored validator exists (a 304 serves the disk copy). null = 404. `changed` = the sha differs from the stored one.
   */
  async get(url: string, relPath: string, o: { maxAgeMs?: number; conditional?: boolean } = {}): Promise<Got | null> {
    const maxAgeMs = o.maxAgeMs ?? Number.POSITIVE_INFINITY;
    const norm = normalizeUrl(url);
    const rec = await recordedFetch(this.sql, norm);
    const age = rec ? Date.now() - rec.fetched_at.getTime() : Number.POSITIVE_INFINITY;
    if (rec?.status === 404 && age < maxAgeMs) return null;
    const onDisk = rec?.status === 200 && rec.path && existsSync(rec.path);
    if (onDisk && age < maxAgeMs) return { body: readFileSync(rec!.path!, "utf8"), changed: false, fromCache: true, unchanged: false };
    const v = o.conditional !== false && onDisk ? { etag: rec!.etag, lastModified: rec!.last_modified } : {};
    const r = await this.fetcher.get(norm, v);
    const val = { etag: r.headers.etag ?? null, last_modified: r.headers["last-modified"] ?? null, headers: r.headers };
    if (r.status === 304 && onDisk) {
      await recordFetch(this.sql, { url: norm, status: 304, bytes: 0, sha256: null, path: null, ...val });
      return { body: readFileSync(rec!.path!, "utf8"), changed: false, fromCache: true, unchanged: true };
    }
    if (r.status === 404) {
      await recordFetch(this.sql, { url: norm, status: 404, bytes: 0, sha256: null, path: null, ...val });
      return null;
    }
    if (r.status !== 200) throw new Error(`unexpected ${r.status} for ${norm}`);
    const path = join(this.rawDir, relPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, r.body);
    const sha = sha256(r.body);
    await recordFetch(this.sql, { url: norm, status: 200, bytes: r.bytes, sha256: sha, path, ...val });
    return { body: r.body, changed: sha !== rec?.sha256, fromCache: false, unchanged: sha === rec?.sha256 };
  }

  /** A local copy of Alþingi's bulk export (final texts only) replaces one request per speech. */
  fromMirror(xmlUrl: string): string | null {
    if (!this.mirror) return null;
    const m = /^\/xml\/(\d+)\/raedur\/(rad\d{8}T\d{6}\.xml)$/.exec(new URL(xmlUrl).pathname);
    const p = m && join(this.mirror, m[1]!, "raedur", m[2]!);
    if (!p || !existsSync(p)) return null;
    const body = readFileSync(p, "utf8");
    return /<(?:\w+:)?ræða[\s>]/.test(body) ? body : null;
  }
}

export interface ServiceOpts {
  filter?: { from?: number; to?: number };
  log?: (s: string) => void;
  limit?: string; "max-age-hours"?: string; "from-date"?: string; "to-date"?: string; lthing?: string;
  weekly?: boolean; touched?: boolean; provisional?: boolean; date?: string;
  /** stop flag polled between requests (SIGINT/SIGTERM) */
  stopping?: () => boolean;
}
export interface ServiceResult { requests: number; files: number; rows: number }

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** The session we are in: the highest session the sessions list knows. */
async function currentLthing(sql: Sql): Promise<number> {
  const [r] = await sql<{ l: number | null }[]>`select max(lthing) as l from sessions`;
  const [s] = await sql<{ l: number | null }[]>`select max(lthing) as l from speeches`;
  return r?.l ?? s?.l ?? 157;
}

// ---------------------------------------------------------------- steps

export async function lists(c: ServiceClient, from: number, to: number, o: ServiceOpts & { only?: string[] } = {}): Promise<number> {
  const log = o.log ?? (() => {});
  const maxAgeMs = o["max-age-hours"] ? Number(o["max-age-hours"]) * HOUR : 20 * HOUR;
  const want = (k: string) => !o.only || o.only.includes(k);
  let rows = 0;
  const g = (url: string, rel: string) => c.get(url, rel, { maxAgeMs, conditional: true });
  if (want("sessions")) {
    const s = await g(`${BASE}/loggjafarthing/`, "lists/loggjafarthing.xml");
    if (s && !s.unchanged) { await upsertSessions(c.sql, parseSessions(s.body)); rows++; }
  }
  for (const n of range(from, to)) {
    if (o.stopping?.()) break;
    const m = want("members") && await g(`${BASE}/thingmenn/?lthing=${n}`, `lists/thingmenn_${n}.xml`);
    if (m && !m.unchanged) { await upsertMembers(c.sql, parseMembers(m.body)); rows++; }
    const l = want("matters") && await g(`${BASE}/thingmalalisti/?lthing=${n}`, `lists/thingmalalisti_${n}.xml`);
    if (l && !l.unchanged) { await upsertMatters(c.sql, parseMatterList(l.body), lemmaText); rows++; }
    const k = want("committees") && await g(`${BASE}/nefndir/?lthing=${n}`, `lists/nefndir_${n}.xml`);
    if (k && !k.unchanged) { await upsertCommittees(c.sql, parseCommittees(k.body)); rows++; }
    const d = want("documents") && await g(`${BASE}/thingskjol/?lthing=${n}`, `lists/thingskjol_${n}.xml`);
    if (d && !d.unchanged) rows += await upsertDocumentList(c.sql, parseDocumentList(d.body));
    const v = want("votes") && await g(`${BASE}/atkvaedagreidslur/?lthing=${n}`, `lists/atkvaedagreidslur_${n}.xml`);
    if (v && !v.unchanged) rows += await upsertVoteList(c.sql, parseVoteList(v.body));
    log(`lists: session ${n} done (${c.requests} requests)`);
  }
  return rows;
}

async function memberIds(c: ServiceClient, from: number, to: number): Promise<number[]> {
  const ids = new Set<number>();
  for (const n of range(from, to)) {
    const g = await c.get(`${BASE}/thingmenn/?lthing=${n}`, `lists/thingmenn_${n}.xml`);
    if (g) for (const m of parseMembers(g.body)) ids.add(m.id);
  }
  return [...ids].sort((a, b) => b - a);
}

/** Seats per member. `all`: every member of the range (old `crawl.ts seats`); default: only members without seats. */
export async function members(c: ServiceClient, from: number, to: number, o: ServiceOpts & { all?: boolean } = {}): Promise<number> {
  const log = o.log ?? (() => {});
  let ids = await memberIds(c, from, to);
  if (!o.all) {
    const have = new Set((await c.sql<{ id: number }[]>`select distinct member_id as id from seats`).map((r) => r.id));
    ids = ids.filter((id) => !have.has(id));
  }
  let rows = 0;
  for (const [i, id] of ids.entries()) {
    if (o.stopping?.()) break;
    const g = await c.get(`${BASE}/thingmenn/thingmadur/thingseta/?nr=${id}`, `lists/thingseta_${id}.xml`);
    if (g) { await upsertSeats(c.sql, parseSeats(g.body)); rows++; }
    if ((i + 1) % 20 === 0 || i + 1 === ids.length) log(`members: ${i + 1}/${ids.length} seat histories`);
  }
  return rows;
}

/** Matter statuses that never change again: such matters are not re-fetched (docs/INGEST.md §5). */
export const TERMINAL_STATUS = /^(Samþykkt sem lög|Samþykkt sem ályktun|Fellt|Vísað til ríkisstjórnar|Kallað aftur|Svarað)/i;

export async function matters(c: ServiceClient, from: number, to: number, o: ServiceOpts = {}): Promise<number> {
  const log = o.log ?? (() => {});
  const limit = o.limit ? Number(o.limit) : Number.POSITIVE_INFINITY;
  let done = 0;
  const cur = await currentLthing(c.sql);
  const work: { lthing: number; nr: number; refresh: boolean }[] = [];
  if (o.weekly || o.touched) {
    const rows = o.weekly
      ? await c.sql<{ nr: number; status_text: string | null }[]>`
          select nr, status_text from matters where lthing = ${cur} and cls = 'A' and detail_fetched_at < now() - interval '6 days' order by nr`
      : await c.sql<{ nr: number; status_text: string | null }[]>`
          select distinct m.nr, m.status_text from matters m where m.lthing = ${cur} and m.cls = 'A' and (
            exists (select 1 from speeches s where s.lthing = m.lthing and s.matter_cls = 'A' and s.matter_nr = m.nr and s.speech_date = current_date)
            or exists (select 1 from votes v where v.lthing = m.lthing and v.cls = 'A' and v.nr = m.nr and v.voted_at::date = current_date)
            or exists (select 1 from documents d where d.lthing = m.lthing and d.matter_cls = 'A' and d.matter_nr = m.nr and d.distributed_at::date = current_date))
          order by m.nr`;
    for (const r of rows) if (o.touched || !TERMINAL_STATUS.test(r.status_text ?? "")) work.push({ lthing: cur, nr: r.nr, refresh: true });
  }
  for (const lthing of range(from, to).reverse()) {
    for (const r of await c.sql<{ nr: number }[]>`
      select nr from matters where lthing = ${lthing} and cls = 'A' and detail_fetched_at is null order by nr`) work.push({ lthing, nr: r.nr, refresh: false });
  }
  for (const w of work) {
    if (o.stopping?.() || done >= limit) break;
    const g = await c.get(`${BASE}/thingmalalisti/thingmal/?lthing=${w.lthing}&malnr=${w.nr}`, `matters/${w.lthing}/${w.nr}.xml`,
      { maxAgeMs: w.refresh ? 0 : Number.POSITIVE_INFINITY, conditional: true });
    if (g === null || g.unchanged) {
      await c.sql`update matters set detail_fetched_at = now() where lthing = ${w.lthing} and cls = 'A' and nr = ${w.nr}`;
    } else {
      await upsertMatterDetail(c.sql, parseMatterDetail(g.body), lemmaText);
    }
    done++;
    if (done % 25 === 0) log(`matters: ${done}/${work.length} (session ${w.lthing}, last #${w.nr})`);
  }
  log(`matters: ${done} details (${work.filter((w) => w.refresh).length} refreshes queued)`);
  return done;
}

export async function texts(c: ServiceClient, o: ServiceOpts = {}): Promise<number> {
  const log = o.log ?? (() => {});
  const limit = o.limit ? Number(o.limit) : Number.POSITIVE_INFINITY;
  const filter = { lthing: o.lthing ? Number(o.lthing) : undefined, from: o["from-date"], to: o["to-date"] };
  let done = 0, failed = 0;
  const seen = new Set<string>();
  const provisional = o.provisional
    ? await c.sql<{ id: string; lthing: number; xml_url: string; started: Date }[]>`
        select id, lthing, xml_url, started from speeches where provisional and xml_url is not null
          ${filter.lthing !== undefined ? c.sql`and lthing = ${filter.lthing}` : c.sql``} order by started desc`
    : [];
  while (!o.stopping?.() && done + failed < limit) {
    const batch = [...provisional.splice(0, 50), ...(provisional.length ? [] : await nextPending(c.sql, Math.min(50, limit - done - failed), filter))]
      .filter((s) => !seen.has(s.id));
    if (batch.length === 0) break;
    for (const sp of batch) {
      seen.add(sp.id);
      if (o.stopping?.() || done + failed >= limit) break;
      try {
        // speech files never change once published: cached forever; a local bulk-export copy wins
        const local = c.fromMirror(sp.xml_url);
        const g = local === null ? await c.get(sp.xml_url, `speeches/${sp.lthing}/${sp.id}.xml`) : { body: local };
        if (g === null) { if (!provisional.length) await markSpeechError(c.sql, sp.id, "404"); failed++; continue; }
        await ingestSpeechXml(c.sql, sp.id, g.body);
        done++;
      } catch (e) {
        if (e instanceof Blocked || e instanceof RateLimited || (e as Error).name === "Offline") throw e;
        await markSpeechError(c.sql, sp.id, (e as Error).message);
        failed++;
        log(`texts: ${sp.id} failed: ${(e as Error).message}`);
      }
      if ((done + failed) % 25 === 0) log(`texts: ${done} ok, ${failed} failed`);
    }
  }
  log(`texts: ${done} ok, ${failed} failed`);
  return done;
}

/** YYYYMMDD — the format atkvaedagreidslur/?dagur= is confirmed with (fixtures/sample/_fetch.log); raedulisti uses the same. */
const dayParam = (iso: string) => iso.replace(/-/g, "");

export async function poll(c: ServiceClient, o: ServiceOpts = {}): Promise<number> {
  const log = o.log ?? (() => {});
  const day = o.date ?? new Date().toISOString().slice(0, 10);
  let rows = 0;
  const sp = await c.get(`${BASE}/raedulisti/?dagur=${dayParam(day)}`, `days/raedulisti_${dayParam(day)}.xml`, { maxAgeMs: 0, conditional: true });
  if (sp && !sp.unchanged) rows += await upsertSpeechIndex(c.sql, parseSpeechList(sp.body), lemmaText, "day-list");
  const vo = await c.get(`${BASE}/atkvaedagreidslur/?dagur=${dayParam(day)}`, `days/atkvaedagreidslur_${dayParam(day)}.xml`, { maxAgeMs: 0, conditional: true });
  if (vo && !vo.unchanged) rows += await upsertVoteList(c.sql, parseVoteList(vo.body));
  log(`poll ${day}: speech list ${sp ? (sp.unchanged ? "unchanged" : "changed") : "absent"}, votes ${vo ? (vo.unchanged ? "unchanged" : "changed") : "absent"}`);
  if (sp && !sp.unchanged) rows += await texts(c, { ...o, "from-date": day, "to-date": day });
  return rows;
}

/**
 * vod_url backfill: the per-member lists carry no <vod>, day lists do. One request per sitting day that has speeches
 * without a vod link (`--lthing N`, or `--from-date/--to-date`); day lists are cached forever once fetched.
 */
export async function days(c: ServiceClient, o: ServiceOpts = {}): Promise<number> {
  const log = o.log ?? (() => {});
  const limit = o.limit ? Number(o.limit) : Number.POSITIVE_INFINITY;
  const dates = await c.sql<{ d: string }[]>`
    select distinct speech_date::text as d from speeches where vod_url is null and era = 'xml'
      ${o.lthing ? c.sql`and lthing = ${Number(o.lthing)}` : c.sql``}
      ${o["from-date"] ? c.sql`and speech_date >= ${o["from-date"]}` : c.sql``}
      ${o["to-date"] ? c.sql`and speech_date <= ${o["to-date"]}` : c.sql``}
    order by 1 desc`;
  let rows = 0, n = 0;
  for (const { d } of dates) {
    if (o.stopping?.() || n++ >= limit) break;
    const g = await c.get(`${BASE}/raedulisti/?dagur=${dayParam(d)}`, `days/raedulisti_${dayParam(d)}.xml`);
    if (g) rows += await upsertSpeechIndex(c.sql, parseSpeechList(g.body), lemmaText, "day-list");
    if (n % 10 === 0) log(`days: ${n}/${dates.length}`);
  }
  log(`days: ${n} day lists, ${rows} new index rows`);
  return rows;
}

/** Per-member speech lists, current session only (weekly reconcile). */
export async function reconcile(c: ServiceClient, from: number, to: number, o: ServiceOpts & { maxAgeMs?: number } = {}): Promise<number> {
  const log = o.log ?? (() => {});
  const ids = await memberIds(c, from, to);
  let added = 0;
  for (const [i, id] of ids.entries()) {
    if (o.stopping?.()) break;
    const g = await c.get(`${BASE}/thingmenn/thingmadur/raedur/?nr=${id}`, `lists/raedur_member_${id}.xml`, { maxAgeMs: o.maxAgeMs ?? 6 * 24 * HOUR });
    if (!g) continue;
    if (g.unchanged) continue;
    added += await upsertSpeechIndex(c.sql, parseSpeechList(g.body).filter((e) => e.lthing >= from && e.lthing <= to), lemmaText, "member-list");
    if ((i + 1) % 10 === 0 || i + 1 === ids.length) log(`index: ${i + 1}/${ids.length} members, +${added} new speeches`);
  }
  return added;
}

/** CLI entry (scripts/ingest.ts service <step>). Refuses while paused; a 403/429 pauses the crawler for 24 h. */
export async function runService(sql: Sql, step: string | undefined, o: ServiceOpts, client?: ServiceClient): Promise<ServiceResult> {
  const until = await crawlPausedUntil(sql);
  if (until) throw new CrawlPaused(until);
  const c = client ?? new ServiceClient(sql, undefined, new Fetcher({ log: o.log }));
  const cur = await currentLthing(sql);
  const from = o.filter?.from ?? cur, to = o.filter?.to ?? from;
  let rows = 0;
  try {
    if (step === "lists") rows = await lists(c, from, to, o);
    else if (step === "members") rows = await members(c, from, to, o);
    else if (step === "matters") rows = await matters(c, from, to, o);
    else if (step === "texts") rows = await texts(c, o);
    else if (step === "poll") rows = await poll(c, o);
    else if (step === "index") rows = await reconcile(c, from, to, o);
    else if (step === "days") rows = await days(c, o);
    else throw new Error(`unknown service step: ${step ?? "(none)"} — lists|members|matters|texts|poll|index|days`);
  } catch (e) {
    if (e instanceof Blocked || e instanceof RateLimited) await pauseCrawl(sql, 24, e.message);
    throw e;
  }
  return { requests: c.requests, files: 0, rows };
}

/**
 * Zero requests: re-read matter details and speech lists already in the raw cache and record their speaker sightings
 * (member ids for non-MP ministers, vod links). This is how the mini learns DMK = 1448 from its cached details.
 */
export async function replayRaw(sql: Sql, log: (s: string) => void = () => {}): Promise<number> {
  const rows = await sql<{ url: string; path: string }[]>`
    select url, path from raw_fetch where status = 200 and path is not null
      and (url like '%/thingmalalisti/thingmal/%' or url like '%/raedulisti/%' or url like '%/thingmadur/raedur/%')`;
  let n = 0;
  for (const r of rows) {
    if (!existsSync(r.path)) continue;
    const xml = readFileSync(r.path, "utf8");
    const detail = r.url.includes("/thingmal/");
    const entries = detail ? parseMatterDetail(xml).speeches : parseSpeechList(xml);
    const source = detail ? "matter-detail" : r.url.includes("dagur=") ? "day-list" : r.url.includes("/raedulisti/") ? "matter-speeches" : "member-list";
    n += await upsertSpeechIndex(sql, entries, lemmaText, source);
  }
  log(`replay: ${rows.length} cached service files re-read, ${n} new index rows`);
  return n;
}

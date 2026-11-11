// Service steps against a mocked fetcher: no request ever leaves the machine.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { type Sql, connect, crawlPausedUntil, migrate, upsertMatters, upsertMembers, upsertSessions, upsertSpeechIndex } from "../src/db.ts";
import { Blocked, Fetcher, normalizeUrl } from "../src/fetcher.ts";
import { lemmaText } from "../src/lemma.ts";
import { parseMatterList, parseMembers, parseSessions, parseSpeechList } from "../src/parse.ts";
import { ServiceClient, matters, poll, runService } from "../src/service.ts";

const ADMIN = process.env.TEST_PG ?? "postgres://postgres:dev@localhost:5433/postgres";
const NAME = `althingi_service_test_${process.pid}`;
const fx = (p: string) => readFileSync(new URL(`../fixtures/${p}`, import.meta.url), "utf8");

let sql: Sql;
let admin: postgres.Sql;
let ok = false;

interface Call { url: string; headers: Record<string, string> }
/** A fake althingi.is: routes by URL substring; records every call. */
function fakeFetcher(routes: [RegExp, (h: Record<string, string>) => Response][]) {
  const calls: Call[] = [];
  const f = new Fetcher({
    minGapMs: 0, backoffMs: [], sleep: async () => {},
    fetchImpl: (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ url, headers });
      const r = routes.find(([re]) => re.test(url));
      if (!r) return new Response("", { status: 404 });
      return r[1](headers);
    }) as unknown as typeof fetch,
  });
  return { f, calls };
}

beforeAll(async () => {
  admin = postgres(ADMIN, { max: 1, onnotice: () => {} });
  try { await admin`select 1`; } catch (e) { console.warn("skipping service tests (no Postgres):", (e as Error).message); return; }
  await admin.unsafe(`create database ${NAME}`);
  sql = connect(ADMIN.replace(/\/[^/]*$/, `/${NAME}`));
  await migrate(sql);
  await upsertSessions(sql, parseSessions(fx("lthing.xml")));
  await upsertMembers(sql, parseMembers(fx("sample/thingmenn_157.xml")));
  ok = true;
});
afterAll(async () => {
  if (!ok) return;
  await sql.end();
  await admin.unsafe(`drop database ${NAME} with (force)`);
  await admin.end();
});

describe("fetcher allowlist for the law zip", () => {
  test("exactly one binary path; never via the text path, never anything else as binary", () => {
    expect(normalizeUrl("http://althingi.is/lagasafn/zip/nuna/allt.zip", "binary")).toBe("https://www.althingi.is/lagasafn/zip/nuna/allt.zip");
    expect(() => normalizeUrl("https://www.althingi.is/lagasafn/zip/nuna/allt.zip")).toThrow();
    for (const u of ["https://www.althingi.is/lagasafn/zip/158a/allt.zip", "https://www.althingi.is/lagasafn/zip/nuna/allt.zip?x=1",
      "https://www.althingi.is/altext/xml/thingmenn/", "https://www.althingi.is/lagas/nuna/2016046.html"]) {
      expect(() => normalizeUrl(u, "binary")).toThrow();
    }
  });

  test("a non-zip body is a challenge: Blocked", async () => {
    const { f } = fakeFetcher([[/allt\.zip/, () => new Response("<!doctype html><title>Just a moment</title>", { status: 200 })]]);
    await expect(f.getBinary("https://www.althingi.is/lagasafn/zip/nuna/allt.zip")).rejects.toBeInstanceOf(Blocked);
  });
});

describe("service client", () => {
  test("records headers, sends validators next time, serves the disk copy on 304", async () => {
    if (!ok) return;
    const body = fx("sample/thingmenn_157.xml");
    const { f, calls } = fakeFetcher([[/thingmenn\/\?lthing=157/, (h) => h["If-None-Match"] === '"v1"'
      ? new Response(null, { status: 304, headers: { etag: '"v1"' } })
      : new Response(body, { status: 200, headers: { etag: '"v1"', "last-modified": "Tue, 10 Nov 2026 10:00:00 GMT" } })]]);
    const c = new ServiceClient(sql, mkdtempSync(join(tmpdir(), "raw-")), f);
    const url = "https://www.althingi.is/altext/xml/thingmenn/?lthing=157";
    const a = await c.get(url, "lists/thingmenn_157.xml", { maxAgeMs: 0 });
    expect(a).toMatchObject({ changed: true, unchanged: false });
    const [rec] = await sql`select etag, last_modified, headers->>'etag' as h, sha256 from raw_fetch where url = ${url}`;
    expect(rec).toMatchObject({ etag: '"v1"', last_modified: "Tue, 10 Nov 2026 10:00:00 GMT", h: '"v1"' });
    const b = await c.get(url, "lists/thingmenn_157.xml", { maxAgeMs: 0 });
    expect(calls[1]!.headers["If-None-Match"]).toBe('"v1"');
    expect(calls[1]!.headers["If-Modified-Since"]).toBe("Tue, 10 Nov 2026 10:00:00 GMT");
    expect(b).toMatchObject({ unchanged: true, body });
    const [rec2] = await sql`select status, sha256 from raw_fetch where url = ${url}`;
    expect(rec2).toMatchObject({ status: 200, sha256: rec!.sha256 }); // 304 keeps the stored body's record
  });

  test("poll: the day list fills vod links on existing rows and the new speech texts are fetched", async () => {
    if (!ok) return;
    // index row from a per-member list (which never has <vod>)
    const entries = parseSpeechList(fx("days/d20180306.xml")).map((e) => ({ ...e, vodUrl: null }));
    await upsertSpeechIndex(sql, entries, lemmaText);
    const id = "rad20180306T163325";
    expect((await sql`select vod_url from speeches where id = ${id}`)[0]!.vod_url).toBeNull();
    const speech = fx("sample/speech_d20180306_rad20180306T163325_xml.xml");
    const { f, calls } = fakeFetcher([
      [/raedulisti\/\?dagur=20180306/, () => new Response(fx("days/d20180306.xml"), { status: 200 })],
      [/atkvaedagreidslur\/\?dagur=20180306/, () => new Response("<atkvæðagreiðslur/>", { status: 200 })],
      [/rad20180306T163325\.xml$/, () => new Response(speech, { status: 200 })],
    ]);
    const c = new ServiceClient(sql, mkdtempSync(join(tmpdir(), "raw-")), f);
    await poll(c, { date: "2018-03-06", limit: "3" });
    expect((await sql`select vod_url from speeches where id = ${id}`)[0]!.vod_url).toContain("vod.althingi.is");
    expect(calls.every((x) => x.url.startsWith("https://www.althingi.is/"))).toBe(true);
    expect((await sql`select count(*)::int n from speaker_sightings where source = 'day-list'`)[0]!.n).toBeGreaterThan(0);
  });

  test("matters: detail <ræður> records a sighting for a non-MP minister", async () => {
    if (!ok) return;
    await upsertMatters(sql, parseMatterList(fx("sample/thingmalalisti_157.xml")).filter((m) => m.nr === 1 && m.cls === "A"), lemmaText);
    const { f } = fakeFetcher([[/thingmal\/\?lthing=157&malnr=1$/, () => new Response(fx("sample/thingmal_157_1.xml"), { status: 200 })]]);
    const c = new ServiceClient(sql, mkdtempSync(join(tmpdir(), "raw-")), f);
    expect(await matters(c, 157, 157, { limit: "1" })).toBe(1);
    expect((await sql`select member_id from speaker_sightings where speech_id = 'rad20250911T103239'`)[0]).toEqual({ member_id: 1448 });
    expect((await sql`select name from members where id = 1448`)[0]).toEqual({ name: "Daði Már Kristófersson" });
  });

  test("a 403 stops the run and pauses the crawler for 24 h; the next run refuses", async () => {
    if (!ok) return;
    const { f } = fakeFetcher([[/./, () => new Response("forbidden", { status: 403 })]]);
    const c = new ServiceClient(sql, mkdtempSync(join(tmpdir(), "raw-")), f);
    await expect(runService(sql, "lists", { filter: { from: 157, to: 157 }, "max-age-hours": "0" }, c)).rejects.toBeInstanceOf(Blocked);
    expect(await crawlPausedUntil(sql)).not.toBeNull();
    await expect(runService(sql, "lists", {}, c)).rejects.toThrow(/paused/);
    await sql`delete from ingest_state where key like 'crawl_paused%'`;
  });
});

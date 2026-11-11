// The layered ingest against a throwaway Postgres: dump fixtures (a tiny drop) → derive → idempotent rerun.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { type Sql, connect, migrate, upsertMatterDetail, upsertMembers, upsertSessions } from "../src/db.ts";
import { derive } from "../src/derive.ts";
import { dumpMisc, dumpSittings, dumpSpeeches, hashDrop } from "../src/dump-ingest.ts";
import { lemmaText } from "../src/lemma.ts";
import { parseMatterDetail, parseMembers, parseSessions } from "../src/parse.ts";
import { createApp } from "../src/web.tsx";

const ADMIN = process.env.TEST_PG ?? "postgres://postgres:dev@localhost:5433/postgres";
const NAME = `althingi_ingest_test_${process.pid}`;
const fx = (p: string) => readFileSync(new URL(`../fixtures/${p}`, import.meta.url), "utf8");
const DROP = fileURLToPath(new URL("../fixtures/dump", import.meta.url));
const NFD_DROP = fileURLToPath(new URL("../fixtures/dump-nfd", import.meta.url));

let sql: Sql;
let admin: postgres.Sql;
let ok = false;

beforeAll(async () => {
  admin = postgres(ADMIN, { max: 1, onnotice: () => {} });
  try { await admin`select 1`; } catch (e) { console.warn("skipping ingest tests (no Postgres):", (e as Error).message); return; }
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

const one = async <T>(q: Promise<T[]>): Promise<T> => (await q)[0]!;

describe("dump ingest", () => {
  test("a drop: speeches (final + provisional), sittings, misc", async () => {
    if (!ok) return;
    const h = await hashDrop(sql, DROP);
    expect(h.changed).toBe(h.files);
    const sp = await dumpSpeeches(sql);
    expect(sp.notes["new speech"]).toBe(3);
    expect(sp.notes["new provisional speech"]).toBe(1);
    expect(sp.notes["provisional: final exists"]).toBe(1);
    // dump-only speaker: abbreviation, no member id yet; index fields from the file
    expect(await one(sql`select member_id, member_name, speaker_abbr, type, office, index_source, text_source, xml_url from speeches where id = 'rad20250911T104951'`)).toEqual({
      member_id: null, member_name: "DMK", speaker_abbr: "DMK", type: "andsvar", office: "fjmrh.", index_source: "dump", text_source: "dump",
      xml_url: "https://www.althingi.is/xml/157/raedur/rad20250911T104951.xml",
    });
    expect(await one(sql`select provisional, text_source, text_state from speeches where id = 'rad20260209T163926'`)).toEqual({ provisional: true, text_source: "dump-provisional", text_state: "done" });
    expect(await one(sql`select provisional from speeches where id = 'rad20260527T150044'`)).toEqual({ provisional: false });
    expect((await one(sql<{ n: number }[]>`select count(*)::int n from paragraphs where speech_id = 'rad20260209T163926'`)).n).toBeGreaterThan(0);
    // pages: provisional flag shown; an unresolved speaker is abbreviation-only, never /thingmadur/null
    const app = createApp(sql);
    expect(await (await app.request("http://x/raeda/rad20260209T163926")).text()).toContain("bráðabirgðatexti");
    const dmk = await (await app.request("http://x/raeda/rad20250911T104951")).text();
    expect(dmk).toContain("DMK");
    expect(dmk).not.toContain("/thingmadur/null");

    const st = await dumpSittings(sql);
    expect(st.errors).toBe(0);
    const mi = await dumpMisc(sql);
    expect(mi.errors).toBe(0);
    expect(await one(sql`select yes, no, abstain, method_code, kind_code2, unanimous, source from votes where id = 68227`)).toEqual({
      yes: 37, no: 0, abstain: 0, method_code: "S", kind_code2: "bn", unanimous: true, source: "dump",
    });
    const b = await one(sql<{ resolved: number; parked: number }[]>`
      select (select count(*)::int from ballots where vote_id = 68227) resolved, (select count(*)::int from ballots_unresolved where vote_id = 68227) parked`);
    expect(b.resolved + b.parked).toBe(63);
    expect(b.resolved).toBeGreaterThan(55);
    const spons = await sql<{ abbr: string; source: string }[]>`select abbr, source from matter_sponsors where lthing = 157 and cls = 'A' and nr = 137 order by seq`;
    expect(spons.length).toBe(13);
    expect(spons[0]).toEqual({ abbr: "DBE", source: "lidaskjol" });
    // an answer's flm (the minister) is not the matter's sponsor
    expect((await sql`select 1 from matter_sponsors where lthing = 157 and nr = 93`).length).toBe(0);
    expect((await one(sql<{ n: number }[]>`select count(*)::int n from sitting_events where lthing = 157 and fundur = 20 and kind = 'frvAfgreittSemLög'`)).n).toBeGreaterThan(0);
    expect((await one(sql<{ n: number }[]>`select count(*)::int n from absences where lthing = 157 and fundur = 19`)).n).toBe(3);
    expect(await one(sql`select type, distributed_at::text, source from documents where lthing = 157 and nr = 156`)).toEqual({ type: "svar", distributed_at: "2025-10-06 15:00:22", source: "dump" });
  });

  test("derive: a matter-detail sighting teaches DMK = 1448; lidaskjol order gives reply_to", async () => {
    if (!ok) return;
    await upsertMatterDetail(sql, parseMatterDetail(fx("sample/thingmal_157_1.xml")), lemmaText);
    const c = await derive(sql);
    expect(c["speeches.resolved"] ?? 0).toBeGreaterThan(0);
    expect(await one(sql`select member_id, member_name from speeches where id = 'rad20250911T104951'`)).toEqual({ member_id: 1448, member_name: "Daði Már Kristófersson" });
    expect(await one(sql`select member_id, n from speaker_aliases where abbr = 'DMK'`)).toMatchObject({ member_id: 1448 });
    expect(await one(sql`select reply_to_id, reply_to_inferred from speeches where id = 'rad20250911T104951'`)).toEqual({ reply_to_id: "rad20250911T103239", reply_to_inferred: false });
    expect((await one(sql<{ n: number }[]>`select count(*)::int n from members where id = 1448`)).n).toBe(1);
  });

  test("rerun is a no-op: unchanged tree reused, nothing parsed, derive writes nothing", async () => {
    if (!ok) return;
    const h = await hashDrop(sql, DROP);
    expect(h).toMatchObject({ reused: true, changed: 0 });
    for (const r of [await dumpSpeeches(sql), await dumpSittings(sql), await dumpMisc(sql)]) expect([r.files, r.rows]).toEqual([0, 0]);
    const c = await derive(sql);
    expect(Object.values(c).reduce((a, b) => a + b, 0)).toBe(0);
  });

  test("NFD abbreviations resolve like NFC ones", async () => {
    if (!ok) return;
    await hashDrop(sql, NFD_DROP);
    await dumpSpeeches(sql);
    await derive(sql);
    const r = await one(sql<{ speaker_abbr: string; member_id: number | null }[]>`select speaker_abbr, member_id from speeches where id = 'rad20260427T184758'`);
    expect(r.speaker_abbr).toBe("ÁLÞ".normalize("NFC"));
    const [m] = await sql<{ id: number }[]>`select id from members where abbr = 'ÁLÞ'`;
    expect(r.member_id).toBe(m!.id);
  });
});

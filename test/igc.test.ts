import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { type Sql, connect, migrate, upsertSpeechIndex } from "../src/db.ts";
import { IGC_VERSION, igcIngest, igcSession, normUrl, parseIgcDay, parseIgcPersons, stitch } from "../src/igc.ts";
import { lemmaText } from "../src/lemma.ts";
import { parseSpeechList } from "../src/parse.ts";

const fx = (p: string) => readFileSync(new URL(`../fixtures/${p}`, import.meta.url), "utf8");
const DIR = new URL("../fixtures/igc", import.meta.url).pathname;

describe("igc parsers", () => {
  const day = parseIgcDay(fx("igc/1999/IGC-Parla_1999-03-02-75.xml"));
  const persons = parseIgcPersons(fx("igc/IGC-Parla-2026.xml"));

  test("day file: session, meeting, date, utterances with source URLs", () => {
    expect(day).toMatchObject({ id: "IGC-Parla_1999-03-02-75", lthing: 123, fundur: "75", date: "1999-03-02" });
    expect(igcSession(fx("igc/1999/IGC-Parla_1999-03-02-75.xml"))).toBe(123);
    expect(day.utterances.length).toBe(6);
    expect(day.utterances[0]).toMatchObject({ uid: "IGC-Parla_1999-03-02-75.u1", who: "GudmundurStefansson", chair: true, source: "http://www.althingi.is/altext/123/03/r02133209.sgml" });
    expect(day.utterances[3]).toMatchObject({ who: "PeturBlondal1944", issue: "123_323", chair: false });
    expect(normUrl(day.utterances[0]!.source)).toBe("/altext/123/03/r02133209.sgml");
  });

  test("<vocal> interruptions leave the text and become interjections", () => {
    const petur = day.utterances[3]!;
    expect(petur.who).toBe("PeturBlondal1944");
    const withInt = petur.paragraphs.filter((p) => p.interjections.length);
    expect(withInt.length).toBe(1);
    expect(withInt[0]!.interjections).toEqual(["Gripið fram í: Sumir orðnir nokkuð gamlir."]);
    expect(withInt[0]!.text).not.toContain("Gripið fram í");
    expect(withInt[0]!.text).not.toMatch(/\s{2}/);
    expect(day.utterances[2]!.paragraphs.every((p) => p.interjections.length === 0)).toBe(true);
  });

  test("persons: xml:id → Alþingi member id from the cv URL", () => {
    expect(persons.get("GudmundurStefansson")).toEqual({ memberId: 7, name: "Guðmundur Árni Stefánsson" });
    expect(persons.get("PeturBlondal1944")!.memberId).toBe(477);
    expect(persons.get("OgmundurJonasson")!.memberId).toBe(630);
    expect(persons.get("PallPetursson")!.memberId).toBe(467);
  });

  test("stitch: a split record keeps the member's utterances, others become interjections; no match → null", () => {
    const group = day.utterances.filter((u) => u.source.endsWith("r02142606.sgml"));
    expect(group.map((u) => u.who)).toEqual(["PeturBlondal1944", "OgmundurJonasson", "PeturBlondal1944"]);
    const st = stitch(group, 477, persons)!;
    expect(st.uids).toEqual(["IGC-Parla_1999-03-02-75.u15", "IGC-Parla_1999-03-02-75.u17"]);
    expect(st.otherUids).toEqual(["IGC-Parla_1999-03-02-75.u16"]);
    const n15 = group[0]!.paragraphs.length;
    expect(st.paragraphs.length).toBe(n15 + group[2]!.paragraphs.length);
    expect(st.paragraphs[n15 - 1]!.interjections.at(-1)).toMatch(/^Ögmundur Jónasson: /);
    expect(st.paragraphs.map((p) => p.seq)).toEqual([...st.paragraphs.keys()]);
    expect(stitch(group, 7, persons)).toBeNull();
  });
});

describe("igc ingest", () => {
  const ADMIN = process.env.TEST_PG ?? "postgres://postgres:dev@localhost:5433/postgres";
  const NAME = `althingi_igc_${process.pid}`;
  let sql: Sql;
  let admin: postgres.Sql;
  let ok = false;

  beforeAll(async () => {
    admin = postgres(ADMIN, { max: 1, onnotice: () => {} });
    try { await admin`select 1`; } catch (e) { console.warn("skipping igc db tests (no Postgres at TEST_PG):", (e as Error).message); return; }
    await admin.unsafe(`create database ${NAME}`);
    sql = connect(ADMIN.replace(/\/[^/]*$/, `/${NAME}`));
    await migrate(sql);
    await upsertSpeechIndex(sql, parseSpeechList(fx("days/d19990302.xml")), lemmaText);
    ok = true;
  });
  afterAll(async () => {
    if (!ok) return;
    await sql.end();
    await admin.unsafe(`drop database ${NAME} with (force)`);
    await admin.end();
  });

  test("fills existing SGML-era rows only, keeps era/index, is a sha no-op on rerun, never overwrites Alþingi text", async () => {
    if (!ok) return;
    const [before] = await sql<{ n: number }[]>`select count(*)::int n from speeches where era = 'sgml' and text_state = 'unavailable'`;
    expect(before!.n).toBeGreaterThan(30);
    const r1 = await igcIngest(sql, DIR, { from: 123, to: 123 });
    expect(r1.files).toBe(1);
    expect(r1.rows).toBe(4); // u1, u4, u5 single; u15+u17 stitched
    expect(r1.notes).toMatchObject({ "single utterance": 3, "stitched from a split record": 1 });
    const rows = await sql<{ id: string; text_state: string; text_source: string; era: string; provisional: boolean; source_ref: string; word_count: number; member_id: number }[]>`
      select id, text_state, text_source, era, provisional, source_ref, word_count, member_id from speeches where text_state = 'done' order by id`;
    expect(rows.map((x) => x.id)).toEqual(["sgml123_03_r02133209", "sgml123_03_r02133527", "sgml123_03_r02134051", "sgml123_03_r02142606"]);
    for (const x of rows) expect(x).toMatchObject({ text_source: IGC_VERSION, era: "sgml", provisional: false });
    expect(rows[3]!.source_ref).toBe("IGC-Parla_1999-03-02-75:u15,u17");
    expect(rows[3]!.member_id).toBe(477);
    const paras = await sql<{ seq: number; text: string; interjections: string[]; lemma_text: string }[]>`
      select seq, text, interjections, lemma_text from paragraphs where speech_id = 'sgml123_03_r02142606' order by seq`;
    expect(paras.length).toBeGreaterThan(1);
    expect(paras.some((p) => p.interjections.some((i) => i.startsWith("Ögmundur Jónasson: ")))).toBe(true);
    expect(paras.every((p) => p.lemma_text.length > 0)).toBe(true);
    const [tok] = await sql<{ n: number }[]>`select count(*)::int n from paragraph_tokens where speech_id = 'sgml123_03_r02142606'`;
    expect(tok!.n).toBe(paras.length);
    const [still] = await sql<{ n: number }[]>`select count(*)::int n from speeches where era = 'sgml' and text_state = 'unavailable'`;
    expect(still!.n).toBe(before!.n - 4);

    // rerun: identical payload → no writes
    const r2 = await igcIngest(sql, DIR, { from: 123, to: 123 });
    expect(r2.rows).toBe(0);
    expect(r2.notes["same sha"]).toBe(4);

    // Alþingi text present (simulated final from another source) → IGC never overwrites it
    await sql`update speeches set text_source = 'dump', raw_sha256 = 'x' where id = 'sgml123_03_r02133527'`;
    const r3 = await igcIngest(sql, DIR, { from: 123, to: 123 });
    expect(r3.rows).toBe(0);
    expect(r3.notes["Alþingi text present, kept"]).toBe(1);
    const [kept] = await sql<{ text_source: string; raw_sha256: string }[]>`select text_source, raw_sha256 from speeches where id = 'sgml123_03_r02133527'`;
    expect(kept).toEqual({ text_source: "dump", raw_sha256: "x" });

    // session filter: nothing in range → nothing parsed
    const r4 = await igcIngest(sql, DIR, { from: 124, to: 130 });
    expect(r4.files).toBe(0);
  });
});

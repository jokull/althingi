import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import postgres from "postgres";
import { type Sql, connect, matterDetailQueue, migrate, nextPending, upsertCommittees, upsertMatterDetail, upsertMatters, upsertMembers, upsertSeats, upsertSessions, upsertSpeechIndex } from "../src/db.ts";
import { ingestSpeechXml } from "../src/ingest.ts";
import { lemmaText, searchTsQuery } from "../src/lemma.ts";
import { reindex } from "../src/reindex.ts";
import { search } from "../src/search.ts";
import { clearWinner, findMembers, suggest } from "../src/suggest.ts";
import { parseCommittees, parseMatterDetail, parseMatterList, parseMembers, parseSeats, parseSessions, parseSpeechList } from "../src/parse.ts";

const ADMIN = process.env.TEST_PG ?? "postgres://postgres:dev@localhost:5433/postgres";
const NAME = `althingi_test_${process.pid}`;
const fx = (p: string) => readFileSync(new URL(`../fixtures/${p}`, import.meta.url), "utf8");

let sql: Sql;
let admin: postgres.Sql;
let ok = false;

beforeAll(async () => {
  admin = postgres(ADMIN, { max: 1, onnotice: () => {} });
  try {
    await admin`select 1`;
  } catch (e) {
    // only "no Postgres reachable" skips; anything after this point must fail loudly
    console.warn("skipping db tests (no Postgres at TEST_PG):", (e as Error).message);
    return;
  }
  await admin.unsafe(`create database ${NAME}`);
  sql = connect(ADMIN.replace(/\/[^/]*$/, `/${NAME}`));
  await migrate(sql);
  ok = true;
});
afterAll(async () => {
  if (!ok) return;
  await sql.end();
  await admin.unsafe(`drop database ${NAME} with (force)`);
  await admin.end();
});

describe("db", () => {
  test("migrate is idempotent", async () => {
    if (!ok) return;
    expect(await migrate(sql)).toEqual([]);
  });

  test("reference data loads and is re-runnable", async () => {
    if (!ok) return;
    await upsertSessions(sql, parseSessions(fx("lthing.xml")));
    await upsertMembers(sql, parseMembers(fx("sample/thingmenn_157.xml")));
    await upsertMatters(sql, parseMatterList(fx("sample/thingmalalisti_157.xml")), lemmaText);
    const seats = parseSeats(fx("sample/thingseta_633.xml"));
    await upsertSeats(sql, seats);
    await upsertSeats(sql, seats); // again: no duplicates
    expect((await sql`select count(*)::int n from sessions`)[0]!.n).toBe(158);
    expect((await sql`select count(*)::int n from members`)[0]!.n).toBe(114);
    expect((await sql`select count(*)::int n from matters where lthing = 157`)[0]!.n).toBe(1069); // feed lists 157/A/516 twice
    expect((await sql`select count(*)::int n from seats where member_id = 633`)[0]!.n).toBe(51);
    expect((await sql`select count(*)::int n from parties`)[0]!.n).toBe(2);
  });

  test("speech index: only XML-era real speeches stored; B-mál become stub matters; re-list keeps state", async () => {
    if (!ok) return;
    const list = parseSpeechList(fx("days/d20180306.xml"));
    const n1 = await upsertSpeechIndex(sql, list);
    expect(n1).toBe(81); // 84 minus 3 útbýting
    expect(await upsertSpeechIndex(sql, list)).toBe(0);
    expect((await sql`select count(*)::int n from speeches where text_state = 'pending'`)[0]!.n).toBe(81);
    expect((await sql`select count(*)::int n from speeches where era = 'xml'`)[0]!.n).toBe(81);
    const b = await sql`select count(*)::int n from matters where lthing = 148 and cls = 'B' and stub`;
    expect(b[0]!.n).toBe(1); // all 15 B-speeches belong to one matter: B/307 "störf þingsins"
    // SGML-era listing is stored as an index only: text is behind a bot challenge and never queued
    expect(await upsertSpeechIndex(sql, parseSpeechList(fx("days/d19990302.xml")))).toBe(39);
    const sg = await sql`select count(*)::int n, count(*) filter (where text_state = 'unavailable' and xml_url is null and source_url is not null and era = 'sgml')::int ok from speeches where era = 'sgml'`;
    expect(sg[0]).toMatchObject({ n: 39, ok: 39 });
    expect((await nextPending(sql, 500, { lthing: 123 })).length).toBe(0);
  });

  test("ingest speech texts, then full-text search by lemma finds inflected forms", async () => {
    if (!ok) return;
    const dir = new URL("../fixtures/sample/", import.meta.url);
    const files = readdirSync(dir).filter((f) => /^speech_d20180306_rad\d{8}T\d{6}_xml\.xml$/.test(f));
    expect(files.length).toBe(5);
    for (const f of files) {
      const id = f.match(/(rad\d{8}T\d{6})/)![1]!;
      const r = await ingestSpeechXml(sql, id, fx(`sample/${f}`));
      expect(r.paragraphs).toBeGreaterThan(0);
    }
    expect((await sql`select count(*)::int n from speeches where text_state = 'done'`)[0]!.n).toBe(5);
    const pending = await nextPending(sql, 10, { lthing: 148 });
    expect(pending.length).toBe(10);
    expect(pending[0]!.started >= pending[1]!.started).toBe(true); // newest first

    // search any lemma that exists in the stored text, via the query side of lemma.ts
    const [probe] = await sql<{ lemma_text: string }[]>`select lemma_text from paragraphs order by length(lemma_text) desc limit 1`;
    const word = probe!.lemma_text.split(" ").find((w) => w.length > 6)!;
    const q = searchTsQuery(word)!;
    const hits = await sql`select speech_id, seq from paragraphs where search_vector @@ to_tsquery('simple', ${q})`;
    expect(hits.length).toBeGreaterThan(0);
    const info = await sql`select lemma_is_version, raw_sha256, word_count from speeches where text_state = 'done' limit 1`;
    expect(info[0]!.lemma_is_version).toMatch(/^lemma-is@0\.12\.0\+/);
    expect(info[0]!.raw_sha256).toHaveLength(64);
    expect(info[0]!.word_count).toBeGreaterThan(0);
  });

  test("ingest rejects a file from another day, but tolerates seconds of drift inside the day", async () => {
    if (!ok) return;
    const f = "sample/speech_d20180306_rad20180306T133436_xml.xml";
    await expect(ingestSpeechXml(sql, "rad20000101T000000", fx(f))).rejects.toThrow(/mismatch/);
    // index id says 13:34:36 but the file's own timestamp differs: the stem (index id) stays canonical
    expect((await sql`select count(*)::int n from speeches where id = 'rad20180306T133436'`)[0]!.n).toBe(1);
    const drifted = fx(f).replace("2018-03-06T13:34:36", "2018-03-06T13:34:20");
    expect(drifted).not.toBe(fx(f));
    await ingestSpeechXml(sql, "rad20180306T133436", drifted);
    expect((await sql`select count(*)::int n from speeches where id = 'rad20180306T133436' and text_state = 'done'`)[0]!.n).toBe(1);
  });

  test("search v2: inflected recall, phrases, grouping by speech, filters, paging", async () => {
    if (!ok) return;
    const [probe] = await sql<{ speech_id: string; text: string }[]>`
      select p.speech_id, p.text from paragraphs p order by length(p.text) desc limit 1`;
    const words = probe!.text.split(" ").map((w) => w.replace(/[^\p{L}]/gu, "")).filter((w) => w.length > 3);
    const word = words.find((w) => w.length > 7)!;

    const r = await search(sql, { q: word });
    expect(r.query.description.length).toBeGreaterThan(0);
    expect(r.hits.length).toBeGreaterThan(0);
    const mine = r.hits.find((h) => h.speechId === probe!.speech_id);
    expect(mine).toBeDefined();
    expect(mine!.paragraphs.length).toBeLessThanOrEqual(2);
    expect(mine!.paragraphs[0]!.snippets[0]!.segments.some((s) => s.highlight)).toBe(true);
    // grouped: one hit per speech
    expect(new Set(r.hits.map((h) => h.speechId)).size).toBe(r.hits.length);

    // filters
    expect((await search(sql, { q: word, memberId: -1 })).hits).toEqual([]);
    expect((await search(sql, { q: word, dateFrom: "2018-03-06", dateTo: "2018-03-06" })).hits.length).toBeGreaterThan(0);
    expect((await search(sql, { q: word, dateFrom: "2019-01-01" })).hits).toEqual([]);

    // blank / stopword-only queries return nothing and say so
    expect((await search(sql, { q: "   " })).hits).toEqual([]);
    const stop = await search(sql, { q: "og" });
    expect(stop.hits).toEqual([]);
    expect(stop.query.parsed.dropped).toContain("og");

    // phrase: two adjacent non-stopword words of a stored paragraph, quoted, must find that paragraph's speech
    const [para] = await sql<{ speech_id: string; lemma_seq: string; text: string }[]>`
      select speech_id, lemma_seq, text from paragraphs where cardinality(string_to_array(lemma_seq, ' ')) > 8 limit 1`;
    const seqw = para!.lemma_seq.split(" ");
    const pr = await search(sql, { q: `"${seqw[3]} ${seqw[4]}"` });
    expect(pr.hits.some((h) => h.speechId === para!.speech_id)).toBe(true);
    // the same two lemmas reversed are a different phrase
    const rev = await search(sql, { q: `"${seqw[4]} ${seqw[3]}"` });
    if (!para!.lemma_seq.includes(`${seqw[4]} ${seqw[3]}`)) {
      expect(rev.hits.some((h) => h.speechId === para!.speech_id)).toBe(false);
    }

    // paging: disjoint pages whose concatenation equals the unpaged order (relevance and newest)
    for (const sort of ["relevance", "newest"] as const) {
      const all = await search(sql, { q: "forseti", limit: 25, sort });
      if (all.hits.length < 3) continue;
      const p1 = await search(sql, { q: "forseti", limit: 2, sort });
      expect(p1.nextCursor).toBeTruthy();
      const p2 = await search(sql, { q: "forseti", limit: 2, sort, cursor: p1.nextCursor! });
      const ids = [...p1.hits, ...p2.hits].map((h) => h.speechId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(all.hits.slice(0, ids.length).map((h) => h.speechId));
      if (sort === "newest") {
        const t = all.hits.map((h) => h.started);
        expect(t).toEqual([...t].sort().reverse());
      }
    }
  });

  test("tokens: parallel arrays line up with paragraphs; phrase search by adjacency over seq_vector", async () => {
    if (!ok) return;
    const n = await sql`select count(*)::int n from paragraphs`;
    const t = await sql`select count(*)::int n from paragraph_tokens`;
    expect(t[0]!.n).toBe(n[0]!.n);
    const bad = await sql`
      select count(*)::int n from paragraph_tokens
      where cardinality(surface) <> cardinality(lemma) or cardinality(lemma) <> cardinality(pos)
         or cardinality(pos) <> cardinality(conf) or cardinality(conf) <> cardinality(start) or cardinality(start) <> cardinality(len)`;
    expect(bad[0]!.n).toBe(0);
    // offsets index into the stored paragraph text
    const [row] = await sql`
      select p.text, t.surface[1] s1, t.start[1] st1, t.len[1] ln1 from paragraph_tokens t
      join paragraphs p using (speech_id, seq) limit 1`;
    expect(row!.text.slice(row!.st1, row!.st1 + row!.ln1)).toBe(row!.s1);
    // take two adjacent lemmas from a stored sequence and find that paragraph with the phrase operator
    const [q] = await sql<{ speech_id: string; seq: number; lemma_seq: string }[]>`
      select speech_id, seq, lemma_seq from paragraphs where cardinality(string_to_array(lemma_seq, ' ')) > 6 limit 1`;
    const w = q!.lemma_seq.split(" ");
    const phrase = `'${w[2]}' <-> '${w[3]}'`;
    const hit = await sql`select 1 from paragraphs where speech_id = ${q!.speech_id} and seq = ${q!.seq} and seq_vector @@ to_tsquery('simple', ${phrase})`;
    expect(hit.length).toBe(1);
    const miss = await sql`select 1 from paragraphs where speech_id = ${q!.speech_id} and seq = ${q!.seq} and seq_vector @@ to_tsquery('simple', ${`'${w[3]}' <-> '${w[2]}'`})`;
    // reversed order only matches if the pair also occurs reversed in the same paragraph
    expect(miss.length === 0 || q!.lemma_seq.includes(`${w[3]} ${w[2]}`)).toBe(true);
  });

  test("speech attributes decoded on ingest", async () => {
    if (!ok) return;
    const r = await sql`select speaker_capacity, continued, nefnd from speeches where text_state = 'done'`;
    expect(r.length).toBe(5);
    expect(r.every((x) => x.continued === false)).toBe(true);
    expect(r.some((x) => x.speaker_capacity === "þingmaður" || x.speaker_capacity === "ráðherra" || x.speaker_capacity === "forseti")).toBe(true);
  });

  test("reindex restores missing and stale token rows from stored text, newest first, idempotently", async () => {
    if (!ok) return;
    const before = await sql`select speech_id, seq, lemma_seq from paragraphs order by speech_id, seq`;
    // simulate the pre-0002 state for one speech and a stale lemma-is version for another
    const ids = [...new Set(before.map((r) => r.speech_id as string))];
    await sql`delete from paragraph_tokens where speech_id = ${ids[0]!}`;
    await sql`update paragraphs set lemma_seq = '' where speech_id = ${ids[0]!}`;
    await sql`update paragraph_tokens set lemma_is_version = 'lemma-is@0.0.1+old' where speech_id = ${ids[1]!}`;
    const stats = await reindex(sql, { batch: 3 });
    const expected = before.filter((r) => r.speech_id === ids[0] || r.speech_id === ids[1]).length;
    expect(stats.paragraphs).toBe(expected);
    const after = await sql`select speech_id, seq, lemma_seq from paragraphs order by speech_id, seq`;
    expect(after).toEqual(before);
    expect((await sql`select count(*)::int n from paragraph_tokens where lemma_is_version like '%0.0.1%'`)[0]!.n).toBe(0);
    expect((await reindex(sql)).paragraphs).toBe(0); // nothing left to do
    expect((await sql`select count(*)::int n from speeches where text_state = 'done' and lemma_is_version = ${stats.version}`)[0]!.n).toBe(5);
  });

  test("vocab: did-you-mean proposes corpus words for an unknown word, nothing for a known one", async () => {
    if (!ok) return;
    await sql`refresh materialized view vocab`;
    const w = (await sql`select word as w from vocab where length(word) between 9 and 14 order by ndoc desc, word limit 1`)[0]!.w as string;
    // swap two inner letters: a typical typo
    const typo = w.slice(0, 3) + w[4] + w[3] + w.slice(5);
    expect((await suggest(sql, w)).length).toBe(0);
    const s = await suggest(sql, typo);
    expect(s.length).toBe(1);
    expect(s[0]!.suggestions).toContain(w);
  });

  test("members: trigram name lookup, routed only on a clear winner", async () => {
    if (!ok) return;
    const m = await findMembers(sql, "Aðalsteinn Leifsson");
    expect(m[0]!.name).toBe("Aðalsteinn Leifsson");
    expect(clearWinner(m)?.id).toBe(1547);
    expect(await findMembers(sql, "veiðigjald")).toEqual([]); // one word is not a name
    expect(clearWinner([{ id: 1, name: "a", score: 0.9 }, { id: 2, name: "b", score: 0.85 }])).toBeNull();
  });

  test("persona filters: party via seats ON THE SPEECH DATE, office, debate, capacity", async () => {
    if (!ok) return;
    const [sp] = await sql<{ id: string; member_id: number; speech_date: string; office: string | null; debate: string; cap: string | null }[]>`
      select id, member_id, speech_date::text, office, debate, speaker_capacity as cap from speeches
      where text_state = 'done' and office is not null order by id limit 1`;
    expect(sp).toBeDefined();
    const [para] = await sql<{ text: string }[]>`select text from paragraphs where speech_id = ${sp!.id} order by length(text) desc limit 1`;
    const word = para!.text.split(" ").map((w) => w.replace(/[^\p{L}]/gu, "")).find((w) => w.length > 7)!;
    const has = async (extra: object) => (await search(sql, { q: word, ...extra })).hits.some((h) => h.speechId === sp!.id);

    await sql`insert into parties (id, name) values (7777, 'Testflokkur'), (7778, 'Varaflokkur'), (7779, 'Seinniflokkur') on conflict do nothing`;
    await sql`
      insert into seats (member_id, lthing, kind, party_id, from_date, to_date) values
        (${sp!.member_id}, 148, 'þingmaður',   7777, (${sp!.speech_date}::date - 30), (${sp!.speech_date}::date + 30)),
        (${sp!.member_id}, 148, 'með varamann', 7778, (${sp!.speech_date}::date - 30), (${sp!.speech_date}::date + 30)),
        (${sp!.member_id}, 148, 'þingmaður',   7779, (${sp!.speech_date}::date + 31), (${sp!.speech_date}::date + 90))`;
    expect(await has({})).toBe(true);
    expect(await has({ partyId: 7777 })).toBe(true); // sitting for 7777 on the date
    expect(await has({ partyId: 7778 })).toBe(false); // "með varamann" = on leave, does not count
    expect(await has({ partyId: 7779 })).toBe(false); // joined later: party-at-time, not party-of-session

    expect(await has({ office: sp!.office!.slice(0, 3) })).toBe(true);
    expect(await has({ office: "zzzz" })).toBe(false);
    expect(await has({ debate: [sp!.debate] })).toBe(true);
    expect(await has({ debate: ["1"] })).toBe(sp!.debate === "1");
    if (sp!.cap) {
      expect(await has({ capacity: sp!.cap })).toBe(true);
      expect(await has({ capacity: "óþekkt" })).toBe(false);
    }
  });

  test("numbers in a query filter on the surface text instead of vanishing; matter-title card for numeric titles", async () => {
    if (!ok) return;
    // the long 2010 budget-debate speech mentions years ("árið 1986"): index its day, then ingest its text
    await upsertSpeechIndex(sql, parseSpeechList(fx("days/p20100309.xml")));
    await ingestSpeechXml(sql, "rad20100309T144735", fx("sample/speech_p20100309_rad20100309T144735_xml.xml"));
    // a paragraph where a word sits directly before a 4-digit year ("árið 1986")
    const [row] = await sql<{ speech_id: string; text: string }[]>`
      select speech_id, text from paragraphs where text ~ '[[:alpha:]]{4,} [0-9]{4}([^0-9]|$)' order by speech_id limit 1`;
    expect(row).toBeDefined();
    const m = row!.text.match(/(\p{L}{4,}) (\d{4})(?!\d)/u)!;
    const word = m[1]!, num = m[2]!;
    const withNum = await search(sql, { q: `${word} ${num}` });
    expect(withNum.query.parsed.numbers).toEqual([num]);
    expect(withNum.hits.some((h) => h.speechId === row!.speech_id)).toBe(true);
    expect((await search(sql, { q: `${word} 99999` })).hits).toEqual([]);

    const budget = await search(sql, { q: "fjárlög 2026", currentLthing: 157 });
    expect(budget.matterCards.some((c) => c.lthing === 157 && c.cls === "A" && c.nr === 1)).toBe(true);
    expect(budget.query.description).toContain('"2026"');
    // the title card must match the number too: a different year finds no card for that matter
    expect((await search(sql, { q: "fjárlög 2019", currentLthing: 157 })).matterCards.some((c) => c.nr === 1 && c.lthing === 157)).toBe(false);
  });

  test("matter detail: documents, votes with counts, consultations, links, laws; idempotent; queue drains", async () => {
    if (!ok) return;
    await upsertCommittees(sql, parseCommittees(fx("sample/nefndir_157.xml")));
    const before = (await matterDetailQueue(sql, 157, 5000)).length;
    expect(before).toBe(729); // session 157: 729 A-mál need a detail request (B-mál are covered by speech-derived stubs)
    const d300 = parseMatterDetail(fx("sample/thingmal_157_300.xml"));
    const d1 = parseMatterDetail(fx("sample/thingmal_157_1.xml"));
    for (let i = 0; i < 2; i++) { // twice: re-running must not duplicate anything
      await upsertMatterDetail(sql, d300, lemmaText);
      await upsertMatterDetail(sql, d1, lemmaText);
    }
    expect((await matterDetailQueue(sql, 157, 5000)).length).toBe(before - 2);
    const m = (await sql`select status_text, detail_fetched_at is not null as fetched, stub from matters where lthing = 157 and cls = 'A' and nr = 300`)[0]!;
    expect(m).toMatchObject({ status_text: "Samþykkt sem lög frá Alþingi.", fetched: true, stub: false });
    const n = async (t: string, w = "lthing = 157 and nr = 300") => (await sql.unsafe(`select count(*)::int n from ${t} where ${w}`))[0]!.n;
    expect(await n("documents", "lthing = 157 and matter_nr = 300")).toBe(7);
    expect(await n("votes")).toBe(36);
    expect(await n("consultation_requests")).toBe(38);
    expect(await n("submissions")).toBe(17);
    expect(await n("matter_laws")).toBe(1);
    expect(await n("matter_links")).toBe(1);
    expect(await n("matter_efnisflokkar")).toBe(4);
    expect(await n("votes", "lthing = 157 and nr = 1")).toBe(122);
    // the "law page" join: which matters amended lög nr. 34/1991?
    const amend = await sql`select lthing, nr, title from matter_laws l join matters m using (lthing, cls, nr) where law_year = 1991 and law_nr = 34`;
    expect(amend.map((r) => `${r.lthing}/${r.nr}`)).toContain("157/300");
    // vote summary join: a recorded electronic vote with counts
    const v = (await sql`select yes, no, abstain, result, method from votes where id = 68539`)[0]!;
    expect(v).toMatchObject({ yes: 33, no: 0, abstain: 0, result: "samþykkt", method: "atkvæðagreiðslukerfi" });
    // the 1999-style quirk: committees discovered via consultations never overwrite the official list
    expect((await sql`select name from committees where id = 201`)[0]!.name).toBe("allsherjar- og menntamálanefnd");
  });
});

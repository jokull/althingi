import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { type Sql, connect, migrate, upsertCommittees, upsertMatterDetail, upsertMatters, upsertMembers, upsertSeats, upsertSessions, upsertSpeechIndex } from "../src/db.ts";
import { ingestSpeechXml } from "../src/ingest.ts";
import { lemmaText } from "../src/lemma.ts";
import { parseXml, descendants, kids, text as xmlText } from "../src/xml.ts";
import { parseCommittees, parseMatterDetail, parseMatterList, parseMembers, parseSeats, parseSessions, parseSpeechList } from "../src/parse.ts";
import { createApp } from "../src/web.tsx";
import { nameMatches, personLike, searchEntities, topResult, type EntityResult } from "../src/entities.ts";

const ADMIN = process.env.TEST_PG ?? "postgres://postgres:dev@localhost:5433/postgres";
const NAME = `althingi_web_${process.pid}`;
const fx = (p: string) => readFileSync(new URL(`../fixtures/${p}`, import.meta.url), "utf8");

let sql: Sql;
let admin: postgres.Sql;
let ok = false;
let speechId = "";
let word = "";

beforeAll(async () => {
  admin = postgres(ADMIN, { max: 1, onnotice: () => {} });
  try { await admin`select 1`; } catch (e) { console.warn("skipping web tests (no Postgres):", (e as Error).message); return; }
  await admin.unsafe(`create database ${NAME}`);
  sql = connect(ADMIN.replace(/\/[^/]*$/, `/${NAME}`));
  await migrate(sql);
  await upsertSessions(sql, parseSessions(fx("lthing.xml")));
  await upsertMembers(sql, parseMembers(fx("sample/thingmenn_157.xml")));
  await upsertMatters(sql, parseMatterList(fx("sample/thingmalalisti_157.xml")), lemmaText);
  await upsertSeats(sql, parseSeats(fx("sample/thingseta_633.xml")));
  await upsertCommittees(sql, parseCommittees(fx("sample/nefndir_157.xml")));
  await upsertMatterDetail(sql, parseMatterDetail(fx("sample/thingmal_157_300.xml")), lemmaText);
  await upsertSpeechIndex(sql, parseSpeechList(fx("days/d20180306.xml")), lemmaText);
  const f = "sample/speech_d20180306_rad20180306T163325_xml.xml";
  speechId = "rad20180306T163325";
  await ingestSpeechXml(sql, speechId, fx(f));
  const [p] = await sql<{ text: string }[]>`select text from paragraphs where speech_id = ${speechId} order by length(text) desc limit 1`;
  word = p!.text.split(" ").map((w) => w.replace(/[^\p{L}]/gu, "")).find((w) => w.length > 7)!;
  ok = true;
});
afterAll(async () => {
  if (!ok) return;
  await sql.end();
  await admin.unsafe(`drop database ${NAME} with (force)`);
  await admin.end();
});

const get = async (path: string, headers: Record<string, string> = {}, app = createApp(sql)) =>
  app.request(`http://x${path}`, { headers, redirect: "manual" });

describe("web", () => {
  test("home, healthz, about, assets", async () => {
    if (!ok) return;
    const home = await get("/");
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("Leit í ræðum Alþingis");
    const h = await (await get("/healthz")).json() as { ok: boolean; speeches: number };
    expect(h).toMatchObject({ ok: true, speeches: 1, unresolved_speakers: 0, last_dump_drop: null, blocked_runs_24h: 0 });
    expect(h).toHaveProperty("pending_texts");
    expect(h).toHaveProperty("last_poll_at");
    expect((await get("/um")).status).toBe(200);
    const css = await get("/app.css");
    expect(css.headers.get("content-type")).toContain("text/css");
    expect((await get("/htmx.min.js")).status).toBe(200);
  });

  test("search renders highlighted hits with the expansion chip and short edge TTL; partial has no layout", async () => {
    if (!ok) return;
    const r = await get(`/leit?q=${encodeURIComponent(word)}`);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain("<mark>");
    expect(body).toContain("Leitað að:");
    expect(body).toContain(`/raeda/${speechId}`);
    expect(r.headers.get("cache-control")).toContain("s-maxage=60");
    const part = await get(`/leit/rows?q=${encodeURIComponent(word)}`);
    const pb = await part.text();
    expect(pb).toContain("<article");
    expect(pb).not.toContain("<html");
  });

  test("zero hits explain themselves (boundary, interjections) instead of a blank page", async () => {
    if (!ok) return;
    const body = await (await get("/leit?q=hvalkjötsframleiðsla")).text();
    expect(body).toContain("Engar niðurstöður");
    expect(body).toContain("frá 2005");
    expect(body).toContain("Framíköll eru ekki leitarbær");
  });

  test("routing: laws, matters, documents, member names; blank query goes home", async () => {
    if (!ok) return;
    const loc = async (q: string) => (await get(`/leit?q=${encodeURIComponent(q)}`)).headers.get("location");
    expect(await loc("lög nr. 34/1991")).toBe("/log/1991/34");
    expect(await loc("þskj. 421")).toMatch(/^\/thingskjal\/\d+\/421$/);
    expect(await loc("300. mál")).toMatch(/^\/mal\/\d+\/a\/300$/);
    expect(await loc("Aðalsteinn Leifsson")).toBe("/thingmadur/1547");
    const blank = await get("/leit?q=");
    expect(blank.status).toBe(302);
    expect(blank.headers.get("location")).toBe("/");
  });

  test("speech page: anchors per paragraph, citation, 404 for junk ids", async () => {
    if (!ok) return;
    const r = await get(`/raeda/${speechId}`);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain('id="mgr-1"');
    expect(body).toContain("Tilvitnun");
    expect(body).toContain(`/raeda/${speechId}`);
    expect(body).toContain('type="application/ld+json"');
    expect((await get("/raeda/nonsense")).status).toBe(404);
    expect((await get("/raeda/rad20000101T000000")).status).toBe(404);
  });

  test("matter page shows status, documents, votes with counts, consultations; class case is canonical", async () => {
    if (!ok) return;
    const r = await get("/mal/157/a/300");
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain("Samþykkt sem lög frá Alþingi.");
    expect(body).toContain('Þingskjöl <span class="n">7</span>');
    expect(body).toContain('Atkvæðagreiðslur <span class="n">36</span>');
    expect(body).toContain("lög nr. 34/1991");
    const up = await get("/mal/157/A/300");
    expect(up.status).toBe(301);
    expect(up.headers.get("location")).toBe("/mal/157/a/300");
    expect((await get("/mal/157/a/999999")).status).toBe(404);
    expect((await get("/mal/abc/a/1")).status).toBe(404);
    // B-mál are honest about having no documents
    const b = await sql<{ nr: number }[]>`select nr from matters where lthing = 148 and cls = 'B' limit 1`;
    expect(await (await get(`/mal/148/b/${b[0]!.nr}`)).text()).toContain("B-mál");
  });

  test("law page lists the matters that amended the law", async () => {
    if (!ok) return;
    const body = await (await get("/log/1991/34")).text();
    expect(body).toContain("rýni á fjárfestingum erlendra aðila");
    expect(body).toContain("Mál sem breyta lögunum (1)");
  });

  test("day and member pages; an empty day is a 404 that still navigates", async () => {
    if (!ok) return;
    const day = await get("/dagur/2018-03-06");
    expect(day.status).toBe(200);
    expect(await day.text()).toContain("6. mars 2018");
    const empty = await get("/dagur/2000-01-01");
    expect(empty.status).toBe(404);
    expect((await get("/dagur/not-a-date")).status).toBe(404);
    const mem = await get("/thingmadur/1547");
    expect(mem.status).toBe(200);
    expect(await mem.text()).toContain("Aðalsteinn Leifsson");
    expect((await get("/thingmadur/999999999")).status).toBe(404);
  });

  test("caching: a session still being ingested is NOT immutable; a complete one is; ETag revalidates", async () => {
    if (!ok) return;
    // 148 still has pending speeches (only 1 of 81 has text) -> short TTL
    const live = await get(`/raeda/${speechId}`);
    expect(live.headers.get("cache-control")).toContain("s-maxage=300");
    expect(live.headers.get("cache-control")).not.toContain("31536000");
    // finish the session (no pending left) and use a fresh app so the 60 s state cache is not reused
    await sql`update speeches set text_state = 'error' where lthing = 148 and text_state = 'pending'`;
    // every text in, but its A-mál have no matter detail yet (a dump-ingested session): still short TTLs
    if ((await sql`select 1 from matters where lthing = 148 and cls = 'A'`).length) {
      const textsOnly = await get(`/raeda/${speechId}`, {}, createApp(sql));
      expect(textsOnly.headers.get("cache-control")).toContain("s-maxage=300");
    }
    await sql`update matters set detail_fetched_at = now() where lthing = 148 and cls = 'A'`;
    const done = await get(`/raeda/${speechId}`, {}, createApp(sql));
    expect(done.headers.get("cache-control")).toContain("s-maxage=31536000");
    expect(done.headers.get("cache-control")).toContain("stale-if-error");
    const etag = done.headers.get("etag");
    expect(etag).toBeTruthy();
    const again = await get(`/raeda/${speechId}`, { "if-none-match": etag! }, createApp(sql));
    expect(again.status).toBe(304);
  });
});

describe("omnisearch", () => {
  test("name matching is word-prefix, not fuzzy; a near-miss is never the top result", () => {
    expect(nameMatches("Katrín Jakobsdóttir", "katrín jak")).toBe(true);
    expect(nameMatches("Katrín Sif Árnadóttir", "katrín jakobsdóttir")).toBe(false);
    expect(personLike("katrín jakobsdóttir")).toBe(true);
    expect(personLike("veiðigjöld")).toBe(false);
    const empty: EntityResult = { mal: [], thingmenn: [], flokkar: [], nefndir: [], efni: [], atkvaedi: [], umsagnir: [], log: [] };
    const sif = { kind: "thingmenn" as const, href: "/thingmadur/1", title: "Katrín Sif Árnadóttir", meta: "", strong: false };
    expect(topResult({ ...empty, thingmenn: [sif] }, "katrín jakobsdóttir")).toBeNull();
    const exact = { ...sif, title: "Katrín Jakobsdóttir", strong: true };
    expect(topResult({ ...empty, thingmenn: [sif, exact] }, "Katrín Jakobsdóttir")).toBe(exact);
  });

  test("a person-like query with no member says what the corpus covers", async () => {
    if (!ok) return;
    const body = await (await get(`/leit?q=${encodeURIComponent("sigrún hrafnkelsdóttir")}`)).text();
    expect(body).toContain("Enginn þingmaður í safninu heitir");
    expect(body).toContain("löggjafarþings");
  });

  test("senders collapse to one row per sender and matter", async () => {
    if (!ok) return;
    const e = await searchEntities(sql, "Samtök atvinnulífsins", 157);
    expect(e.umsagnir.length).toBeGreaterThan(0);
    const keys = e.umsagnir.map((u) => `${u.title}|${u.href}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("party page lists members and links from party entities", async () => {
    if (!ok) return;
    const [p] = await sql<{ id: number; name: string }[]>`select p.id, p.name from parties p join seats s on s.party_id = p.id where s.member_id = 633 order by s.lthing desc limit 1`;
    const r = await get(`/flokkur/${p!.id}`);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain(p!.name);
    expect(body).toContain("Þórunn Sveinbjarnardóttir");
    expect((await get("/flokkur/999999")).status).toBe(404);
    const e = await searchEntities(sql, p!.name, 157);
    expect(e.flokkar[0]?.href).toBe(`/flokkur/${p!.id}`);
  });
});

describe("feeds and export", () => {
  test("search Atom feed is valid XML with entries linking to speeches; newest feed too", async () => {
    if (!ok) return;
    const r = await get(`/leit/atom?q=${encodeURIComponent(word)}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/atom+xml");
    const root = parseXml(await r.text()); // throws if not well-formed
    const entries = descendants(root, "entry");
    expect(entries.length).toBeGreaterThan(0);
    const link = kids(entries[0]!, "link")[0]!.attribs.href!;
    expect(link).toContain(`/raeda/${speechId}`);
    expect(xmlText(kids(entries[0]!, "title")[0]!)).toContain("ræða");
    expect((await get("/leit/atom")).status).toBe(400);
    const latest = parseXml(await (await get("/nyjast/atom")).text());
    expect(descendants(latest, "entry").length).toBe(1); // one speech with text in this DB
  });

  test("CSV export: BOM, header, one row per speech, quotes and commas escaped", async () => {
    if (!ok) return;
    const r = await get(`/leit.csv?q=${encodeURIComponent(word)}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/csv");
    expect(r.headers.get("content-disposition")).toContain("attachment");
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // Excel-friendly UTF-8 BOM (Response.text() would strip it)
    const body = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    const lines = body.slice(1).trim().split("\r\n");
    expect(lines[0]).toBe("speech_id,date,time,member_id,member,party_at_date,speech_type,lthing,matter_class,matter_nr,matter_title,url,snippet");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[1]!.startsWith(speechId)).toBe(true);
    expect((await get("/leit.csv")).status).toBe(400);
  });
});

// ---------------------------------------------------------------- MCP
const rpc = async (method: string, params?: object, id = 1) => {
  const res = await createApp(sql).request("http://x/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const t = await res.text();
  const json = JSON.parse(t.match(/\{.*\}/s)![0]);
  return { res, json };
};
const call = async (name: string, args: object) => {
  const { json } = await rpc("tools/call", { name, arguments: args });
  expect(json.error).toBeUndefined();
  return JSON.parse(json.result.content[0].text);
};

describe("mcp", () => {
  test("protocol: initialize + tools/list; all tools read-only; never cached", async () => {
    if (!ok) return;
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    expect(init.json.result.serverInfo.name).toBe("althingi-search");
    expect(init.json.result.instructions).toContain("from 2005 only");
    expect(init.res.headers.get("cache-control")).toMatch(/^no-(store|cache)$/); // POST event-stream: never cacheable
    const { json } = await rpc("tools/list", undefined, 2);
    const names = json.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["aggregate", "explain_query", "first_use", "get_context", "get_matter", "get_member", "get_speech", "list_sessions", "list_votes", "search_speeches"]);
    expect(json.result.tools.every((t: { annotations: { readOnlyHint: boolean } }) => t.annotations.readOnlyHint)).toBe(true);
  });

  test("search_speeches: chainable ids, urls, corpus block, party_at_date, small payload", async () => {
    if (!ok) return;
    const r = await call("search_speeches", { q: word, limit: 3 });
    expect(r.corpus).toMatchObject({ text_from: "2005" });
    expect(r.hits.length).toBeGreaterThan(0);
    const h = r.hits[0];
    expect(h.speech_id).toMatch(/^rad\d{8}T\d{6}$/);
    expect(h.url).toContain(`/raeda/${h.speech_id}`);
    expect(h.paragraphs[0].url).toContain("#mgr-");
    expect(h.member).toHaveProperty("party_at_date");
    expect(JSON.stringify(r).length).toBeLessThan(8000);
    expect(r.derived).toBe(false);
  });

  test("search_speeches zero hits: structured why, never a bare empty list", async () => {
    if (!ok) return;
    const r = await call("search_speeches", { q: "hvalkjötsframleiðsla" });
    expect(r.hits).toEqual([]);
    expect(r.why).toEqual(expect.arrayContaining(["text_corpus_starts_2005", "interjections_not_indexed", "all_query_words_must_match_in_the_same_paragraph"]));
    const stop = await call("search_speeches", { q: "og" });
    expect(stop.why).toContain("only_stopwords_or_numbers");
    expect(stop.query.dropped_stopwords).toContain("og");
  });

  test("get_speech / get_context: numbered paragraphs, citation, revision hash; unknown id is a clean error", async () => {
    if (!ok) return;
    const s = await call("get_speech", { speech_id: speechId });
    expect(s.speech.citation).toContain("2018");
    expect(s.speech.citation).toContain(`/raeda/${speechId}`);
    expect(s.speech.revision.raw_sha256).toHaveLength(64);
    expect(s.paragraphs[0].mgr).toBe(1);
    expect(s.next_from).toBeNull();
    const ctx = await call("get_context", { speech_id: speechId, mgr: 2, window: 1 });
    expect(ctx.paragraphs.filter((p: { is_target: boolean }) => p.is_target).length).toBe(1);
    expect(ctx.paragraphs.length).toBeLessThanOrEqual(3);
    expect(ctx.citation).toContain("mgr. 2");
    const missing = await call("get_speech", { speech_id: "rad20000101T000000" });
    expect(missing.error).toBe("speech_not_found");
  });

  test("get_matter: status, documents, votes with counts, laws, related; B-mál flagged", async () => {
    if (!ok) return;
    const m = await call("get_matter", { lthing: 157, class: "A", nr: 300 });
    expect(m.matter.status).toBe("Samþykkt sem lög frá Alþingi.");
    expect(m.documents.length).toBe(7);
    expect(m.votes.length).toBe(36);
    expect(m.laws_amended).toEqual([{ year: 1991, nr: 34, url: expect.stringContaining("/log/1991/34") }]);
    expect(m.related_matters[0]).toMatchObject({ relation: "lagtFramÁðurSem", lthing: 154, nr: 726 });
    expect(m.consultations).toEqual({ requests: 38, submissions_received: 17 });
    const b = await sql<{ nr: number }[]>`select nr from matters where lthing = 148 and cls = 'B' limit 1`;
    expect((await call("get_matter", { lthing: 148, class: "B", nr: b[0]!.nr })).matter.note).toContain("B-mál");
    expect((await call("get_matter", { lthing: 157, nr: 999999 })).error).toBe("matter_not_found");
  });

  test("get_member by name and id; 'með varamann' seats are marked not sitting", async () => {
    if (!ok) return;
    const m = await call("get_member", { name: "Þórunn Sveinbjarnardóttir" });
    expect(m.member.id).toBe(633);
    expect(m.seats.length).toBe(51);
    expect(m.seats.some((s: { kind: string; sitting: boolean }) => s.kind === "með varamann" && s.sitting === false)).toBe(true);
    expect(m.seats.every((s: { kind: string; sitting: boolean }) => s.kind === "með varamann" || s.sitting === true)).toBe(true);
    expect((await call("get_member", { member_id: 999999999 })).error).toBe("member_not_found");
  });

  test("list_votes, aggregate, explain_query, list_sessions, first_use", async () => {
    if (!ok) return;
    const v = await call("list_votes", { lthing: 157, class: "A", nr: 300 });
    expect(v.votes.length).toBe(36);
    expect(v.ballots_note).toContain("ekki enn");
    const byType = await call("aggregate", { metric: "speeches", group_by: "speech_type" });
    expect(byType.buckets.reduce((n: number, b: { value: number }) => n + b.value, 0)).toBe(1); // one speech with text in this DB
    const byYear = await call("aggregate", { metric: "words", group_by: "year", q: word });
    expect(byYear.buckets[0].key).toBe("2018");
    expect(byYear.query.interpreted_as.length).toBeGreaterThan(0);
    const ex = await call("explain_query", { q: '"hér á landi" veiðigjöldin' });
    expect(ex.interpreted_as).toContain('"hér á land"');
    expect(ex.phrase_tsquery).toContain("<->");
    const ss = await call("list_sessions", {});
    expect(ss.sessions.find((s: { lthing: number }) => s.lthing === 148).speeches_with_text).toBe(1);
    const fu = await call("first_use", { q: word });
    expect(fu.earliest[0].speech_id).toBe(speechId);
    expect(fu.speeches_per_year).toEqual([{ year: 2018, speeches: 1 }]);
    expect(fu.caveat).toContain("2005");
  });
});

describe("persona sweep fixes", () => {
  test("keywords are searched as typed; a known member in the keywords is only OFFERED as a filter", async () => {
    if (!ok) return;
    const [s] = await sql<{ member_id: number; member_name: string }[]>`select member_id, member_name from speeches where id = ${speechId}`;
    const r = await get(`/leit?q=${encodeURIComponent(`${s!.member_name} ${word}`)}`);
    expect(r.status).toBe(200); // no rewrite, no redirect
    const page = await r.text();
    expect(page).toContain("Sía:");
    expect(page).toContain(`thm=${s!.member_id}`);
    expect(page).not.toContain("Lesið sem:");
    // the offered filter works
    const f = await (await get(`/leit?q=${encodeURIComponent(word)}&thm=${s!.member_id}`)).text();
    expect(f).toContain(`/raeda/${speechId}`);
    // a member name WITH filters stays on the search page
    expect((await get(`/leit?q=${encodeURIComponent(s!.member_name)}&tegund=andsvar`)).status).toBe(200);
  });

  test("filters without words list speeches (browse), with a total and an oldest-first sort", async () => {
    if (!ok) return;
    const [s] = await sql<{ member_id: number }[]>`select member_id from speeches where id = ${speechId}`;
    const body = await (await get(`/leit?q=&thm=${s!.member_id}`)).text();
    expect(body).toContain(`/raeda/${speechId}`);
    const old = await (await get(`/leit?q=${encodeURIComponent(word)}&nyjast=elst`)).text();
    expect(old).toContain(`/raeda/${speechId}`);
    const j = await (await get(`/leit.json?q=${encodeURIComponent(word)}`)).json() as { total: number; hits: { speech_id: string }[] };
    expect(j.total).toBe(1);
    expect(j.hits[0]!.speech_id).toBe(speechId);
  });

  test("document, transcript, feed, topic and committee pages exist", async () => {
    if (!ok) return;
    const [d] = await sql<{ nr: number }[]>`select nr from documents where lthing = 157 and matter_nr = 300 order by nr limit 1`;
    const doc = await get(`/thingskjal/157/${d!.nr}`);
    expect(doc.status).toBe(200);
    expect(await doc.text()).toContain("althingi.is");
    expect((await get("/thingskjal/157/99999")).status).toBe(404);
    const feed = await get("/mal/157/a/300/atom");
    expect(feed.headers.get("content-type")).toContain("atom");
    expect(await feed.text()).toContain("<entry>");
    expect((await get("/mal/157/a/300/umraeda")).status).toBe(200);
    const mp = await (await get("/mal/157/a/300")).text();
    expect(mp).toContain("Ferill málsins");
    expect(mp).toContain("/mal/157/a/300/atom");
    const [t] = await sql<{ efnisflokkur_id: number }[]>`select efnisflokkur_id from matter_efnisflokkar where lthing = 157 and nr = 300 limit 1`;
    if (t) expect(await (await get(`/efni/${t.efnisflokkur_id}`)).text()).toContain("/mal/157/a/300");
    const [c] = await sql<{ committee_id: number }[]>`select committee_id from consultation_requests where lthing = 157 and nr = 300 and committee_id is not null limit 1`;
    if (c) expect(await (await get(`/nefnd/${c.committee_id}`)).text()).toContain("/mal/157/a/300");
  });

  test("did-you-mean is not shown above real hits", async () => {
    if (!ok) return;
    const body = await (await get(`/leit?q=${encodeURIComponent(word)}`)).text();
    expect(body).not.toContain("finnst ekki í safninu");
  });
});

describe("mcp persona fixes", () => {
  test("search_speeches returns a total; empty date ranges outside the corpus say so", async () => {
    if (!ok) return;
    const r = await call("search_speeches", { q: word });
    expect(r.total).toBe(1);
    const e = await call("search_speeches", { q: word, date_from: "1998-01-01", date_to: "1998-12-31" });
    expect(e.why).toContain("date_range_before_first_speech_in_corpus");
    const v = await call("list_votes", { lthing: 157, nr: 300, limit: 2 });
    expect(v.votes[0]).toHaveProperty("document_nr");
  });
});

describe("glossary and votes export", () => {
  test("'hvað er andsvar' shows the glossary entry; votes CSV per session", async () => {
    if (!ok) return;
    expect(await (await get(`/leit?q=${encodeURIComponent("hvað er andsvar")}`)).text()).toContain("Fleiri orðskýringar");
    expect(await (await get("/um")).text()).toContain("ordskyringar");
    const csv = await get("/thing/157/atkvaedagreidslur.csv");
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(await csv.text()).toContain("vote_id");
  });
});

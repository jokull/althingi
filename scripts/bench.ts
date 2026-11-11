#!/usr/bin/env bun
// Replays a fixed set of web + MCP query shapes against the database, serially, and prints p50/p95/max per query and
// overall (docs/PERFORMANCE.md §5). Server time only: the functions behind the routes, no HTTP, no edge.
//
//   DATABASE_URL=… bun scripts/bench.ts [--rounds 3] [--only substring] [--json FILE]
//
// Uses the MCP pool's settings (8 s statement timeout, work_mem 32MB) so a baseline that would time out on the web role
// still produces a number. A query that errors counts as the timeout. Round 0 warms the cache and is not counted.
import { parseArgs } from "node:util";
import postgres from "postgres";
import { searchEntities } from "../src/entities.ts";
import * as T from "../src/mcp-tools.ts";
import { corpusStats, dayPage, matterExtras, matterPage, memberPage, sessionState, speechPage } from "../src/queries.ts";
import { search } from "../src/search.ts";

const { values: v } = parseArgs({ options: { rounds: { type: "string" }, only: { type: "string" }, json: { type: "string" } } });
const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_RO;
if (!url) throw new Error("DATABASE_URL is not set");
// the MCP pool's settings (src/server.ts): 8 s timeout, the web role's work_mem, the planner guards
const sql = postgres(url, { max: 1, onnotice: () => {}, connection: { statement_timeout: 8000, work_mem: "32MB", enable_seqscan: process.env.BENCH_SEQSCAN ?? "off", jit: "off" } });
const TIMEOUT_MS = 8000;
const ROUNDS = Number(v.rounds ?? 3);

const cur = (await sql<{ l: number }[]>`select max(lthing) as l from speeches where text_state = 'done'`)[0]?.l ?? 0;
const ctx = { sql, currentLthing: cur };
const S = (p: Parameters<typeof search>[1]) => () => search(sql, { currentLthing: cur, withTotal: true, limit: 10, ...p });

// the fixed set: names are stable so runs can be compared across commits
type Case = [string, () => Promise<unknown>];
const CASES: Case[] = ([
  ["web search veiðigjald", S({ q: "veiðigjald" })],
  ["web search sjávarútvegur", S({ q: "sjávarútvegur" })],
  ["web search verðbólga", S({ q: "verðbólga" })],
  ["web search húsnæðislán vextir", S({ q: "húsnæðislán vextir" })],
  ["web search loftslagsmál", S({ q: "loftslagsmál" })],
  ["web search Landspítali biðlistar", S({ q: "Landspítali biðlistar" })],
  ["web search phrase \"hér á landi\"", S({ q: "\"hér á landi\"" })],
  ["web search fjárlög 2026", S({ q: "fjárlög 2026" })],
  ["web search forseti (near-stopword)", S({ q: "forseti" })],
  ["web search hælisleitendur newest", S({ q: "hælisleitendur", sort: "newest" })],
  ["web search veiðigjald 2017-2019 (agent)", S({ q: "veiðigjald", dateFrom: "2017-01-01", dateTo: "2019-12-31" })],
  ["web search veiðigjald 2020-2024 (agent)", S({ q: "veiðigjald", dateFrom: "2020-01-01", dateTo: "2024-12-31" })],
  ["web search veiðigjald party 35", S({ q: "veiðigjald", partyId: 35 })],
  ["web search veiðigjald member 690", S({ q: "veiðigjald", memberId: 690 })],
  ["web browse member 690", S({ q: "", memberId: 690 })],
  ["web search page 2 veiðigjald", async () => { const r = await search(sql, { q: "veiðigjald", currentLthing: cur, limit: 10 }); return search(sql, { q: "veiðigjald", currentLthing: cur, limit: 10, cursor: r.nextCursor ?? undefined }); }],
  ["mcp search_speeches veiðigjald 2005-2026 limit 50", () => T.searchSpeeches(ctx, { q: "veiðigjald", date_from: "2005-01-01", date_to: "2026-12-31", limit: 50 })],
  ["mcp search_speeches veiðigjöld sjávarútvegur limit 50", () => T.searchSpeeches(ctx, { q: "veiðigjöld sjávarútvegur", limit: 50 })],
  ["mcp aggregate member sjávarútvegur", () => T.aggregate(ctx, { metric: "speeches", group_by: "member", q: "sjávarútvegur" })],
  ["mcp aggregate words party", () => T.aggregate(ctx, { metric: "words", group_by: "party" })],
  ["mcp aggregate words party kvóti", () => T.aggregate(ctx, { metric: "words", group_by: "party", q: "kvóti" })],
  ["mcp aggregate words year veiðigjald", () => T.aggregate(ctx, { metric: "words", group_by: "year", q: "veiðigjald" })],
  ["mcp aggregate speeches year", () => T.aggregate(ctx, { metric: "speeches", group_by: "year" })],
  ["mcp aggregate speeches party veiðigjald 2005-2026", () => T.aggregate(ctx, { metric: "speeches", group_by: "party", q: "veiðigjald", date_from: "2005-01-01", date_to: "2026-12-31" })],
  ["mcp first_use veiðigjald", () => T.firstUse(ctx, { q: "veiðigjald" })],
  ["mcp first_use kvótakerfi", () => T.firstUse(ctx, { q: "kvótakerfi" })],
  ["mcp get_matter 157/A/300", () => T.getMatter(ctx, { lthing: 157, nr: 300 })],
  ["mcp get_member 690", () => T.getMember(ctx, { member_id: 690 })],
  ["mcp get_speech", () => T.getSpeech(ctx, { speech_id: "rad20180306T163325" })],
  ["mcp list_sessions", () => T.listSessions(ctx)],
  ["entities katrín", () => searchEntities(sql, "katrín", cur, 8)],
  ["entities sjálfstæðisflokkur", () => searchEntities(sql, "sjálfstæðisflokkur", cur, 8)],
  ["entities veiðigjald", () => searchEntities(sql, "veiðigjald", cur, 8)],
  ["page matter 157/a/300", async () => [await matterPage(sql, 157, "A", 300), await matterExtras(sql, 157, "A", 300)]],
  ["page member 690", () => memberPage(sql, 690)],
  ["page day 2024-03-05", () => dayPage(sql, "2024-03-05")],
  ["page speech", () => speechPage(sql, "rad20180306T163325")],
  ["state corpusStats", () => corpusStats(sql)],
  ["state sessionState", () => sessionState(sql)],
  ["state corpusBlock", () => T.corpusBlock(sql)],
] as Case[]).filter(([n]) => !v.only || n.includes(v.only));

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };
const samples = new Map<string, number[]>();
let errors = 0;
for (let round = 0; round <= ROUNDS; round++) {
  for (const [name, fn] of CASES) {
    const t0 = performance.now();
    let ms: number;
    try { await fn(); ms = performance.now() - t0; }
    catch (e) { ms = Math.max(TIMEOUT_MS, performance.now() - t0); if (round > 0) { errors++; console.error(`  ! ${name}: ${(e as Error).message.split("\n")[0]}`); } }
    if (round > 0) (samples.get(name) ?? samples.set(name, []).get(name)!).push(ms);
  }
}
const all: number[] = [];
const rows: { name: string; p50: number; p95: number; max: number }[] = [];
for (const [name, xs] of samples) { all.push(...xs); rows.push({ name, p50: pct(xs, 0.5), p95: pct(xs, 0.95), max: Math.max(...xs) }); }
const f = (n: number) => n.toFixed(0).padStart(6);
console.log(`\n${"query".padEnd(52)} ${"p50".padStart(6)} ${"p95".padStart(6)} ${"max".padStart(6)}  (ms, ${ROUNDS} rounds, current session ${cur})`);
for (const r of rows) console.log(`${r.name.padEnd(52)} ${f(r.p50)} ${f(r.p95)} ${f(r.max)}`);
console.log(`${"ALL".padEnd(52)} ${f(pct(all, 0.5))} ${f(pct(all, 0.95))} ${f(Math.max(...all))}  errors=${errors}`);
if (v.json) await Bun.write(v.json, JSON.stringify({ at: new Date().toISOString(), rounds: ROUNDS, current: cur, rows, all: { p50: pct(all, 0.5), p95: pct(all, 0.95), max: Math.max(...all) }, errors }, null, 2));
await sql.end();

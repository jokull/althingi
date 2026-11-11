// Agent-facing surfaces: MCP over Streamable HTTP without auth, CORS, rate limiting, new tools, resources, Markdown and
// JSON variants, and every discovery file (llms.txt, robots, sitemaps, .well-known, <link rel>, server.json).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createApp, ROBOTS } from "../src/web.tsx";
import { serverJson } from "../src/agent-docs.ts";
import { VERSION } from "../src/mcp.ts";
import { seed, type Seeded } from "./seed.ts";

let s: Seeded | null = null;
beforeAll(async () => { s = await seed(`althingi_agents_${process.pid}`); });
afterAll(async () => { await s?.drop(); });

const app = () => createApp(s!.sql);
const get = (path: string, headers: Record<string, string> = {}, a = app()) => a.request(`http://x${path}`, { headers, redirect: "manual" });
const post = (body: object, headers: Record<string, string> = {}, a = app()) =>
  a.request("http://x/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
const rpc = async (method: string, params?: object, a = app()) => {
  const res = await post({ jsonrpc: "2.0", id: 1, method, params }, {}, a);
  return { res, json: await res.json() as any };
};
const call = async (name: string, args: object) => {
  const { json } = await rpc("tools/call", { name, arguments: args });
  expect(json.error).toBeUndefined();
  return json.result as { content: { type: string; text?: string; uri?: string }[]; structuredContent: any; isError?: boolean };
};

describe("mcp transport without auth", () => {
  test("initialize (latest and older protocol) -> tools/list -> tools/call, plain JSON, no auth challenge", async () => {
    if (!s) return;
    for (const v of ["2025-11-25", "2025-06-18"]) {
      const { res, json } = await rpc("initialize", { protocolVersion: v, capabilities: {}, clientInfo: { name: "t", version: "0" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("www-authenticate")).toBeNull();
      expect(res.headers.get("mcp-session-id")).toBeNull();
      expect(json.result.protocolVersion).toBe(v);
      expect(json.result.capabilities).toHaveProperty("tools");
      expect(json.result.capabilities).toHaveProperty("resources");
      expect(json.result.capabilities).toHaveProperty("prompts");
    }
    const list = await rpc("tools/list");
    expect(list.json.result.tools.length).toBe(17);
    const r = await call("list_sessions", {});
    expect(r.structuredContent.sessions.length).toBeGreaterThan(0);
  });

  test("no OAuth metadata: clients must not start an auth flow", async () => {
    if (!s) return;
    for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server"]) {
      expect((await get(p)).status).toBe(404);
    }
  });

  test("GET: browser gets the connect page, anything else 405; DELETE 405", async () => {
    if (!s) return;
    const page = await get("/mcp", { accept: "text/html,application/xhtml+xml" });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("https://althingi.solberg.is/mcp");
    const sse = await get("/mcp", { accept: "text/event-stream" });
    expect(sse.status).toBe(405);
    expect(sse.headers.get("allow")).toContain("POST");
    const del = await app().request("http://x/mcp", { method: "DELETE" });
    expect(del.status).toBe(405);
  });

  test("CORS: preflight and actual response allow any origin and the MCP headers", async () => {
    if (!s) return;
    const pre = await app().request("http://x/mcp", { method: "OPTIONS", headers: { origin: "https://claude.ai", "access-control-request-method": "POST", "access-control-request-headers": "content-type, mcp-protocol-version" } });
    expect(pre.status).toBeLessThan(300);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("mcp-protocol-version");
    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { origin: "https://chatgpt.com" });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-expose-headers")?.toLowerCase()).toContain("mcp-session-id");
  });

  test("rate limit: 429 with Retry-After and a JSON-RPC error body", async () => {
    if (!s) return;
    const a = createApp(s.sql, { mcpRate: { capacity: 3, perSecond: 0.01 } });
    const h = { "cf-connecting-ip": "203.0.113.9" };
    for (let i = 0; i < 3; i++) expect((await post({ jsonrpc: "2.0", id: i, method: "tools/list" }, h, a)).status).toBe(200);
    const r = await post({ jsonrpc: "2.0", id: 9, method: "tools/list" }, h, a);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await r.json()) as any).error.message).toContain("Retry after");
    // another client is not affected
    expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "cf-connecting-ip": "203.0.113.10" }, a)).status).toBe(200);
  });
});

describe("mcp tools for agents", () => {
  test("every tool is titled, read-only, closed-world and has an output schema; names fit every client (<= 64, [a-z_])", async () => {
    if (!s) return;
    const { json } = await rpc("tools/list");
    for (const t of json.result.tools) {
      expect(t.name).toMatch(/^[a-z_]{1,64}$/);
      expect(t.title.length).toBeGreaterThan(3);
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(t.outputSchema?.type).toBe("object");
    }
  });

  test("get_vote: every ballot with party on the vote date and an English gloss; per-party tally", async () => {
    if (!s) return;
    const r = (await call("get_vote", { vote_id: s.voteId })).structuredContent;
    expect(r.vote.matter).toMatchObject({ lthing: 157, class: "A", nr: 300 });
    expect(r.ballots_total).toBe(3);
    const yes = r.ballots.find((b: any) => b.choice === "já");
    expect(yes.member.id).toBe(633);
    expect(yes.choice_en).toBe("yes");
    expect(r.by_party.length).toBeGreaterThan(0);
    const miss = await call("get_vote", { vote_id: 1 });
    expect(miss.isError).toBe(true);
    expect(JSON.parse(miss.content[0]!.text!).hint).toContain("get_matter");
  });

  test("member_votes: tally and list, filter by matter and choice", async () => {
    if (!s) return;
    const r = (await call("member_votes", { member_id: 633 })).structuredContent;
    expect(r.tally).toEqual([{ choice: "já", choice_en: "yes", n: 1 }]);
    expect(r.votes[0]).toMatchObject({ vote_id: s.voteId, choice: "já", matter: { lthing: 157, class: "A", nr: 300 } });
    expect((await call("member_votes", { member_id: 633, choice: "nei" })).structuredContent.votes).toEqual([]);
    expect((await call("member_votes", { member_id: 999999 })).isError).toBe(true);
  });

  test("get_matter carries sponsors and sitting events; get_speech carries reply links", async () => {
    if (!s) return;
    const m = (await call("get_matter", { lthing: 157, nr: 300 })).structuredContent;
    expect(m.sponsors[0]).toMatchObject({ order: 1, member: { id: 633 }, office: "utanrrh." });
    expect(m.sitting_events.map((e: any) => e.kind)).toContain("umræðuLokið");
    const sp = (await call("get_speech", { speech_id: s.speechId })).structuredContent;
    expect(sp.speech).toHaveProperty("reply_to");
    expect(Array.isArray(sp.speech.replies)).toBe(true);
  });

  test("get_law by number, by title, one article; unknown law is an actionable error", async () => {
    if (!s) return;
    const l = (await call("get_law", { year: 1991, nr: 34, article: "1" })).structuredContent;
    expect(l.law).toMatchObject({ id: "34/1991", in_current_collection: true, url: "https://althingi.solberg.is/log/1991/34" });
    expect(l.articles_index.map((a: any) => a.article)).toEqual(["1", "2"]);
    expect(l.articles).toEqual([expect.objectContaining({ article: "1", text: expect.stringContaining("fjárfesta") })]);
    expect(l.matters_amending[0]).toMatchObject({ lthing: 157, nr: 300 });
    expect((await call("get_law", { title: "fjárfestingu erlendra" })).structuredContent.law.nr).toBe(34);
    expect((await call("get_law", { year: 1800, nr: 1 })).isError).toBe(true);
  });

  test("get_sitting by number and by date; list_sittings", async () => {
    if (!s) return;
    const g = (await call("get_sitting", { lthing: 157, fundur: 40 })).structuredContent;
    expect(g.agenda[0]).toMatchObject({ seq: 1, title: "Tollalög", matter: { nr: 300 } });
    expect(g.events.find((e: any) => e.kind === "fundurhefst").kind_en).toBe("sitting opened");
    expect((await call("get_sitting", { date: "2025-12-01" })).structuredContent.sitting.fundur).toBe(40);
    expect((await call("get_sitting", { date: "1999-01-01" })).isError).toBe(true);
    expect((await call("list_sittings", { lthing: 157 })).structuredContent.sittings[0]).toMatchObject({ fundur: 40, items: 1 });
  });

  test("search + fetch (the ChatGPT connector pair): ids, urls, Markdown text", async () => {
    if (!s) return;
    const r = await call("search", { query: s.word });
    expect(JSON.parse(r.content[0]!.text!)).toEqual(r.structuredContent);
    const hit = r.structuredContent.results.find((x: any) => x.id === `/raeda/${s!.speechId}`);
    expect(hit.url).toBe(`https://althingi.solberg.is/raeda/${s.speechId}`);
    const f = (await call("fetch", { id: hit.id })).structuredContent;
    expect(f).toMatchObject({ id: hit.id, url: hit.url });
    expect(f.text).toContain("#mgr-");
    expect((await call("fetch", { id: "https://althingi.solberg.is/mal/157/A/300.md" })).structuredContent.title).toBeTruthy();
    expect((await call("fetch", { id: "/nope" })).isError).toBe(true);
  });

  test("resources: templates by https URL, read returns Markdown; guide resource; prompts", async () => {
    if (!s) return;
    const t = (await rpc("resources/templates/list")).json.result.resourceTemplates.map((x: any) => x.uriTemplate);
    expect(t).toEqual(expect.arrayContaining(["https://althingi.solberg.is/raeda/{speech_id}.md", "https://althingi.solberg.is/log/{year}/{nr}.md"]));
    const list = (await rpc("resources/list")).json.result.resources.map((x: any) => x.uri);
    expect(list).toContain("https://althingi.solberg.is/llms.txt");
    const rd = (await rpc("resources/read", { uri: `https://althingi.solberg.is/raeda/${s.speechId}.md` })).json.result.contents[0];
    expect(rd.mimeType).toBe("text/markdown");
    expect(rd.text).toContain(s.speechId);
    expect((await rpc("resources/read", { uri: "https://althingi.solberg.is/log/1991/34.md" })).json.result.contents[0].text).toContain("fjárfesta");
    const ps = (await rpc("prompts/list")).json.result.prompts.map((p: any) => p.name);
    expect(ps).toEqual(["debate_on_topic", "member_record"]);
    const p = (await rpc("prompts/get", { name: "debate_on_topic", arguments: { topic: "fishing fees" } })).json.result;
    expect(p.messages[0].content.text).toContain("search_speeches");
  });
});

describe("markdown twins", () => {
  test(".md for speech, matter, member, law, day, party, document, home, about, connect page", async () => {
    if (!s) return;
    const [d] = await s.sql<{ d: string }[]>`select speech_date::text d from speeches where id = ${s.speechId}`;
    const [party] = await s.sql<{ id: number }[]>`select party_id id from seats where member_id = 633 and party_id is not null limit 1`;
    const [doc] = await s.sql<{ nr: number }[]>`select nr from documents where lthing = 157 limit 1`;
    for (const [path, needle] of [
      [`/raeda/${s.speechId}.md`, "## Ræðutexti"], ["/mal/157/a/300.md", "## Flutningsmenn"], ["/thingmadur/633.md", "## Þingseta"],
      ["/log/1991/34.md", "## Texti"], [`/dagur/${d!.d}.md`, "Þingdagur"], [`/flokkur/${party!.id}.md`, "## Þingmenn"], [`/thingskjal/157/${doc!.nr}.md`, "Þingskjal"],
      ["/index.md", "https://althingi.solberg.is/mcp"], ["/um.md", "Mörk safnsins"], ["/mcp.md", "claude mcp add --transport http althingi"],
    ] as const) {
      const r = await get(path);
      expect(r.status, path).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/markdown");
      expect(r.headers.get("access-control-allow-origin")).toBe("*");
      expect(await r.text()).toContain(needle);
    }
    expect((await get("/raeda/rad20000101T000000.md")).status).toBe(404);
  });

  test("Accept: text/markdown redirects to the twin; HTML stays HTML; the head and Link header point to it", async () => {
    if (!s) return;
    const r = await get(`/raeda/${s.speechId}`, { accept: "text/markdown, text/html;q=0.5" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`/raeda/${s.speechId}.md`);
    const h = await get(`/raeda/${s.speechId}`, { accept: "text/html,*/*" });
    expect(h.status).toBe(200);
    const body = await h.text();
    expect(body).toContain(`<link rel="alternate" type="text/markdown" href="/raeda/${s.speechId}.md"/>`);
    expect(h.headers.get("link")).toContain(`</raeda/${s.speechId}.md>; rel="alternate"`);
    expect(h.headers.get("vary")).toContain("Accept");
  });
});

describe("discovery surfaces", () => {
  test("llms.txt follows llmstxt.org: H1, blockquote, MCP first, corpus from the DB, H2 link lists, Optional last", async () => {
    if (!s) return;
    const r = await get("/llms.txt");
    expect(r.headers.get("content-type")).toContain("text/markdown");
    const t = await r.text();
    const lines = t.split("\n");
    expect(lines[0]).toMatch(/^# /);
    expect(lines.find((l) => l.trim())?.startsWith("# ")).toBe(true);
    expect(lines[2]).toMatch(/^> /);
    expect(t.indexOf("https://althingi.solberg.is/mcp")).toBeLessThan(t.indexOf("## "));
    expect(t).toContain("Speech text for sessions 148–148"); // the test DB has one speech of session 148
    expect(t).toContain("Rate limits:");
    expect(t).toContain("Attribution:");
    const h2 = lines.filter((l) => l.startsWith("## "));
    expect(h2[h2.length - 1]).toBe("## Optional");
    for (const l of lines.filter((x) => x.startsWith("- "))) expect(l).toMatch(/^- \[[^\]]+\]\(https:\/\/althingi\.solberg\.is[^)]*\)(: .+)?$/);
    const full = await (await get("/llms-full.txt")).text();
    expect(full.startsWith(t)).toBe(true);
    expect(full).toContain("### get_vote");
    expect(full).toContain("## Glossary");
  });

  test("robots.txt welcomes agents, keeps HTML search out, allows the JSON search and user agents, names the sitemap", async () => {
    if (!s) return;
    const t = await (await get("/robots.txt")).text();
    expect(t).toBe(ROBOTS);
    expect(t).toContain("Content-Signal: search=yes, ai-input=yes");
    expect(t).toMatch(/User-agent: \*\nContent-Signal[^\n]*\nAllow: \/\nAllow: \/leit\.json\nDisallow: \/leit\n/);
    expect(t).toContain("User-agent: Claude-User");
    expect(t).not.toContain("Disallow: /mcp");
    expect(t).toContain("Sitemap: https://althingi.solberg.is/sitemap.xml");
  });

  test("sitemap index lists real sitemaps; each lists real pages", async () => {
    if (!s) return;
    const idx = await (await get("/sitemap.xml")).text();
    const maps = [...idx.matchAll(/<loc>https:\/\/althingi\.solberg\.is(\/sitemaps\/[a-z0-9]+\.xml)<\/loc>/g)].map((m) => m[1]!);
    expect(maps).toEqual(["/sitemaps/static.xml", "/sitemaps/members.xml", "/sitemaps/laws.xml", "/sitemaps/148.xml"]);
    const sm = await (await get("/sitemaps/148.xml")).text();
    expect(sm).toContain(`/raeda/${s.speechId}</loc>`);
    expect(await (await get("/sitemaps/laws.xml")).text()).toContain("/log/1991/34</loc>");
    expect(await (await get("/sitemaps/members.xml")).text()).toContain("/thingmadur/633</loc>");
    const st = await (await get("/sitemaps/static.xml")).text();
    expect(st).toContain("https://althingi.solberg.is/mcp</loc>");
    for (const loc of [...st.matchAll(/<loc>https:\/\/althingi\.solberg\.is([^<]*)<\/loc>/g)].map((m) => m[1]!)) {
      expect((await get(loc, { accept: "text/html" })).status, loc).toBe(200);
    }
    expect((await get("/sitemaps/999.xml")).status).toBe(404);
  });

  test("server card, ai-catalog and the repo server.json agree on name, version and endpoint", async () => {
    if (!s) return;
    const card = await get("/mcp/server-card");
    expect(card.headers.get("content-type")).toBe("application/mcp-server-card+json");
    expect(card.headers.get("access-control-allow-origin")).toBe("*");
    const c = await card.json() as any;
    expect(c).toMatchObject({ name: "is.solberg.althingi/althingi", version: VERSION, remotes: [{ type: "streamable-http", url: "https://althingi.solberg.is/mcp" }] });
    const cat = await (await get("/.well-known/ai-catalog.json")).json() as any;
    expect(cat.entries[0]).toMatchObject({ type: "application/mcp-server-card+json", url: "https://althingi.solberg.is/mcp/server-card" });
    const repo = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
    expect(repo).toEqual(serverJson(VERSION)); // bump server.json together with VERSION in src/mcp.ts
    expect(repo.description.length).toBeLessThanOrEqual(100);
    expect(repo.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
  });

  test("OpenAPI describes /leit.json, which works", async () => {
    if (!s) return;
    const o = await (await get("/openapi.json")).json() as any;
    expect(o.openapi).toBe("3.1.0");
    expect(o.paths["/leit.json"].get.parameters[0].name).toBe("q");
    expect((await get(`/leit.json?q=${encodeURIComponent(s.word)}`)).status).toBe(200);
  });

  test("every HTML page carries the discovery links; the front page has the agent section and JSON-LD", async () => {
    if (!s) return;
    const r = await get("/");
    const b = await r.text();
    for (const l of [`<link rel="help" type="text/markdown" href="/llms.txt"`, `<link rel="service-meta" type="application/mcp-server-card+json" href="/mcp/server-card"`,
      `<link rel="service-desc" type="application/openapi+json" href="/openapi.json"`, `<link rel="alternate" type="text/markdown" href="/index.md"`]) expect(b).toContain(l);
    expect(b).toContain(`id="agents-h"`);
    expect(b).toContain(`value="https://althingi.solberg.is/mcp"`);
    expect(b).toContain(`"contentUrl":"https://althingi.solberg.is/mcp"`);
    expect(r.headers.get("link")).toContain(`</llms.txt>; rel="help"`);
    for (const href of ["/llms.txt", "/index.md", "/mcp/server-card", "/openapi.json", "/mcp"]) expect((await get(href, { accept: "text/html" })).status, href).toBe(200);
  });

  test("MCP rejects a malformed Origin with 403 but any web origin is fine", async () => {
    if (!s) return;
    expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { origin: "javascript:alert(1)" })).status).toBe(403);
    expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { origin: "http://localhost:6274" })).status).toBe(200);
  });
});

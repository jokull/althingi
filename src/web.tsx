// The site: Hono app factory (testable with app.request) — server.ts binds it to a port.
import { readFileSync } from "node:fs";
import { Hono, type Context } from "hono";
import { etag } from "hono/etag";
import { cors } from "hono/cors";
import { clientKey, rateLimiter, type RateOpts } from "./ratelimit.ts";
import type { Child } from "hono/jsx";
import type { Sql } from "./db.ts";
import { route } from "./route.ts";
import { search, type SearchParams } from "./search.ts";
import { buildServer, handleMcp, VERSION } from "./mcp.ts";
import { renderMd } from "./md-routes.ts";
import { aboutMd, corpusFacts, homeJsonLd, homeMd, llmsFullTxt, llmsTxt, mcpMd, openApi, serverCard } from "./agent-docs.ts";
import { clearWinner, findMembers, suggest } from "./suggest.ts";
import { committeePage, composition, corpusStats, dayPage, docPage, isSpeechId, lawPage, matterExtras, matterFeed, matterPage, matterTranscript, memberPage, partiesFor, partyPage, sessionState, speechPage, topicPage } from "./queries.ts";
import { describeIntent, interpret, type NamedId } from "./intent.ts";
import { fmtDateTime, mdHref } from "./pages.tsx";
import { AgentsSection, McpPage } from "./agent-pages.tsx";
import { KINDS, nameMatches, searchEntities, type Kind } from "./entities.ts";
import { CommitteePageView, DocPageView, TopicPageView, TranscriptView, Suggest, SITE, AboutPage, DayPageView, HomePage, LawPageView, MatterPageView, MemberPageView, NotFound, PartyPageView, Rows, SearchPage, SpeechPageView, type SearchView } from "./pages.tsx";

const IMMUTABLE = "public, s-maxage=31536000, stale-while-revalidate=86400, stale-if-error=604800";
const LIVE = "public, s-maxage=300, stale-while-revalidate=3600, stale-if-error=86400";
const SEARCHY = "public, s-maxage=60, stale-while-revalidate=300, stale-if-error=3600";

const asset = (p: string) => readFileSync(new URL(p, import.meta.url));
const CSS = asset("../public/app.css");
const HTMX = asset("../node_modules/htmx.org/dist/htmx.min.js");

const html = (c: Context, node: Child, status: 200 | 404 = 200) =>
  c.html("<!DOCTYPE html>" + String(node), status);
const num = (s: string | undefined): number | undefined => (s !== undefined && /^\d{1,9}$/.test(s) ? Number(s) : undefined);
// Everyone is welcome to read and cite the pages; search result pages stay out of crawl indexes (infinite URL space),
// except for user-triggered agents, which fetch on a person's behalf. robots.txt does not govern MCP clients.
export const ROBOTS = `# Alþingi · leit: the public record of the Icelandic parliament. AI agents and search engines are welcome.
# Guide for agents: https://althingi.solberg.is/llms.txt · MCP server (no sign-in): https://althingi.solberg.is/mcp
# Search, AI-input and user agents (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User, …) all fall under *.

User-agent: *
Content-Signal: search=yes, ai-input=yes
Allow: /
Allow: /leit.json
Disallow: /leit

User-agent: ChatGPT-User
User-agent: Claude-User
User-agent: Perplexity-User
Allow: /

Sitemap: https://althingi.solberg.is/sitemap.xml
`;

const iso = (s: string | undefined): string | undefined => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined);

export interface AppOpts { mcpRate?: RateOpts }

export function createApp(sql: Sql, opts: AppOpts = {}) {
  const app = new Hono();
  app.use("*", etag({ weak: false }));

  // session state, refreshed once a minute: the latest session with data, and which sessions are complete
  let cur = { lthing: 0, first: 0, seatLthing: 0, starts: null as string | null, complete: new Set<number>(), at: 0, parties: [] as { id: number; name: string; seats: number }[] };
  const current = async () => {
    if (Date.now() - cur.at > 60_000) {
      const st = await sessionState(sql);
      // the roster comes from the latest session with SEATS (it can be ahead of the speech text), so every page agrees
      const l = (await sql<{ l: number | null }[]>`select max(lthing) as l from seats`)[0]?.l ?? null;
      cur = { ...st, seatLthing: l ?? st.lthing, parties: l ? await composition(sql, l) : [], at: Date.now() };
    }
    return cur;
  };
  /** Immutable only for COMPLETE sessions; a session still being ingested keeps short TTLs. */
  const cacheFor = async (c: Context, lthing: number) => {
    c.header("Cache-Control", (await current()).complete.has(lthing) ? IMMUTABLE : LIVE);
  };

  app.get("/app.css", (c) => c.body(CSS, 200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=86400" }));
  app.get("/htmx.min.js", (c) => c.body(HTMX, 200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=86400" }));
  app.get("/robots.txt", (c) => c.text(ROBOTS, 200, { "Cache-Control": "public, max-age=3600" }));

  // ---- agent surfaces: CORS-open read endpoints, Markdown twins, llms.txt, discovery files (docs/AGENTS.md)
  const PUBLIC_CORS = cors({ origin: "*", allowMethods: ["GET", "HEAD", "OPTIONS"], allowHeaders: ["Content-Type", "If-None-Match"], exposeHeaders: ["ETag", "Link"], maxAge: 86400 });
  const isPublic = (p: string) => /\.(md|json|txt|xml)$/.test(p) || p === "/mcp/server-card" || p.startsWith("/.well-known/");
  app.use("*", (c, next) => (isPublic(new URL(c.req.url).pathname) ? PUBLIC_CORS(c, next) : next()));
  const MD = { "Content-Type": "text/markdown; charset=utf-8" };
  const tools = () => Object.entries((buildServer(sql, 0) as unknown as { _registeredTools: Record<string, { title?: string; description?: string }> })._registeredTools)
    .map(([name, t]) => ({ name, title: t.title, description: t.description }));

  // HTML pages advertise their agent twins in a Link header too (llms.txt, MCP card, Markdown alternate)
  app.use("*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const alt = c.req.method === "GET" ? mdHref(path) : null;
    // Accept: text/markdown (preferred over HTML) -> the .md twin. A redirect, not inline negotiation: the edge cache
    // does not key on Accept, so one URL must always carry one representation.
    const acc = c.req.header("accept") ?? "";
    if (alt && acc.includes("text/markdown") && (!acc.includes("text/html") || acc.indexOf("text/markdown") < acc.indexOf("text/html"))) {
      return c.redirect(`${alt}${new URL(c.req.url).search}`, 302);
    }
    await next();
    if (c.res.headers.get("content-type")?.startsWith("text/html")) {
      c.res.headers.append("Link", `</llms.txt>; rel="help"; type="text/markdown", </mcp/server-card>; rel="service-meta"; type="application/mcp-server-card+json", </openapi.json>; rel="service-desc"${alt ? `, <${alt}>; rel="alternate"; type="text/markdown"` : ""}`);
      if (alt) c.res.headers.append("Vary", "Accept");
    }
  });
  app.get("/llms.txt", async (c) => c.body(await llmsTxt(sql), 200, { ...MD, "Cache-Control": LIVE }));
  app.get("/llms-full.txt", async (c) => c.body(await llmsFullTxt(sql, tools()), 200, { ...MD, "Cache-Control": LIVE }));
  app.get("/index.md", async (c) => c.body(homeMd(await corpusFacts(sql)), 200, { ...MD, "Cache-Control": LIVE }));
  app.get("/um.md", (c) => c.body(aboutMd(), 200, { ...MD, "Cache-Control": LIVE }));
  app.get("/mcp.md", (c) => c.body(mcpMd(), 200, { ...MD, "Cache-Control": LIVE }));
  // MCP Server Card (SEP-2127, Extensions Track): at <mcp url>/server-card, indexed by /.well-known/ai-catalog.json
  app.get("/mcp/server-card", (c) => c.body(JSON.stringify(serverCard(VERSION), null, 2), 200, { "Content-Type": "application/mcp-server-card+json", "Cache-Control": "public, max-age=3600" }));
  app.get("/.well-known/ai-catalog.json", (c) => c.body(JSON.stringify({
    specVersion: "1.0",
    entries: [{ identifier: "urn:air:althingi.solberg.is:mcp:althingi", type: "application/mcp-server-card+json", url: `${SITE}/mcp/server-card` }],
  }, null, 2), 200, { "Content-Type": "application/ai-catalog+json", "Cache-Control": "public, max-age=3600" }));
  app.get("/openapi.json", (c) => c.json(openApi(VERSION), 200, { "Cache-Control": "public, max-age=3600" }));
  // the Markdown twin of every entity page (resolved in md-routes.ts, shared with the MCP resources and `fetch`)
  app.get("*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (!path.endsWith(".md")) return next();
    const d = await renderMd(sql, path, (await current()).lthing);
    if (!d) return c.body(`# Fannst ekki\n\nEkkert á ${SITE}${path}. Sjá ${SITE}/llms.txt fyrir slóðir.\n`, 404, MD);
    const lthing = Number(path.match(/^\/(?:mal|thingskjal)\/(\d+)\//)?.[1] ?? NaN);
    if (Number.isFinite(lthing)) await cacheFor(c, lthing); else c.header("Cache-Control", LIVE);
    return c.body(d.markdown, 200, { ...MD, Link: `<${SITE}${d.path}>; rel="canonical"` });
  });

  // sitemaps: an index, one file per session with text (matters + speeches), members, laws, and the static pages
  const XMLH = { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": LIVE };
  const urlset = (urls: { loc: string; lastmod?: string | null }[]) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${SITE}${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`).join("\n")}\n</urlset>\n`;
  app.get("/sitemap.xml", async (c) => {
    const ls = await sql<{ lthing: number; last: string | null }[]>`select lthing, max(fetched_at)::date::text as last from speeches where text_state = 'done' group by 1 order by 1 desc`;
    const maps = ["static", "members", "laws", ...ls.map((l) => String(l.lthing))];
    return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${maps.map((m) => `<sitemap><loc>${SITE}/sitemaps/${m}.xml</loc>${ls.find((l) => String(l.lthing) === m)?.last ? `<lastmod>${ls.find((l) => String(l.lthing) === m)!.last}</lastmod>` : ""}</sitemap>`).join("\n")}\n</sitemapindex>\n`, 200, XMLH);
  });
  app.get("/sitemaps/:name{[a-z0-9]+\\.xml}", async (c) => {
    const name = c.req.param("name").replace(/\.xml$/, "");
    if (name === "static") return c.body(urlset(["/", "/um", "/mcp", "/llms.txt"].map((loc) => ({ loc }))), 200, XMLH);
    if (name === "members") return c.body(urlset((await sql<{ id: number }[]>`select id from members where exists (select 1 from seats s where s.member_id = members.id) order by id`).map((m) => ({ loc: `/thingmadur/${m.id}` }))), 200, XMLH);
    if (name === "laws") return c.body(urlset((await sql<{ year: number; nr: number }[]>`select year, nr from laws_current order by year, nr`).map((l) => ({ loc: `/log/${l.year}/${l.nr}` }))), 200, XMLH);
    const lthing = num(name);
    if (lthing === undefined) return c.text("fannst ekki", 404);
    const [ms, sp] = await Promise.all([
      sql<{ cls: string; nr: number; d: string | null }[]>`select cls, nr, detail_fetched_at::date::text d from matters where lthing = ${lthing} order by cls, nr`,
      sql<{ id: string; d: string | null }[]>`select id, fetched_at::date::text d from speeches where lthing = ${lthing} and text_state = 'done' order by started limit 45000`,
    ]);
    if (!ms.length && !sp.length) return c.text("fannst ekki", 404);
    await cacheFor(c, lthing);
    return c.body(urlset([...ms.map((m) => ({ loc: `/mal/${lthing}/${m.cls.toLowerCase()}/${m.nr}`, lastmod: m.d })), ...sp.map((x) => ({ loc: `/raeda/${x.id}`, lastmod: x.d }))]), 200, { "Content-Type": XMLH["Content-Type"] });
  });

  app.get("/healthz", async (c) => {
    const t0 = performance.now();
    const st = await corpusStats(sql);
    const ageH = st.lastIngest ? (Date.now() - st.lastIngest.getTime()) / 3_600_000 : null;
    const [ing] = await sql<{ last_poll_at: Date | null; last_dump_drop: Date | null; unresolved_speakers: number; pending_texts: number; blocked_runs: number }[]>`
      select (select max(finished) from ingest_runs where kind = 'service poll' and status = 'ok') as last_poll_at,
             (select max(downloaded_at) from dump_drops) as last_dump_drop,
             (select count(*)::int from speeches where member_id is null) as unresolved_speakers,
             (select count(*)::int from speeches where text_state = 'pending') as pending_texts,
             (select count(*)::int from ingest_runs where status in ('blocked', 'rate-limited') and started > now() - interval '24 hours') as blocked_runs`;
    return c.json({
      ok: true, db_ms: Math.round(performance.now() - t0), speeches: st.speeches, last_ingest_age_hours: ageH === null ? null : Math.round(ageH * 10) / 10,
      last_poll_at: ing?.last_poll_at ?? null, last_dump_drop: ing?.last_dump_drop ?? null,
      unresolved_speakers: ing?.unresolved_speakers ?? 0, pending_texts: ing?.pending_texts ?? 0, blocked_runs_24h: ing?.blocked_runs ?? 0,
    });
  });

  app.get("/", async (c) => {
    c.header("Cache-Control", LIVE);
    const st = await current();
    return html(c, <HomePage stats={await corpusStats(sql)} lthing={st.seatLthing} parties={st.parties} agents={<AgentsSection />} jsonld={homeJsonLd(await corpusFacts(sql))} />);
  });

  app.get("/um", (c) => { c.header("Cache-Control", IMMUTABLE); return html(c, <AboutPage />); });

  // ---- search
  const readSearch = async (c: Context): Promise<{ p: SearchParams; base: string; q: string }> => {
    const u = new URL(c.req.url).searchParams;
    const q = (u.get("q") ?? "").slice(0, 200);
    const mal = u.get("mal")?.match(/^([ab])\/(\d{1,5})$/);
    const p: SearchParams = {
      q, limit: 10, currentLthing: (await current()).lthing,
      dateFrom: iso(u.get("fra") ?? undefined), dateTo: iso(u.get("til") ?? undefined),
      lthing: num(u.get("thing") ?? undefined), type: u.get("tegund") || undefined,
      partyId: num(u.get("flokkur") ?? undefined), office: u.get("embaetti") || undefined,
      debate: u.get("umraeda")?.split(",").filter((d) => /^[123*SEFT]$/.test(d)),
      capacity: u.get("hlutverk") || undefined, memberId: num(u.get("thm") ?? undefined),
      matterCls: mal ? mal[1]!.toUpperCase() : undefined, matterNr: mal ? Number(mal[2]) : undefined,
      sort: u.get("nyjast") === "elst" ? "oldest" : u.get("nyjast") ? "newest" : "relevance", cursor: u.get("c") || undefined,
    };
    const keep = ["q", "fra", "til", "thing", "tegund", "flokkur", "embaetti", "umraeda", "hlutverk", "thm", "mal", "nyjast", "upph"];
    const base = keep.filter((k) => u.get(k)).map((k) => `${k}=${encodeURIComponent(u.get(k)!)}`).join("&");
    return { p, base, q };
  };

  // members and parties for reading names out of a typed question (intent.ts); refreshed every 10 minutes
  let names = { members: [] as NamedId[], parties: [] as NamedId[], at: 0 };
  const nameLists = async () => {
    if (Date.now() - names.at > 600_000) {
      names = {
        members: await sql<NamedId[]>`select id, name from members`,
        parties: await sql<NamedId[]>`select id, name from parties where exists (select 1 from seats s where s.party_id = parties.id)`,
        at: Date.now(),
      };
    }
    return names;
  };
  let range = { from: null as string | null, to: null as string | null, at: 0 };
  const corpusRange = async () => {
    if (Date.now() - range.at > 300_000) { const st = await corpusStats(sql); range = { from: st.from, to: st.to, at: Date.now() }; }
    return range;
  };

  const view = async (p: SearchParams, base: string, q: string): Promise<SearchView> => {
    const result = await search(sql, { ...p, withTotal: !p.cursor });
    const parties = await partiesFor(sql, result.hits.map((h) => ({ speechId: h.speechId, memberId: h.memberId, date: h.date })));
    // did-you-mean only when nothing was found: a suggestion above real hits reads as "your word is not here"
    // did-you-mean is a nicety: if it fails or times out, the page still renders without it
    const suggestions = !p.cursor && result.hits.length === 0 && q.trim() ? await suggest(sql, q).catch(() => []) : [];
    const rg = await corpusRange();
    const now = await current();
    const memberName = p.memberId !== undefined ? (await nameLists()).members.find((m) => m.id === p.memberId)?.name : undefined;
    return { q, result, parties, suggestions, baseQuery: base, corpusFrom: rg.from, corpusTo: rg.to, coverage: { first: now.first, last: now.lthing }, partyList: now.parties, memberName };
  };

  app.get("/leit", async (c) => {
    const { p, base, q } = await readSearch(c);
    const sp = new URL(c.req.url).searchParams;
    const filterKeys = ["fra", "til", "thing", "tegund", "flokkur", "embaetti", "umraeda", "hlutverk", "thm", "mal"];
    const hasFilters = filterKeys.some((k) => sp.get(k));
    if (!q.trim() && !hasFilters) return c.redirect("/");
    let refine: { href: string; label: string } | undefined;
    if (!p.cursor && q.trim()) {
      const lthing = (await current()).lthing;
      const r = route(q, lthing);
      if (r) return c.redirect(r.path, 302);
      // The search box is a keyword box: the query is searched as typed. Natural-language questions belong to agent
      // harnesses, which call the MCP tools with structured filters. When the keywords contain a known member, party
      // or matter, we only OFFER that as a filter (see `refine` below); nothing is rewritten behind the user's back.
      if (!sp.get("ordrett") && !sp.get("upph") && !hasFilters) {
        const it = interpret(q, { ...(await nameLists()), today: new Date(), currentLthing: lthing });
        const entityOnly = it.memberId !== undefined || it.partyId !== undefined || it.matter !== undefined;
        if (entityOnly && it.q.trim() && it.q.trim() !== q.trim()) {
          const u = new URLSearchParams();
          u.set("q", it.q);
          if (it.memberId !== undefined) u.set("thm", String(it.memberId));
          if (it.partyId !== undefined) u.set("flokkur", String(it.partyId));
          if (it.matter) { u.set("mal", `a/${it.matter.nr}`); u.set("thing", String(it.matter.lthing)); }
          const who = it.memberName ?? it.partyName ?? (it.matter ? `${it.matter.nr}. mál` : "");
          refine = { href: `/leit?${u.toString()}`, label: `„${it.q.trim()}“ aðeins hjá ${who}` };
        }
      }
      // a bare member name goes to the member page — but never when filters are set (they would be dropped)
      const m = hasFilters ? null : clearWinner(await findMembers(sql, q));
      if (m && nameMatches(m.name, q) && !sp.get("beint") && !sp.get("ordrett")) return c.redirect(`/thingmadur/${m.id}`, 302);
    }
    c.header("Cache-Control", SEARCHY);
    const t = new URL(c.req.url).searchParams.get("t") ?? "allt";
    const v = await view(p, base, q);
    v.refine = refine;
    const asked = sp.get("upph");
    if (asked) {
      v.asked = asked;
      const it = interpret(asked, { ...(await nameLists()), today: new Date(), currentLthing: (await current()).lthing });
      // describe only what is still in the URL (a removed chip must disappear from the note too)
      v.interpreted = describeIntent({
        ...it,
        memberName: sp.get("thm") ? it.memberName : undefined, partyName: sp.get("flokkur") ? it.partyName : undefined,
        dateLabel: sp.get("fra") || sp.get("til") ? it.dateLabel : undefined, type: sp.get("tegund") ? it.type : undefined,
        officeLabel: sp.get("embaetti") ? it.officeLabel : undefined, capacity: sp.get("hlutverk") ? it.capacity : undefined,
        debate: sp.get("umraeda") ? it.debate : undefined, matter: sp.get("mal") ? it.matter : undefined,
        sort: sp.get("nyjast") ? it.sort : undefined,
      });
    }
    if (!p.cursor && q.trim()) {
      v.entities = await searchEntities(sql, q, (await current()).lthing, t === "allt" ? 8 : 40);
      v.tab = (KINDS.some((k) => k.id === t) ? t : t === "raedur" ? "raedur" : "allt") as Kind | "raedur" | "allt";
    }
    return html(c, <SearchPage v={v} />);
  });

  // typeahead: entity suggestions across all kinds (own URL, short cache)
  app.get("/leit/forslag", async (c) => {
    const q = (new URL(c.req.url).searchParams.get("q") ?? "").slice(0, 100);
    c.header("Cache-Control", "public, s-maxage=30");
    if (q.trim().length < 2) return c.html("");
    return c.html(String(<Suggest ents={await searchEntities(sql, q, (await current()).lthing, 4)} q={q} />));
  });

  // htmx partial: its own URL, because the edge cache ignores Vary: HX-Request
  app.get("/leit/rows", async (c) => {
    const { p, base, q } = await readSearch(c);
    c.header("Cache-Control", SEARCHY);
    return c.html(String(<Rows v={await view(p, base, q)} />));
  });

  // ---- feeds and export (stateless: the "alert" mechanism for a public site without accounts)
  const xml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const atom = (id: string, title: string, self: string, entries: { id: string; title: string; href: string; updated: string; summary: string }[]) =>
    `<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="is">\n<id>tag:althingi.solberg.is,2026:${xml(id)}</id>\n<title>${xml(title)}</title>\n` +
    `<link rel="self" href="${xml(SITE + self)}"/>\n<updated>${entries[0]?.updated ?? new Date().toISOString()}</updated>\n` +
    entries.map((e) => `<entry><id>tag:althingi.solberg.is,2026:${xml(e.id)}</id><title>${xml(e.title)}</title><link href="${xml(e.href)}"/><updated>${e.updated}</updated><summary>${xml(e.summary)}</summary></entry>`).join("\n") +
    `\n</feed>\n`;
  const FEED = { "Content-Type": "application/atom+xml; charset=utf-8", "Cache-Control": SEARCHY };

  app.get("/leit/atom", async (c) => {
    const { p, q, base } = await readSearch(c);
    if (!q.trim()) return c.text("q vantar", 400);
    const r = await search(sql, { ...p, sort: "newest", cursor: undefined, limit: 25 });
    const parties = await partiesFor(sql, r.hits.map((h) => ({ speechId: h.speechId, memberId: h.memberId, date: h.date })));
    return c.body(atom(`leit:${base}`, `Alþingi · leit: ${q}`, `/leit/atom?${base}`, r.hits.map((h) => ({
      id: `raeda:${h.speechId}`, title: `${h.memberName}${parties.get(h.speechId) ? ` (${parties.get(h.speechId)})` : ""} – ${h.speechType}, ${fmtDateTime(h.started)}`,
      href: `${SITE}/raeda/${h.speechId}`, updated: h.started.replace(" ", "T") + "Z",
      summary: `${h.matter?.title ? h.matter.title + ": " : ""}${h.paragraphs[0]?.snippets[0]?.text ?? ""}`,
    }))), 200, FEED);
  });

  app.get("/nyjast/atom", async (c) => {
    const rows = await sql<{ id: string; started: string; member_name: string; type: string; title: string | null; text: string | null }[]>`
      select s.id, s.started::text, s.member_name, s.type, m.title,
             (select text from paragraphs where speech_id = s.id order by seq limit 1) as text
      from speeches s left join matters m on m.lthing = s.lthing and m.cls = s.matter_cls and m.nr = s.matter_nr
      where s.text_state = 'done' order by s.started desc limit 30`;
    return c.body(atom("nyjast", "Alþingi · nýjustu ræður", "/nyjast/atom", rows.map((r) => ({
      id: `raeda:${r.id}`, title: `${r.member_name} – ${r.type}, ${fmtDateTime(r.started)}`, href: `${SITE}/raeda/${r.id}`,
      updated: r.started.replace(" ", "T") + "Z", summary: `${r.title ? r.title + ": " : ""}${(r.text ?? "").slice(0, 300)}`,
    }))), 200, FEED);
  });

  const csvCell = (v: unknown) => { const t = String(v ?? ""); return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  app.get("/leit.csv", async (c) => {
    const { p, q } = await readSearch(c);
    if (!q.trim()) return c.text("q vantar", 400);
    const rows: unknown[][] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20 && rows.length < 500; page++) { // up to 500 speeches, 25 at a time
      const r = await search(sql, { ...p, cursor, limit: 25 });
      const parties = await partiesFor(sql, r.hits.map((h) => ({ speechId: h.speechId, memberId: h.memberId, date: h.date })));
      for (const h of r.hits) {
        rows.push([h.speechId, h.date, h.started.slice(11, 16), h.memberId, h.memberName, parties.get(h.speechId) ?? "", h.speechType, h.matter?.lthing ?? "", h.matter?.cls ?? "", h.matter?.nr ?? "", h.matter?.title ?? "",
          `${SITE}/raeda/${h.speechId}`, (h.paragraphs[0]?.snippets[0]?.text ?? "").replace(/\s+/g, " ")]);
      }
      cursor = r.nextCursor ?? undefined;
      if (!cursor) break;
    }
    const head = ["speech_id", "date", "time", "member_id", "member", "party_at_date", "speech_type", "lthing", "matter_class", "matter_nr", "matter_title", "url", "snippet"];
    return c.body("\ufeff" + [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n", 200,
      { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="althingi-leit.csv"`, "Cache-Control": SEARCHY });
  });

  // same params as /leit, cursor-paged JSON (up to 100 speeches per page)
  app.get("/leit.json", async (c) => {
    const { p, q } = await readSearch(c);
    if (!q.trim()) return c.json({ error: "q vantar" }, 400);
    const lim = Math.min(Math.max(num(new URL(c.req.url).searchParams.get("limit") ?? undefined) ?? 25, 1), 100);
    const hits: unknown[] = [];
    let cursor = p.cursor, total: number | undefined, capped = false;
    for (let page = 0; page < 4 && hits.length < lim; page++) {
      const r = await search(sql, { ...p, cursor, limit: Math.min(25, lim - hits.length), withTotal: page === 0 && !p.cursor });
      if (page === 0) { total = r.total; capped = !!r.totalCapped; }
      const parties = await partiesFor(sql, r.hits.map((h) => ({ speechId: h.speechId, memberId: h.memberId, date: h.date })));
      for (const h of r.hits) hits.push({ speech_id: h.speechId, started: h.started, member: { id: h.memberId, name: h.memberName, party_at_date: parties.get(h.speechId) ?? null }, speech_type: h.speechType, debate: h.debate, matter: h.matter, url: `${SITE}/raeda/${h.speechId}`, paragraphs: h.paragraphs.map((x) => ({ mgr: x.seq + 1, text: x.snippets[0]?.text ?? "" })) });
      cursor = r.nextCursor ?? undefined;
      if (!cursor) break;
    }
    c.header("Cache-Control", SEARCHY);
    return c.json({ total, total_capped: capped, hits, next_cursor: cursor ?? null });
  });

  // every vote summary of a session (ballots per member are not crawled yet)
  app.get("/thing/:lthing/atkvaedagreidslur.csv", async (c) => {
    const lthing = num(c.req.param("lthing"));
    if (lthing === undefined) return c.text("fannst ekki", 404);
    const rows = await sql<Record<string, unknown>[]>`
      select v.id, v.voted_at::text as voted_at, v.cls, v.nr, m.title, v.doc_nr, v.kind_label, v.method, v.result, v.yes, v.no, v.abstain
      from votes v left join matters m on (m.lthing, m.cls, m.nr) = (v.lthing, v.cls, v.nr) where v.lthing = ${lthing} order by v.voted_at, v.id`;
    if (!rows.length) return c.text("engar atkvæðagreiðslur", 404);
    const head = ["vote_id", "voted_at", "matter_class", "matter_nr", "matter_title", "document_nr", "about", "method", "result", "yes", "no", "abstain"];
    const keys = ["id", "voted_at", "cls", "nr", "title", "doc_nr", "kind_label", "method", "result", "yes", "no", "abstain"];
    await cacheFor(c, lthing);
    return c.body("\ufeff" + [head.join(","), ...rows.map((r) => keys.map((k) => csvCell(r[k])).join(","))].join("\r\n") + "\r\n", 200,
      { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="althingi-${lthing}-atkvaedagreidslur.csv"` });
  });

  // ---- entities
  app.get("/raeda/:id", async (c) => {
    const id = c.req.param("id");
    if (!isSpeechId(id)) return html(c, <NotFound what="Ræðan fannst ekki." />, 404);
    const s = await speechPage(sql, id);
    if (!s) return html(c, <NotFound what="Ræðan fannst ekki í safninu." />, 404);
    await cacheFor(c, s.lthing);
    return html(c, <SpeechPageView s={s} />);
  });

  app.get("/mal/:lthing/:cls/:nr", async (c) => {
    const lthing = num(c.req.param("lthing")), nr = num(c.req.param("nr")), cls = c.req.param("cls");
    if (lthing === undefined || nr === undefined || !/^[abAB]$/.test(cls)) return html(c, <NotFound what="Málið fannst ekki." />, 404);
    if (cls !== cls.toLowerCase()) return c.redirect(`/mal/${lthing}/${cls.toLowerCase()}/${nr}`, 301);
    const m = await matterPage(sql, lthing, cls.toUpperCase(), nr);
    if (!m) return html(c, <NotFound what="Málið fannst ekki í safninu." />, 404);
    await cacheFor(c, lthing);
    return html(c, <MatterPageView m={m} x={await matterExtras(sql, lthing, cls.toUpperCase(), nr)} />);
  });

  // the whole debate on one page, in order (print view)
  app.get("/mal/:lthing/:cls/:nr/umraeda", async (c) => {
    const lthing = num(c.req.param("lthing")), nr = num(c.req.param("nr")), cls = c.req.param("cls").toUpperCase();
    if (lthing === undefined || nr === undefined || !/^[AB]$/.test(cls)) return html(c, <NotFound what="Málið fannst ekki." />, 404);
    const m = await matterPage(sql, lthing, cls, nr);
    if (!m) return html(c, <NotFound what="Málið fannst ekki í safninu." />, 404);
    await cacheFor(c, lthing);
    return html(c, <TranscriptView m={m} speeches={await matterTranscript(sql, lthing, cls, nr)} />);
  });

  // follow one matter: new speeches, documents and votes
  app.get("/mal/:lthing/:cls/:nr/atom", async (c) => {
    const lthing = num(c.req.param("lthing")), nr = num(c.req.param("nr")), cls = c.req.param("cls").toUpperCase();
    if (lthing === undefined || nr === undefined || !/^[AB]$/.test(cls)) return c.text("fannst ekki", 404);
    const m = await matterPage(sql, lthing, cls, nr);
    if (!m) return c.text("fannst ekki", 404);
    const f = await matterFeed(sql, lthing, cls, nr);
    const murl = `${SITE}/mal/${lthing}/${cls.toLowerCase()}/${nr}`;
    const ts = (t: string) => t.replace(" ", "T").slice(0, 19) + "Z";
    const entries = [
      ...f.speeches.map((s) => ({ id: `raeda:${s.id}`, title: `${s.member_name} – ${s.type}, ${fmtDateTime(s.started)}`, href: `${SITE}/raeda/${s.id}`, updated: ts(s.started), summary: (s.text ?? "").slice(0, 300) })),
      ...f.votes.map((v) => ({ id: `atkvaedagreidsla:${v.id}`, title: `Atkvæðagreiðsla: ${v.kind_label}${v.result ? ` – ${v.result}` : ""}`, href: `${murl}#atkvaedi`, updated: ts(v.at), summary: v.yes !== null ? `já ${v.yes}, nei ${v.no ?? 0}, sátu hjá ${v.abstain ?? 0}` : (v.result ?? "") })),
      ...f.docs.map((d) => ({ id: `thingskjal:${lthing}:${d.nr}`, title: `Þingskjal ${d.nr}: ${d.type}`, href: `${SITE}/thingskjal/${lthing}/${d.nr}`, updated: ts(d.issued), summary: d.type })),
    ].sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 50);
    return c.body(atom(`mal:${lthing}:${cls}:${nr}`, `Alþingi · ${nr}. mál: ${m.title}`, `/mal/${lthing}/${cls.toLowerCase()}/${nr}/atom`, entries), 200, { ...FEED, "Cache-Control": LIVE });
  });

  app.get("/thingskjal/:lthing/:nr", async (c) => {
    const lthing = num(c.req.param("lthing")), nr = num(c.req.param("nr"));
    const d = lthing === undefined || nr === undefined ? null : await docPage(sql, lthing, nr);
    if (!d) return html(c, <NotFound what="Þingskjalið fannst ekki í safninu." />, 404);
    await cacheFor(c, d.lthing);
    return html(c, <DocPageView d={d} />);
  });

  app.get("/efni/:id", async (c) => {
    const id = num(c.req.param("id"));
    const t = id === undefined ? null : await topicPage(sql, id);
    if (!t) return html(c, <NotFound what="Efnisflokkurinn fannst ekki." />, 404);
    c.header("Cache-Control", LIVE);
    return html(c, <TopicPageView t={t} />);
  });

  app.get("/nefnd/:id", async (c) => {
    const id = num(c.req.param("id"));
    const n = id === undefined ? null : await committeePage(sql, id);
    if (!n) return html(c, <NotFound what="Nefndin fannst ekki." />, 404);
    c.header("Cache-Control", LIVE);
    return html(c, <CommitteePageView c={n} today={new Date().toISOString().slice(0, 10)} />);
  });

  app.get("/log/:year/:nr", async (c) => {
    const year = num(c.req.param("year")), nr = num(c.req.param("nr"));
    if (year === undefined || nr === undefined || year < 1800 || year > 2100) return html(c, <NotFound what="Lögin fundust ekki." />, 404);
    c.header("Cache-Control", LIVE);
    return html(c, <LawPageView l={await lawPage(sql, year, nr)} />);
  });

  app.get("/thingmadur/:id", async (c) => {
    const id = num(c.req.param("id"));
    const m = id === undefined ? null : await memberPage(sql, id);
    if (!m) return html(c, <NotFound what="Þingmaðurinn fannst ekki." />, 404);
    c.header("Cache-Control", LIVE);
    return html(c, <MemberPageView m={m} />);
  });

  app.get("/flokkur/:id", async (c) => {
    const id = num(c.req.param("id"));
    const p = id === undefined ? null : await partyPage(sql, id);
    if (!p) return html(c, <NotFound what="Flokkurinn fannst ekki." />, 404);
    c.header("Cache-Control", LIVE);
    return html(c, <PartyPageView p={p} />);
  });

  app.get("/dagur/:date", async (c) => {
    const date = iso(c.req.param("date"));
    const d = date ? await dayPage(sql, date) : null;
    if (!d) return html(c, <NotFound what="Enginn þingfundur fannst þennan dag." />, 404);
    // an empty day is a 404 (no sitting), but still renders the neighbours so the page is navigable
    if (d.total === 0) { c.header("Cache-Control", LIVE); return html(c, <DayPageView d={d} />, 404); }
    const complete = (await current()).complete;
    c.header("Cache-Control", d.groups.every((g) => complete.has(g.lthing)) ? IMMUTABLE : LIVE);
    return html(c, <DayPageView d={d} />);
  });

  // ---- MCP (stateless Streamable HTTP, no auth). POST is the protocol; GET in a browser is the connect page; there is
  // no server-initiated SSE stream, so any other GET is 405 (spec: "MUST either return text/event-stream or 405").
  const mcpCors = cors({
    origin: "*", allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Accept", "Mcp-Session-Id", "MCP-Protocol-Version", "Last-Event-ID", "Mcp-Method", "Mcp-Name", "Authorization"],
    exposeHeaders: ["Mcp-Session-Id", "MCP-Protocol-Version", "Retry-After"], maxAge: 86400,
  });
  app.use("/mcp", mcpCors);
  const limited = rateLimiter(opts.mcpRate ?? { capacity: 60, perSecond: 1 });
  app.all("/mcp", async (c) => {
    c.header("Cache-Control", "no-store");
    if (c.req.method === "GET" || c.req.method === "HEAD") {
      // MCP clients ask for an SSE stream with Accept: text/event-stream; everything else (browsers, htmx-boosted links
      // that send */*, curl) gets the connect page
      if (!(c.req.header("accept") ?? "").includes("text/event-stream")) return html(c, <McpPage />);
      return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless and offers no SSE stream. POST JSON-RPC to /mcp." }, id: null }, 405, { Allow: "POST, OPTIONS" });
    }
    if (c.req.method !== "POST") return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server, no sessions to delete)." }, id: null }, 405, { Allow: "POST, OPTIONS" });
    // Origin (spec: MUST validate, 403 if invalid). DNS rebinding targets local servers; for a public read-only server
    // any web origin is fine, so only malformed values are refused.
    const origin = c.req.header("origin");
    if (origin && origin !== "null" && !/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Invalid Origin header" }, id: null }, 403);
    const wait = limited(clientKey((n) => c.req.header(n)));
    if (wait !== null) {
      return c.json({ jsonrpc: "2.0", error: { code: -32000, message: `Rate limited: at most 60 requests a minute per client. Retry after ${wait} s.`, data: { retry_after_seconds: wait } }, id: null },
        429, { "Retry-After": String(wait) });
    }
    return handleMcp(c, sql, (await current()).lthing);
  });

  app.notFound((c) => html(c, <NotFound what="Síðan fannst ekki." />, 404));
  app.onError((e, c) => { console.error(e); return c.text("Villa kom upp. Reyndu aftur síðar.", 500); });
  return app;
}

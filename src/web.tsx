// The site: Hono app factory (testable with app.request) — server.ts binds it to a port.
import { readFileSync } from "node:fs";
import { Hono, type Context } from "hono";
import { etag } from "hono/etag";
import type { Child } from "hono/jsx";
import type { Sql } from "./db.ts";
import { route } from "./route.ts";
import { search, type SearchParams } from "./search.ts";
import { handleMcp } from "./mcp.ts";
import { clearWinner, findMembers, suggest } from "./suggest.ts";
import { composition, corpusStats, dayPage, isSpeechId, lawPage, matterPage, memberPage, partiesFor, partyPage, sessionState, speechPage } from "./queries.ts";
import { fmtDateTime } from "./pages.tsx";
import { KINDS, nameMatches, searchEntities, type Kind } from "./entities.ts";
import { Suggest, SITE, AboutPage, DayPageView, HomePage, LawPageView, MatterPageView, MemberPageView, NotFound, PartyPageView, Rows, SearchPage, SpeechPageView, type SearchView } from "./pages.tsx";

const IMMUTABLE = "public, s-maxage=31536000, stale-while-revalidate=86400, stale-if-error=604800";
const LIVE = "public, s-maxage=300, stale-while-revalidate=3600, stale-if-error=86400";
const SEARCHY = "public, s-maxage=60, stale-while-revalidate=300, stale-if-error=3600";

const asset = (p: string) => readFileSync(new URL(p, import.meta.url));
const CSS = asset("../public/app.css");
const HTMX = asset("../node_modules/htmx.org/dist/htmx.min.js");

const html = (c: Context, node: Child, status: 200 | 404 = 200) =>
  c.html("<!DOCTYPE html>" + String(node), status);
const num = (s: string | undefined): number | undefined => (s !== undefined && /^\d{1,9}$/.test(s) ? Number(s) : undefined);
const iso = (s: string | undefined): string | undefined => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined);

export function createApp(sql: Sql) {
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
  app.get("/robots.txt", (c) => c.text("User-agent: *\nAllow: /\nDisallow: /leit\nDisallow: /mcp\n\nSitemap: https://althingi.solberg.is/sitemap.xml\n"));

  app.get("/healthz", async (c) => {
    const t0 = performance.now();
    const st = await corpusStats(sql);
    const ageH = st.lastIngest ? (Date.now() - st.lastIngest.getTime()) / 3_600_000 : null;
    return c.json({ ok: true, db_ms: Math.round(performance.now() - t0), speeches: st.speeches, last_ingest_age_hours: ageH === null ? null : Math.round(ageH * 10) / 10 });
  });

  app.get("/", async (c) => {
    c.header("Cache-Control", LIVE);
    const st = await current();
    return html(c, <HomePage stats={await corpusStats(sql)} lthing={st.seatLthing} parties={st.parties} />);
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
      sort: u.get("nyjast") ? "newest" : "relevance", cursor: u.get("c") || undefined,
    };
    const keep = ["q", "fra", "til", "thing", "tegund", "flokkur", "embaetti", "umraeda", "hlutverk", "thm", "mal", "nyjast"];
    const base = keep.filter((k) => u.get(k)).map((k) => `${k}=${encodeURIComponent(u.get(k)!)}`).join("&");
    return { p, base, q };
  };

  const view = async (p: SearchParams, base: string, q: string): Promise<SearchView> => {
    const result = await search(sql, p);
    const parties = await partiesFor(sql, result.hits.map((h) => ({ speechId: h.speechId, memberId: h.memberId, date: h.date })));
    const suggestions = !p.cursor && (result.hits.length === 0 || result.query.parsed.parts.length > 0) ? await suggest(sql, q) : [];
    const st = !p.cursor && result.hits.length === 0 ? await corpusStats(sql) : { from: null as string | null };
    const now = await current();
    return { q, result, parties, suggestions, baseQuery: base, corpusFrom: st.from, coverage: { first: now.first, last: now.lthing }, partyList: now.parties };
  };

  app.get("/leit", async (c) => {
    const { p, base, q } = await readSearch(c);
    if (!q.trim()) return c.redirect("/");
    if (!p.cursor) {
      const r = route(q, (await current()).lthing);
      if (r) return c.redirect(r.path, 302);
      const m = clearWinner(await findMembers(sql, q));
      if (m && nameMatches(m.name, q) && !new URL(c.req.url).searchParams.get("beint")) return c.redirect(`/thingmadur/${m.id}`, 302);
    }
    c.header("Cache-Control", SEARCHY);
    const t = new URL(c.req.url).searchParams.get("t") ?? "allt";
    const v = await view(p, base, q);
    if (!p.cursor) {
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
             (select left(text, 300) from paragraphs where speech_id = s.id order by seq limit 1) as text
      from speeches s left join matters m on m.lthing = s.lthing and m.cls = s.matter_cls and m.nr = s.matter_nr
      where s.text_state = 'done' order by s.started desc limit 30`;
    return c.body(atom("nyjast", "Alþingi · nýjustu ræður", "/nyjast/atom", rows.map((r) => ({
      id: `raeda:${r.id}`, title: `${r.member_name} – ${r.type}, ${fmtDateTime(r.started)}`, href: `${SITE}/raeda/${r.id}`,
      updated: r.started.replace(" ", "T") + "Z", summary: `${r.title ? r.title + ": " : ""}${r.text ?? ""}`,
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
    return html(c, <MatterPageView m={m} />);
  });

  app.get("/log/:year/:nr", async (c) => {
    const year = num(c.req.param("year")), nr = num(c.req.param("nr"));
    if (year === undefined || nr === undefined || year < 1800 || year > 2100) return html(c, <NotFound what="Lögin fundust ekki." />, 404);
    c.header("Cache-Control", LIVE);
    return html(c, <LawPageView year={year} nr={nr} matters={await lawPage(sql, year, nr)} />);
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

  // ---- MCP (stateless Streamable HTTP). never cached; the in-process limit is a placeholder for the edge rule (WP7)
  app.all("/mcp", async (c) => {
    c.header("Cache-Control", "no-store");
    return handleMcp(c, sql, (await current()).lthing);
  });

  app.notFound((c) => html(c, <NotFound what="Síðan fannst ekki." />, 404));
  app.onError((e, c) => { console.error(e); return c.text("Villa kom upp. Reyndu aftur síðar.", 500); });
  return app;
}

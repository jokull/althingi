// Persona sweep harness (docs/PERSONA-SWEEP.md): runs every probe against the live site and records facts. Usage: BASE=http://localhost:3051 bun scripts/persona-sweep.ts out.json [idPrefix]
const B = process.env.BASE ?? "http://localhost:3051";
type Probe = { web: string } | { mcp: string; args: Record<string, unknown> };
const P: Record<string, Probe[]> = {
  "P01-01": [{ web: "/leit?q=veiðigjöldin umræða í dag" }, { web: "/leit?q=veiðigjöldin&fra=2026-06-19&til=2026-06-19&nyjast=1" }, { web: "/leit?q=veiðigjöldin nýjast" }],
  "P01-02": [{ web: "/leit?q=Hvað sagði Kristrún Frostadóttir um Landspítala í þessari viku?" }, { web: "/leit?q=Kristrún Frostadóttir Landspítali" }, { web: "/leit?q=Landspítali&thm=1417" }],
  "P01-03": [{ web: "/leit?q=veiðigjald" }, { web: "/raeda/rad20260612T110123" }],
  "P01-04": [{ web: "/leit?q=orkuskortur&nyjast=1" }, { web: "/leit?q=Hver sagði fyrst orkuskortur" }, { mcp: "first_use", args: { q: "orkuskortur" } }],
  "P01-05": [{ web: "/leit?q=Flokkur fólksins atkvæði 300. mál" }, { web: "/mal/157/a/300" }],
  "P01-06": [{ web: "/leit?q=Inga Sæland fundarstjórn október 2026" }, { web: "/leit?q=fundarstjórn&thm=1332&tegund=um fundarstjórn" }, { mcp: "aggregate", args: { metric: "speeches", group_by: "speech_type", member_id: 1332 } }],
  "P01-07": [{ web: "/mal/157/a/300" }, { web: "/mal/157/a/300/atom" }],
  "P01-08": [{ web: "/leit?q=forsætisráðherra andsvar Sigmundur Davíð" }, { web: "/leit?q=Sigmundur Davíð&tegund=andsvar&embaetti=forsrh." }],
  "P01-09": [{ web: "/leit?q=\"þetta er lygi\"" }],
  "P01-10": [{ web: "/raeda/rad20260612T110123" }],
  "P02-01": [{ mcp: "search_speeches", args: { q: "hælisleitendur", member_id: 1332 } }, { mcp: "search_speeches", args: { q: "hælisleitendur", member_id: 1417, limit: 5 } }],
  "P02-02": [{ mcp: "search_speeches", args: { q: "\"ekki er allt sem sýnist\"" } }, { web: "/leit?q=\"ekki er allt sem sýnist\"" }],
  "P02-03": [{ web: "/leit?q=þskj. 421" }, { web: "/thingskjal/157/421" }, { mcp: "list_votes", args: { lthing: 157, class: "A", nr: 300 } }],
  "P02-04": [{ mcp: "search_speeches", args: { q: "\"fyrir áramót\"", capacity: "ráðherra" } }, { web: "/leit?q=ráðherra \"fyrir áramót\"" }],
  "P02-05": [{ mcp: "aggregate", args: { metric: "speeches", group_by: "lthing", q: "neyðarástand" } }],
  "P02-06": [{ mcp: "explain_query", args: { q: "lán" } }],
  "P02-07": [{ mcp: "search_speeches", args: { q: "verðbólga", limit: 5 } }, { mcp: "get_context", args: { speech_id: "rad20260612T110123", mgr: 2 } }],
  "P02-08": [{ mcp: "list_votes", args: { lthing: 157, date: "2026-06-12" } }, { mcp: "search_speeches", args: { q: "veiðigjald", capacity: "ráðherra", date_from: "2026-06-12", date_to: "2026-06-12" } }],
  "P02-09": [{ mcp: "get_speech", args: { speech_id: "rad20260612T110123", to: 1 } }],
  "P02-10": [{ mcp: "search_speeches", args: { q: "ógeðfellt", date_from: "1998-01-01", date_to: "1998-12-31" } }, { web: "/leit?q=Davíð Oddsson ógeðfellt 1998" }],
  "P03-01": [{ web: "/leit?q=húsnæðismál&flokkur=38&thing=157" }, { web: "/leit?q=Samfylkingin húsnæðismál" }],
  "P03-02": [{ web: "/leit?q=stjórnarandstaðan fjárlög 2026" }, { web: "/leit?q=fjárlög 2026" }],
  "P03-03": [{ web: "/thingmadur/1332" }, { web: "/leit?q=Inga Sæland fyrirspurn&t=mal" }],
  "P03-04": [{ web: "/leit?q=412. mál" }, { web: "/mal/157/a/412" }],
  "P03-05": [{ web: "/mal/157/a/300" }, { web: "/leit?q=umsagnir 300. mál" }],
  "P03-06": [{ mcp: "aggregate", args: { metric: "speeches", group_by: "member", q: "leikskóli" } }, { web: "/leit?q=leikskóli" }],
  "P03-07": [{ web: "/leit.csv?q=ráðherra&embaetti=forsrh.&fra=2026-06-12&til=2026-06-19" }, { web: "/leit?q=forsætisráðherra síðustu viku" }],
  "P03-08": [{ web: "/leit?q=Bergþór Ólason andsvar" }, { web: "/leit?q=andsvar&thm=1327&tegund=andsvar" }],
  "P03-09": [{ web: "/leit?q=Jakob Frímann" }],
  "P03-10": [{ web: "/leit?q=gær" }, { web: "/dagur/2026-11-10" }, { web: "/dagur/2026-06-19" }, { web: "/" }],
  "P04-01": [{ web: "/leit?q=lög nr. 34/1991" }, { web: "/log/1991/34" }],
  "P04-02": [{ web: "/leit?q=þskj. 512" }, { web: "/thingskjal/157/512" }, { web: "/leit?q=nefndarálit meirihluta 300. mál" }],
  "P04-03": [{ web: "/mal/157/a/300" }, { web: "/leit?q=framsöguræða ráðherra 1. umræða 300. mál" }],
  "P04-04": [{ web: "/leit?q=212. mál" }, { web: "/mal/157/a/212" }],
  "P04-05": [{ web: "/leit?q=stjórnsýslulög&fra=2020-01-01&til=2026-12-31" }],
  "P04-06": [{ web: "/mal/157/a/300" }],
  "P04-07": [{ web: "/mal/157/a/300" }],
  "P04-08": [{ web: "/mal/157/a/300" }, { mcp: "get_matter", args: { lthing: 157, nr: 300 } }],
  "P04-09": [{ web: "/mal/157/a/300/umraeda" }],
  "P04-10": [{ web: "/leit?q=meðalhóf&thing=157&mal=a/300" }, { web: "/leit?q=meðalhóf 300. mál" }],
  "P05-01": [{ web: "/leit?q=vindorka vindorkuver&nyjast=1" }, { web: "/leit?q=vindorka vindorkuver nýjast fyrst" }],
  "P05-02": [{ web: "/leit/atom?q=rammaáætlun" }],
  "P05-03": [{ web: "/mal/157/a/412" }, { web: "/leit?q=hverjir studdu 412. mál" }],
  "P05-04": [{ mcp: "aggregate", args: { metric: "speeches", group_by: "party", q: "loftslag" } }],
  "P05-05": [{ web: "/leit?q=umhverfis- og samgöngunefnd" }, { web: "/leit?q=umhverfis- og samgöngunefnd&t=nefndir" }],
  "P05-06": [{ web: "/leit?q=Hvalárvirkjun" }],
  "P05-07": [{ web: "/leit?q=umhverfisráðherra Landvernd" }, { web: "/leit?q=Landvernd&embaetti=umhv." }],
  "P05-08": [{ web: "/leit?q=Umhverfismál" }, { web: "/leit?q=Umhverfismál&t=efni" }],
  "P05-09": [{ web: "/leit.csv?q=strandveiðar&fra=2024-01-01&til=2026-12-31" }],
  "P05-10": [{ web: "/leit?q=náttúruvernd&t=mal" }],
  "P06-01": [{ web: "/leit?q=lög nr. 90/2018" }, { web: "/log/2018/90" }],
  "P06-02": [{ web: "/leit?q=þskj. 421 á 157. þingi" }, { web: "/leit?q=þskj. 157/421" }],
  "P06-03": [{ web: "/leit?q=\"2. gr.\"&thing=157&mal=a/300&hlutverk=framsögumaður nefndarálits" }, { web: "/leit?q=2. gr.&thing=157&mal=a/300" }],
  "P06-04": [{ web: "/mal/157/a/300" }],
  "P06-05": [{ web: "/leit?q=bótaábyrgð skaðabótalög nr. 50/1993" }, { web: "/log/1993/50" }, { web: "/leit?q=bótaábyrgð" }],
  "P06-06": [{ web: "/mal/157/a/300" }],
  "P06-07": [{ web: "/raeda/rad20260612T110123" }],
  "P06-08": [{ web: "/log/1991/34" }],
  "P06-09": [{ web: "/leit?q=innanríkisráðherra útlendingalög 2012" }, { web: "/leit?q=útlendingalög&embaetti=innvrh." }],
  "P06-10": [{ web: "/leit?q=svar við skriflegri fyrirspurn" }, { web: "/leit?q=leikskóli&tegund=svar" }],
  "P07-01": [{ mcp: "aggregate", args: { metric: "speeches", group_by: "party", q: "Evrópusambandið" } }],
  "P07-02": [{ web: "/leit?q=atkvæði gegn eigin flokki" }],
  "P07-03": [{ mcp: "aggregate", args: { metric: "words", group_by: "party" } }],
  "P07-04": [{ web: "/leit?q=Steingrímur J. Icesave 2009" }],
  "P07-05": [{ web: "/leit.csv?q=kvótakerfi" }],
  "P07-06": [{ mcp: "aggregate", args: { metric: "speeches", group_by: "party", q: "fullveldi" } }, { web: "/leit?q=fullveldi&flokkur=47" }],
  "P07-07": [{ web: "/leit?q=EES-samningurinn 1992" }],
  "P07-08": [{ mcp: "list_sessions", args: {} }, { web: "/thing/157" }],
  "P07-09": [{ web: "/leit?q=Björt framtíð" }, { web: "/flokkur/44" }],
  "P07-10": [{ web: "/raeda/rad20260612T110123" }],
  "P08-01": [{ mcp: "search_speeches", args: { q: "verðbólga", date_from: "2026-05-20", date_to: "2026-06-19", limit: 100 } }, { web: "/leit.json?q=verðbólga" }],
  "P08-02": [{ web: "/thing/157/atkvaedagreidslur.csv" }, { mcp: "list_votes", args: { lthing: 157, limit: 200 } }],
  "P08-03": [{ web: "/mal/157/a/300/atom" }],
  "P08-04": [{ mcp: "aggregate", args: { metric: "words", group_by: "party", date_from: "2026-06-08", date_to: "2026-06-14" } }],
  "P08-05": [{ mcp: "search_speeches", args: { q: "verðbólga", limit: 1 } }],
  "P08-06": [{ web: "/gogn" }],
  "P08-07": [{ mcp: "explain_query", args: { q: "húsnæðislán vextir" } }],
  "P08-08": [{ web: "/raeda/rad20260612T110123" }, { web: "/raeda/r2026-06-12T14:19:33" }],
  "P08-09": [{ mcp: "aggregate", args: { metric: "speeches", group_by: "member", q: "störf þingsins" } }, { web: "/leit?q=störf þingsins" }],
  "P08-10": [{ web: "/nyjast/atom" }],
  "P09-01": [{ web: "/ord/lán" }, { web: "/leit?q=lán" }],
  "P09-02": [{ mcp: "aggregate", args: { metric: "speeches", group_by: "year", q: "kvóti" } }, { mcp: "aggregate", args: { metric: "speeches", group_by: "year", q: "aflaheimild" } }],
  "P09-03": [{ web: "/leit?q=á" }],
  "P09-04": [{ web: "/leit?q=lán" }],
  "P09-05": [{ mcp: "first_use", args: { q: "gervigreind" } }, { web: "/leit?q=gervigreind" }],
  "P09-06": [{ web: "/leit?q=sko" }],
  "P09-07": [{ web: "/raeda/rad20260612T110123.json" }],
  "P09-08": [{ web: "/thingmadur/1417" }],
  "P09-09": [{ mcp: "explain_query", args: { q: "\"fyrst og fremst\"" } }, { web: "/leit?q=\"fyrst og fremst\"" }],
  "P09-10": [{ web: "/leit?q=\"meika sens\"" }, { web: "/leit?q=meika" }],
  "P10-01": [{ web: "/leit?q=hvað sagði þingmaðurinn minn um leikskóla" }, { web: "/leit?q=leikskólar" }],
  "P10-02": [{ web: "/leit?q=Norðausturkjördæmi" }, { web: "/leit?q=þingmenn Norðausturkjördæmis" }],
  "P10-03": [{ web: "/leit?q=hvað er andsvar" }, { web: "/um" }],
  "P10-04": [{ web: "/leit?q=áfengi í matvöruverslunum" }, { web: "/leit?q=áfengi&t=atkvaedi" }],
  "P10-05": [{ web: "/leit?q=áfengi matvöruverslun" }, { web: "/leit?q=áfengi&t=mal" }],
  "P10-06": [{ web: "/leit?q=þskj. nál. frv. á ensku" }, { web: "/en" }],
  "P10-07": [{ web: "/raeda/rad20260612T110123" }],
  "P10-08": [{ web: "/leit?q=Katrín Jakobsdóttir forsætisráðherra 2017" }],
  "P10-09": [{ web: "/raeda/rad20260612T110123" }],
  "P10-10": [{ web: "/" }, { web: "/leit?q=veiðigjald" }],
};

const pick = (h: string, re: RegExp) => (h.match(re)?.[1] ?? "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const all = (h: string, re: RegExp) => [...h.matchAll(re)].map((m) => (m[1] ?? "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim());

async function web(path: string): Promise<Record<string, unknown>> {
  const t0 = performance.now();
  const r = await fetch(B + encodeURI(path).replace(/%25/g, "%"), { redirect: "manual" });
  const ms = Math.round(performance.now() - t0);
  const ct = r.headers.get("content-type") ?? "";
  const body = await r.text();
  const o: Record<string, unknown> = { path, status: r.status, ms };
  if (r.headers.get("location")) o.location = r.headers.get("location");
  if (r.status === 302 && o.location && String(o.location).startsWith("/leit")) { const f: Record<string, unknown> = await web(decodeURIComponent(String(o.location))); return { ...f, path, redirectedTo: decodeURIComponent(String(o.location)), ms: ms + Number(f.ms) }; }
  if (!ct.includes("html")) { o.type = ct.split(";")[0]; o.bytes = body.length; o.head = body.slice(0, 300).replace(/\s+/g, " "); o.lines = body.split("\n").length; return o; }
  o.title = pick(body, /<title>([^<]*)/);
  o.hits = (body.match(/class="hit"/g) ?? []).length;
  const interp = pick(body, /Leitað að: <span class="interp">([\s\S]*?)<\/span>/);
  if (interp) o.interp = interp;
  const lesid = pick(body, /<p class="sr-how">(Lesið sem:[\s\S]*?)<\/p>/);
  if (lesid) o.lesid = lesid.slice(0, 200);
  const total = pick(body, /<h2>Ræður<span class="n">\s*([^<]*)/);
  if (total) o.total = total;
  const notices = all(body, /class="notice[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)>/g);
  if (notices.length) o.notices = notices.map((x) => x.slice(0, 160));
  const top = pick(body, /class="tc-t"><a[^>]*>([\s\S]*?)<\/a>/);
  if (top) o.top = top;
  const groups = all(body, /class="group-h"><span>([^<]*)/g);
  if (groups.length) o.groups = groups;
  const tabs = all(body, /<nav class="tabs"[^>]*>([\s\S]*?)<\/nav>/g);
  if (tabs.length) o.tabs = tabs[0];
  const chips = all(body, /class="chip" aria-current="true"[^>]*>([\s\S]*?)<\/a>/g);
  if (chips.length) o.activeChips = chips;
  if (body.includes("empty-state")) o.empty = pick(body, /class="empty-state">([\s\S]*?)<\/div>/).slice(0, 200);
  const firstHits = all(body, /<article class="hit">([\s\S]*?)<\/header>/g).slice(0, 3).map((x) => x.slice(0, 110));
  if (firstHits.length) o.firstHits = firstHits;
  const h2 = all(body, /<h2[^>]*>([\s\S]*?)<\/h2>/g);
  if (h2.length) o.h2 = h2.slice(0, 12);
  const lede = pick(body, /<h1[^>]*>([\s\S]*?)<\/h1>/);
  if (lede) o.h1 = lede.slice(0, 120);
  return o;
}

async function mcp(name: string, args: Record<string, unknown>) {
  const t0 = performance.now();
  const r = await fetch(B + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const txt = await r.text();
  const ms = Math.round(performance.now() - t0);
  const line = txt.split("\n").find((l) => l.startsWith("data: "));
  let d: any = null;
  try { const j = JSON.parse(line!.slice(6)); d = j.result?.structuredContent ?? j.error ?? j.result; } catch { d = { raw: txt.slice(0, 300) }; }
  const o: Record<string, unknown> = { mcp: name, args, ms, status: r.status };
  if (d?.isError || d?.code) o.error = JSON.stringify(d).slice(0, 300);
  if (d?.hits) { o.hits = d.hits.length; o.firstHits = d.hits.slice(0, 3).map((h: any) => `${h.member?.name} ${h.started} ${h.speech_type} ${h.matter?.nr ?? ""}`); o.interp = d.query?.interpreted_as; if (d.why) o.why = d.why; if ("total" in d) o.total = d.total; o.next = !!d.next_cursor; }
  if (d?.buckets) o.buckets = d.buckets.slice(0, 8);
  if (d?.earliest) { o.earliest = d.earliest.slice(0, 2).map((e: any) => `${e.member.name} ${e.started}`); o.years = d.speeches_per_year; }
  if (d?.votes) { o.votes = d.votes.length; o.firstVotes = d.votes.slice(0, 2); }
  if (d?.sessions) o.sessions = d.sessions.slice(0, 3);
  if (d?.speech) o.speech = { citation: d.speech.citation, revision: d.speech.revision };
  if (d?.citation && !d.speech) o.citation = d.citation;
  if (d?.matter) o.matter = { status: d.matter.status, docs: d.documents?.length, votes: d.votes?.length, sponsors: d.sponsors };
  if (d?.interpreted_as && !d.hits) o.interp = d.interpreted_as;
  if (!Object.keys(o).some((k) => !["mcp", "args", "ms", "status"].includes(k))) o.raw = JSON.stringify(d).slice(0, 300);
  return o;
}

const out: Record<string, unknown[]> = {};
const filt = process.argv[3];
for (const [id, probes] of Object.entries(P)) {
  if (filt && !id.startsWith(filt)) continue;
  out[id] = [];
  for (const p of probes) out[id]!.push("web" in p ? await web(p.web) : await mcp(p.mcp, p.args));
}
await Bun.write(process.argv[2] ?? "sweep.json", JSON.stringify(out, null, 1));
console.log("probes:", Object.values(out).flat().length);
export {};

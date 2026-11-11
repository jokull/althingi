// Agent-facing text: llms.txt, llms-full.txt, connect instructions per client, the MCP server card / registry server.json.
// One source for the /mcp page, the front page section, their Markdown variants and the MCP `guide` resource.
import type { Sql } from "./db.ts";
import { SITE } from "./pages.tsx";
import { glossaryMd } from "./markdown.ts";

export const MCP_URL = `${SITE}/mcp`;
export const SERVER_NAME = "is.solberg.althingi/althingi"; // registry namespace via HTTP verification of althingi.solberg.is
export const ATTRIBUTION = "Gögn / data: Alþingi (https://www.althingi.is), opin XML-þjónusta og gagnasafn þess. Lemmun byggir á Beygingarlýsingu íslensks nútímamáls (BÍN), © Stofnun Árna Magnússonar í íslenskum fræðum, CC BY-SA 4.0, um lemma-is.";
export const RATE = "60 MCP requests a minute per client IP (HTTP 429 + Retry-After when exceeded); the edge also blocks bursts above 40 requests / 10 s on /mcp and /leit.";

/** Copy-paste connect instructions. Verified against each vendor's docs on 2026-11-11 (docs/AGENTS.md). */
export const CLIENTS: { id: string; name: string; steps: string; code?: string }[] = [
  { id: "claude", name: "Claude (claude.ai, Desktop, farsími)", steps: "Customize › Connectors › Add › Add custom connector. Nafn: Alþingi, URL eins og hér að ofan, Authentication: „No sign-in“. Á Team/Enterprise bætir eigandi honum við í Organization settings › Connectors." },
  { id: "chatgpt", name: "ChatGPT", steps: "chatgpt.com/plugins › + › Add custom MCP server. Nafn og URL eins og hér að ofan, Authentication: „No authentication“. Síðan @Alþingi í spjalli." },
  { id: "claude-code", name: "Claude Code", steps: "Í skel:", code: `claude mcp add --transport http althingi ${MCP_URL} --scope user` },
  { id: "cursor", name: "Cursor", steps: "Í ~/.cursor/mcp.json:", code: JSON.stringify({ mcpServers: { althingi: { url: MCP_URL } } }, null, 2) },
  { id: "vscode", name: "VS Code", steps: "Í .vscode/mcp.json:", code: JSON.stringify({ servers: { althingi: { type: "http", url: MCP_URL } } }, null, 2) },
  { id: "openai-api", name: "OpenAI Responses API", steps: "Sem tól:", code: JSON.stringify({ type: "mcp", server_label: "althingi", server_url: MCP_URL, require_approval: "never" }, null, 2) },
  { id: "anthropic-api", name: "Anthropic Messages API", steps: "Með haus anthropic-beta: mcp-client-2026-09-15:", code: JSON.stringify({ mcp_servers: [{ type: "url", url: MCP_URL, name: "althingi" }], tools: [{ type: "mcp_toolset", mcp_server_name: "althingi" }] }, null, 2) },
];

export const URL_SCHEME: [string, string][] = [
  ["/raeda/{speech_id}", "a speech, e.g. /raeda/rad20180306T163325; paragraphs anchor as #mgr-N"],
  ["/mal/{lthing}/{a|b}/{nr}", "a matter (þingmál), e.g. /mal/157/a/300; /umraeda = the whole debate on one page"],
  ["/thingmadur/{member_id}", "a member of parliament"],
  ["/flokkur/{party_id}", "a party"],
  ["/log/{year}/{nr}", "a law, e.g. /log/1991/34 (lög nr. 34/1991)"],
  ["/thingskjal/{lthing}/{nr}", "a parliamentary document"],
  ["/dagur/{YYYY-MM-DD}", "every speech of one sitting day"],
  ["/leit.json?q=…", "search as JSON (same parameters as /leit; cursor-paged, up to 100 per page)"],
];

export interface CorpusFacts { first: number | null; last: number | null; from: string | null; to: string | null; speeches: number }
export async function corpusFacts(sql: Sql): Promise<CorpusFacts> {
  const [r] = await sql<{ first: number | null; last: number | null; d0: string | null; d1: string | null; n: number }[]>`
    select min(lthing) first, max(lthing) last, min(speech_date)::text d0, max(speech_date)::text d1, count(*)::int n from speeches where text_state = 'done'`;
  return { first: r?.first ?? null, last: r?.last ?? null, from: r?.d0 ?? null, to: r?.d1 ?? null, speeches: r?.n ?? 0 };
}
const boundary = (f: CorpusFacts) => f.last
  ? `Speech text for sessions ${f.first}–${f.last} (${f.from} to ${f.to}, ${f.speeches.toLocaleString("en")} speeches). The text era starts in 2005 (session 131); older speeches are index-only and not searchable. Older sessions are still being added: check list_sessions.`
  : "The corpus is empty right now.";

/** https://llmstxt.org: H1, one blockquote, prose, then H2 link lists; `## Optional` last. */
export async function llmsTxt(sql: Sql): Promise<string> {
  const f = await corpusFacts(sql);
  return `# Alþingi — leit í ræðum Alþingis

> Search and cite the Icelandic parliament (Alþingi): speeches with full text, matters (bills, resolutions, questions), votes with every member's ballot, members, parties, sittings and the law collection. Icelandic-aware (lemmatized) search. Public, read-only, no login. Leit í ræðum, málum, atkvæðagreiðslum og lögum Alþingis.

Use the MCP server: ${MCP_URL} (Streamable HTTP, stateless, no authentication, JSON responses). Claude: Customize › Connectors › Add custom connector, "No sign-in". ChatGPT: chatgpt.com/plugins › Add custom MCP server, "No authentication". Claude Code: \`claude mcp add --transport http althingi ${MCP_URL}\`. Cursor / VS Code: a server with \`"url": "${MCP_URL}"\` (VS Code also \`"type": "http"\`). Full instructions: ${SITE}/mcp.md

Corpus: ${boundary(f)} Every MCP response carries a \`corpus\` block; "first", "never" and totals hold only within it.

Search queries are Icelandic keywords, not questions: any inflection finds all forms ("hestinum" finds "hestur"), all words must occur in one paragraph, "quoted" means the exact phrase. Put people, parties, dates and matters in filters, not in the query.

Every page has a Markdown version at the same URL plus \`.md\` (or send \`Accept: text/markdown\`). Cite the page URL; speech paragraphs have stable anchors \`#mgr-N\`. Party is always the member's party on the date in question.

Rate limits: ${RATE} Bulk use: please ask rather than crawl.

Attribution: ${ATTRIBUTION} Alþingi's own terms apply to its data; this site claims no licence over it.

## MCP

- [Connect page](${SITE}/mcp.md): copy-paste config for Claude, ChatGPT, Claude Code, Cursor, VS Code, OpenAI and Anthropic APIs
- [MCP server card](${SITE}/mcp/server-card): server metadata (MCP Server Cards, SEP-2127)
- [Full agent guide](${SITE}/llms-full.txt): this file plus every tool, the glossary and the URL scheme

## URL scheme

${URL_SCHEME.map(([p, d]) => `- [${p}](${SITE}${p.replace(/\{.*$/, "").replace(/\?.*$/, "")}): ${d}`).join("\n")}

## Data

- [Search API (OpenAPI 3.1)](${SITE}/openapi.json): /leit.json, /healthz, feeds, CSV exports
- [Newest speeches (Atom)](${SITE}/nyjast/atom): the latest 30 speeches
- [Sitemap](${SITE}/sitemap.xml): every speech, matter, member and law page

## Optional

- [About the site](${SITE}/um.md): sources, boundary, what is inferred, privacy
- [Front page](${SITE}/index.md): the same introduction in Icelandic
`;
}

/** llms-full.txt = the DOCS expanded (tools, glossary), not the corpus (hundreds of MB; use the MCP or the pages). */
export async function llmsFullTxt(sql: Sql, tools: { name: string; title?: string; description?: string }[]): Promise<string> {
  return `${await llmsTxt(sql)}
## MCP tools

${tools.map((t) => `### ${t.name}${t.title ? ` — ${t.title}` : ""}\n\n${t.description ?? ""}`).join("\n\n")}

## Resources

Resource templates (text/markdown) with the same https URLs as the pages: ${SITE}/raeda/{speech_id}.md, ${SITE}/mal/{lthing}/{class}/{nr}.md, ${SITE}/thingmadur/{member_id}.md, ${SITE}/log/{year}/{nr}.md, ${SITE}/dagur/{date}.md.

## Glossary (orðskýringar)

${glossaryMd()}
`;
}

/** The connect page as Markdown (/mcp.md). */
export function mcpMd(): string {
  return `# Tengjast Alþingisleit með MCP / Connect with MCP

MCP-þjónn: \`${MCP_URL}\`

Opinn, aðeins lestur, engin innskráning (Streamable HTTP, stateless). Public, read-only, no sign-in.

${CLIENTS.map((c) => `## ${c.name}\n\n${c.steps}${c.code ? `\n\n\`\`\`\n${c.code}\n\`\`\`` : ""}`).join("\n\n")}

## Hvað þjónninn gerir / What it does

Leit í ræðum frá 2005 (lemmuð íslenska), mál, atkvæðagreiðslur og atkvæði hvers þingmanns, þingmenn, þingfundir og lagasafn. Hver niðurstaða hefur slóð til að vísa í. Tools: search_speeches, get_speech, get_context, get_matter, get_vote, member_votes, get_member, get_law, get_sitting, list_sittings, list_votes, aggregate, first_use, explain_query, list_sessions, search, fetch.

Takmörk / limits: ${RATE}

${ATTRIBUTION}

Meira: ${SITE}/llms.txt
`;
}

/** Registry server.json (also served, with the card schema, at /mcp/server-card). Prepared, not published. */
export function serverJson(version: string) {
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    name: SERVER_NAME,
    title: "Alþingi",
    description: "Search Icelandic parliament speeches, matters, votes, members and laws. Public, read-only.",
    version,
    websiteUrl: SITE,
    remotes: [{ type: "streamable-http", url: MCP_URL }],
  };
}
export function serverCard(version: string) {
  const { $schema: _, remotes, ...rest } = serverJson(version);
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    ...rest,
    remotes: remotes.map((r) => ({ ...r, supportedProtocolVersions: ["2025-11-25", "2025-06-18", "2025-03-26"] })),
  };
}

export function homeMd(f: CorpusFacts): string {
  return `---
title: "Leit í ræðum Alþingis"
url: "${SITE}/"
---

# Leit í ræðum Alþingis

Leitarvél yfir ræður, mál, atkvæðagreiðslur og lög Alþingis sem finnur allar beygingarmyndir orða („hestinum“ finnur „hestur“). Search engine for the Icelandic parliament.

${f.last ? `Safnið: ${f.speeches} ræður með texta af ${f.first}.–${f.last}. þingi (${f.from} til ${f.to}). Ræðutexti er til frá 2005.` : "Safnið er tómt."}

## Fyrir gervigreind / For AI agents

Opinn MCP-þjónn, engin innskráning: \`${MCP_URL}\`

- Claude: Customize › Connectors › Add custom connector, „No sign-in“.
- ChatGPT: chatgpt.com/plugins › Add custom MCP server, „No authentication“.
- Claude Code: \`claude mcp add --transport http althingi ${MCP_URL}\`
- Cursor / VS Code: \`{"url": "${MCP_URL}"}\` (VS Code: \`"type": "http"\`)

Leiðbeiningar: ${SITE}/mcp.md · ${SITE}/llms.txt · API: ${SITE}/openapi.json · Hver síða er til sem Markdown: bættu \`.md\` við slóðina.

## Slóðir / URL scheme

${URL_SCHEME.map(([p, d]) => `- \`${p}\`: ${d}`).join("\n")}

${ATTRIBUTION}
`;
}

export function aboutMd(): string {
  return `---
title: "Um vefinn"
url: "${SITE}/um"
---

# Um vefinn

Leitarvél yfir ræður Alþingis með íslenskri beygingargreiningu (lemma-is). Gögnin koma úr opinni XML-þjónustu og gagnasafni Alþingis; vefurinn sækir hvert skjal einu sinni, með 5 sekúndna millibili og auðkennir sig.

## Mörk safnsins

Ræðutexti er til frá 2005. Eldri ræður (1991–2004) eru aðeins skráðar í ræðuskrá og ekki leitarbærar. Allar „fyrstu“ og „samtals“ tölur eiga við tímabilið frá 2005.

## Hvað er áætlað

Tengsl sem ekki eru gefin upp í gögnunum (til dæmis hvaða ræðu andsvar svarar) eru merkt sem áætluð. Framíköll eru birt en ekki leitarbær.

## Orðskýringar

${glossaryMd()}

## Persónuvernd

Fyrirspurnir og IP-tölur eru ekki sendar til þriðja aðila.

${ATTRIBUTION}
`;
}

/** schema.org for the front page: the site, its search action, and the dataset with how to reach it (incl. MCP). */
export function homeJsonLd(f: CorpusFacts) {
  return {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebSite", "@id": `${SITE}/#site`, url: `${SITE}/`, name: "Alþingi · leit", inLanguage: "is",
        potentialAction: { "@type": "SearchAction", target: `${SITE}/leit?q={q}`, "query-input": "required name=q" } },
      { "@type": "Dataset", name: "Ræður Alþingis (texti frá 2005)", description: `Speeches, matters, votes with per-member ballots, members and laws of the Icelandic parliament. Public MCP server at ${MCP_URL} (no sign-in); Markdown of every page at <url>.md; guide at ${SITE}/llms.txt.`,
        url: `${SITE}/`, inLanguage: "is", isBasedOn: "https://www.althingi.is", creditText: ATTRIBUTION,
        temporalCoverage: f.from && f.to ? `${f.from}/${f.to}` : undefined,
        distribution: [
          { "@type": "DataDownload", name: "MCP server (Streamable HTTP)", contentUrl: MCP_URL, encodingFormat: "application/json" },
          { "@type": "DataDownload", name: "Search API", contentUrl: `${SITE}/leit.json`, encodingFormat: "application/json" },
          { "@type": "DataDownload", name: "llms.txt", contentUrl: `${SITE}/llms.txt`, encodingFormat: "text/markdown" },
        ] },
    ],
  };
}

/** OpenAPI 3.1 for the plain-HTTP surface (the MCP has its own discovery). */
export function openApi(version: string) {
  const q = { name: "q", in: "query", required: true, schema: { type: "string", maxLength: 200 }, description: "Icelandic keywords (lemmatized; any inflection); \"quoted\" = exact phrase" };
  const opt = (name: string, description: string, schema: object = { type: "string" }) => ({ name, in: "query", required: false, schema, description });
  const filters = [
    opt("fra", "Date from (YYYY-MM-DD)", { type: "string", format: "date" }), opt("til", "Date to (YYYY-MM-DD)", { type: "string", format: "date" }),
    opt("thing", "Session number (löggjafarþing)", { type: "integer" }), opt("thm", "Member id", { type: "integer" }), opt("flokkur", "Party id (seat on the speech date)", { type: "integer" }),
    opt("tegund", "Speech type: ræða, andsvar, flutningsræða …"), opt("mal", "Matter within `thing`: a/300"), opt("nyjast", "Sort: any value = newest first; 'elst' = oldest first"),
    opt("c", "Cursor (next_cursor)"),
  ];
  const md = (summary: string, path: string) => ({ get: { summary, responses: { 200: { description: "Markdown", content: { "text/markdown": {} } }, 404: { description: "Not in the corpus" } } }, _path: path });
  const paths: Record<string, unknown> = {
    "/leit.json": { get: { summary: "Search speeches", parameters: [q, ...filters, opt("limit", "1–100, default 25", { type: "integer", minimum: 1, maximum: 100 })],
      responses: { 200: { description: "Hits", content: { "application/json": { schema: { type: "object", properties: {
        total: { type: ["integer", "null"] }, total_capped: { type: "boolean" }, next_cursor: { type: ["string", "null"] },
        hits: { type: "array", items: { type: "object", properties: { speech_id: { type: "string" }, started: { type: "string" }, member: { type: "object" }, speech_type: { type: "string" }, url: { type: "string" }, paragraphs: { type: "array", items: { type: "object", properties: { mgr: { type: "integer" }, text: { type: "string" } } } } } } },
      } } } } }, 400: { description: "q missing" } } } },
    "/leit/atom": { get: { summary: "Search as an Atom feed (newest first)", parameters: [q, ...filters], responses: { 200: { description: "Atom", content: { "application/atom+xml": {} } } } } },
    "/leit.csv": { get: { summary: "Search as CSV (up to 500 speeches)", parameters: [q, ...filters], responses: { 200: { description: "CSV", content: { "text/csv": {} } } } } },
    "/thing/{lthing}/atkvaedagreidslur.csv": { get: { summary: "Every vote summary of a session", parameters: [{ name: "lthing", in: "path", required: true, schema: { type: "integer" } }], responses: { 200: { description: "CSV", content: { "text/csv": {} } } } } },
    "/nyjast/atom": { get: { summary: "Newest 30 speeches", responses: { 200: { description: "Atom", content: { "application/atom+xml": {} } } } } },
    "/healthz": { get: { summary: "Health and ingest freshness", responses: { 200: { description: "ok", content: { "application/json": {} } } } } },
    "/llms.txt": { get: { summary: "Guide for language models", responses: { 200: { description: "Markdown", content: { "text/markdown": {} } } } } },
  };
  for (const [p, s] of [["/raeda/{speech_id}.md", "A speech"], ["/mal/{lthing}/{class}/{nr}.md", "A matter"], ["/thingmadur/{member_id}.md", "A member"], ["/log/{year}/{nr}.md", "A law"], ["/dagur/{date}.md", "A sitting day"]] as const) {
    const { _path: _, ...op } = md(s, p);
    const params = [...p.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
    paths[p] = { get: { ...op.get, parameters: params } };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Alþingi · leit", version, description: `Plain-HTTP read API of ${SITE}. For agents the MCP server at ${MCP_URL} is richer (votes per member, laws, sittings). ${RATE}`, license: { name: "Data: Alþingi; see /um", url: `${SITE}/um` } },
    servers: [{ url: SITE }],
    paths,
  };
}

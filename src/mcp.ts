// MCP server (Streamable HTTP, stateless, no auth: one McpServer + transport per POST). Read-only tools over the corpus,
// plus https resource templates for the Markdown version of every entity page. Design notes: docs/AGENTS.md.
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import type { Context } from "hono";
import { z } from "zod";
import type { Sql } from "./db.ts";
import * as T from "./mcp-tools.ts";
import { canonicalPath, renderMd } from "./md-routes.ts";
import { searchEntities } from "./entities.ts";
import { SITE } from "./pages.tsx";
import { llmsTxt } from "./agent-docs.ts";

export const VERSION = "0.2.0";
// every tool only reads a closed corpus: no side effects, same answer for the same arguments, no outside world
const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const cls = z.enum(["A", "B", "a", "b"]).describe("A = þingmál (bills, resolutions, questions); B = other business (debates, points of order). Default A");

/** MCP-returned Markdown stays under ~60k chars (Claude Code caps tool output at 25k tokens); the .md URL has it all. */
const MD_CAP = 60_000;
const capMd = (md: string, url: string) => md.length <= MD_CAP ? md
  : `${md.slice(0, MD_CAP)}\n\n[truncated: ${md.length} characters in all. Full text at ${url}.md; for a law, get_law(year, nr, article=N) returns one article.]\n`;

/** Tool result: JSON text (for clients without structured output) + structuredContent. `{error}` payloads become isError. */
const out = (data: unknown) => {
  const d = data as Record<string, unknown>;
  if (d && typeof d.error === "string") {
    return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(d) }] };
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: d };
};

// ---- output schemas: the stable top-level shape (nested objects keep their documented keys; extra keys are allowed)
const corpus = z.object({ text_from: z.string(), speeches_with_text: z.number(), sessions_with_text: z.array(z.number()), text_dates: z.object({ from: z.string().nullable(), to: z.string().nullable() }), note: z.string() })
  .describe("What the text corpus covers. 'Never'/'first'/totals only hold within it.");
const member = z.object({ id: z.number().nullable(), name: z.string().nullable(), party_at_date: z.string().nullable().optional() });
const matterRef = z.object({ lthing: z.number(), class: z.string(), nr: z.number(), title: z.string().nullable().optional() });
const url = z.string().describe("Citable page on althingi.solberg.is (append .md for Markdown)");

const SEARCH_OUT = {
  corpus, query: z.object({ text: z.string(), interpreted_as: z.string() }),
  total: z.union([z.number(), z.string()]).optional().describe("Speeches matching over all pages; '10000+' when capped"),
  hits: z.array(z.object({
    speech_id: z.string(), date: z.string(), started: z.string(), member, speech_type: z.string(), matter: matterRef.nullable(),
    paragraphs: z.array(z.object({ mgr: z.number(), text: z.string(), url })), url, althingi_url: z.string().nullable(),
  })),
  matter_cards: z.array(matterRef), next_cursor: z.string().nullable(), why: z.array(z.string()).optional(), derived: z.boolean(),
};

const INSTRUCTIONS = [
  "Search and fetch Icelandic parliament (Alþingi) speeches, matters (þingmál), votes with per-member ballots, members, laws and sittings. Speech TEXT exists from 2005 only; every response has a `corpus` block stating what is covered — never claim something 'never' happened without checking it.",
  "Queries are lemmatized Icelandic keywords: an inflected word finds all its forms; all words must occur in the same paragraph; \"quoted\" = exact adjacent phrase. Translate the user's topic into Icelandic content words; put people, parties, dates and matters into filters (resolve names with get_member). explain_query shows how a query was read.",
  "Ids chain: search_speeches -> speech_id -> get_speech / get_context; matter {lthing,class,nr} -> get_matter -> votes[].id -> get_vote; member.id -> get_member / member_votes; law {year,nr} -> get_law; sitting {lthing,fundur} -> get_sitting. Every item has a `url` to cite (append .md for Markdown; resources use the same https URLs). Party is always 'party_at_date' (seat on that day).",
  "Fields marked inferred are not source facts. Interjections (framíköll) are shown but not searchable. Rate limit: 60 requests a minute per client (HTTP 429 + Retry-After).",
].join(" ");

export function buildServer(sql: Sql, currentLthing: number): McpServer {
  const ctx = { sql, currentLthing };
  const s = new McpServer(
    { name: "althingi-search", title: "Alþingi — ræður, mál, atkvæði", version: VERSION, websiteUrl: SITE },
    { instructions: INSTRUCTIONS, capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  s.registerTool("search_speeches", {
    title: "Search speeches",
    description: "Lemma-aware full-text search over speech paragraphs (text from 2005). Returns speeches with the best paragraph snippets, party at the speech date, matter, citable urls (paragraph anchors #mgr-N) and `total`. Zero hits return a structured `why`. `q` is Icelandic KEYWORDS, not a question: e.g. user asks 'what did MPs say about fishing fees in 2023' -> q='veiðigjald', date_from='2023-01-01', date_to='2023-12-31'. Resolve people with get_member and pass member_id. Page with next_cursor.",
    inputSchema: {
      q: z.string().min(1).max(200).describe("Icelandic keywords (any inflection), \"quoted phrase\" for exact wording. Example: 'veiðigjald', '\"virðulegi forseti\"'. Not for law/matter numbers: use get_matter / get_law."),
      member_id: z.number().int().optional().describe("Only this speaker (id from get_member)"),
      party_id: z.number().int().optional().describe("Party id; resolved through seats ON the speech date"),
      date_from: iso.optional(), date_to: iso.optional(), lthing: z.number().int().optional().describe("Session (löggjafarþing) number, e.g. 157"),
      speech_type: z.string().optional().describe("ræða, andsvar, flutningsræða, svar, um atkvæðagreiðslu, grein fyrir atkvæði, um fundarstjórn"),
      office: z.string().optional().describe("Minister portfolio abbreviation prefix, e.g. 'fjmrh.'"),
      debate: z.array(z.enum(["1", "2", "3", "*", "S", "E", "F", "T"])).optional().describe("Debate stage: 1/2/3 = readings"),
      capacity: z.string().optional().describe("Decoded speaker capacity, e.g. 'ráðherra', 'forseti'"),
      matter: z.string().regex(/^[abAB]\/\d{1,5}$/).optional().describe("Restrict to one matter of the given lthing: 'a/300' (use with lthing)"),
      sort: z.enum(["relevance", "newest", "oldest"]).optional(), limit: z.number().int().min(1).max(100).optional().describe("Default 10; above 25 results are compacted"),
      cursor: z.string().optional().describe("next_cursor from the previous page"),
    },
    outputSchema: SEARCH_OUT, annotations: ro,
  }, async (a) => out(await T.searchSpeeches(ctx, a)));

  s.registerTool("get_speech", {
    title: "Get a speech",
    description: "Full text of one speech (paragraphs numbered as in the url anchors #mgr-N), speaker, party at date, matter, reply_to / replies (andsvar chains), audio/video links, a ready cite string and the source revision hash. Long speeches are paged: pass from=next_from.",
    inputSchema: { speech_id: z.string().regex(/^rad\d{8}T\d{6}$/).describe("e.g. rad20180306T163325"), from: z.number().int().min(1).optional(), to: z.number().int().min(1).optional() },
    outputSchema: {
      corpus, speech: z.object({ id: z.string(), url, citation: z.string(), member, matter: matterRef.nullable(), reply_to: z.object({ speech_id: z.string(), inferred: z.boolean() }).nullable(), provisional: z.boolean() }),
      paragraphs: z.array(z.object({ mgr: z.number(), text: z.string(), interjections: z.array(z.string()) })), paragraphs_total: z.number(), next_from: z.number().nullable(),
    },
    annotations: ro,
  }, async (a) => out(await T.getSpeech(ctx, a)));

  s.registerTool("get_context", {
    title: "Get a paragraph with context",
    description: "A paragraph and its neighbours (window 0-5) with a precise citation: the evidence package for a quote. Use the mgr from a search hit.",
    inputSchema: { speech_id: z.string().regex(/^rad\d{8}T\d{6}$/), mgr: z.number().int().min(1).describe("Paragraph number (1-based)"), window: z.number().int().min(0).max(5).optional() },
    outputSchema: { corpus, speech_id: z.string(), url, citation: z.string(), member, paragraphs: z.array(z.object({ mgr: z.number(), text: z.string(), is_target: z.boolean() })) },
    annotations: ro,
  }, async (a) => out(await T.getContext(ctx, a)));

  s.registerTool("get_matter", {
    title: "Get a matter (þingmál)",
    description: "One bill/resolution/question: status, sponsors (flutningsmenn), committee rapporteurs, topics, laws it amends, related matters, documents (þingskjöl), vote summaries (ids for get_vote), sitting events (debate closed, passed as law), consultation counts and an index of its speeches. B-mál have no documents or votes. Example: 300. mál á 157. þingi -> lthing=157, nr=300.",
    inputSchema: { lthing: z.number().int().describe("Session number, e.g. 157"), class: cls.optional(), nr: z.number().int().describe("Matter number within the session") },
    outputSchema: {
      corpus, matter: z.object({ lthing: z.number(), class: z.string(), nr: z.number(), title: z.string(), status: z.string().nullable(), url, althingi_url: z.string() }),
      sponsors: z.array(z.object({ order: z.number(), member: z.object({ id: z.number(), name: z.string().nullable() }).nullable(), office: z.string().nullable() })),
      votes: z.array(z.object({ id: z.number(), at: z.string().nullable(), about: z.string(), result: z.string().nullable(), yes: z.number().nullable(), no: z.number().nullable(), abstain: z.number().nullable() })),
      documents: z.array(z.object({ nr: z.number(), type: z.string() })), speeches: z.object({ total: z.number(), index: z.array(z.object({ id: z.string() })) }),
    },
    annotations: ro,
  }, async (a) => out(await T.getMatter(ctx, a)));

  s.registerTool("get_member", {
    title: "Get a member of parliament",
    description: "Seat history with party, constituency and dates ('með varamann' = on leave, not sitting) and recent speeches. Look up by member_id or by name (fuzzy; several matches return `candidates` to choose from).",
    inputSchema: { member_id: z.number().int().optional(), name: z.string().min(3).optional().describe("Full or partial name, Icelandic letters, e.g. 'Þórunn Sveinbjarnardóttir'") },
    outputSchema: {
      member: z.object({ id: z.number(), name: z.string(), url, althingi_url: z.string(), speeches_in_corpus: z.number() }).optional(),
      seats: z.array(z.object({ lthing: z.number(), kind: z.string(), party: z.string().nullable(), sitting: z.boolean() })).optional(),
      candidates: z.array(z.object({ id: z.number(), name: z.string() })).optional(),
    },
    annotations: ro,
  }, async (a) => out(await T.getMember(ctx, a)));

  s.registerTool("list_votes", {
    title: "List votes",
    description: "Vote summaries (counts, result, method) for a session, optionally one matter, one document or one day. For how each member voted use get_vote(vote_id); for one member's record use member_votes.",
    inputSchema: {
      lthing: z.number().int(), class: cls.optional(), nr: z.number().int().optional(), date: iso.optional(),
      doc_nr: z.number().int().optional().describe("Votes on one þingskjal (document number)"),
      after_id: z.number().int().optional().describe("Paging: pass next_after_id from the previous call"),
      limit: z.number().int().min(1).max(200).optional(),
    },
    outputSchema: { corpus, votes: z.array(z.object({ id: z.number(), at: z.string().nullable(), about: z.string(), result: z.string().nullable(), matter: matterRef })), next_after_id: z.number().nullable() },
    annotations: ro,
  }, async (a) => out(await T.listVotes(ctx, a)));

  s.registerTool("get_vote", {
    title: "Get a vote with every member's ballot",
    description: "One vote (atkvæðagreiðsla): result, counts, the matter and document, and each member's ballot with party on the vote date, plus a per-party tally. Choices are verbatim Icelandic with an English gloss: já (yes), nei (no), greiðir ekki atkvæði (abstains), boðaði fjarvist (reported absence), fjarverandi (absent).",
    inputSchema: { vote_id: z.number().int().describe("From get_matter.votes[].id, list_votes or member_votes") },
    outputSchema: {
      vote: z.object({ id: z.number(), at: z.string().nullable(), about: z.string(), result: z.string().nullable(), matter: matterRef, url, althingi_url: z.string() }),
      ballots: z.array(z.object({ member: z.object({ id: z.number(), name: z.string().nullable(), party_at_date: z.string().nullable() }), choice: z.string(), choice_en: z.string().nullable() })),
      by_party: z.array(z.object({ party: z.string(), counts: z.record(z.string(), z.number()) })), ballots_total: z.number(),
    },
    annotations: ro,
  }, async (a) => out(await T.getVote(ctx, a)));

  s.registerTool("member_votes", {
    title: "How a member voted",
    description: "One member's ballots, newest first, with a tally by choice. Filter by session, by matter (lthing+class+nr) or by choice ('nei' to find dissent). Page with before_id=next_before_id.",
    inputSchema: {
      member_id: z.number().int().describe("From get_member"), lthing: z.number().int().optional(), class: cls.optional(), nr: z.number().int().optional(),
      choice: z.enum(["já", "nei", "greiðir ekki atkvæði", "boðaði fjarvist", "fjarverandi"]).optional(),
      before_id: z.number().int().optional(), limit: z.number().int().min(1).max(200).optional(),
    },
    outputSchema: {
      member: z.object({ id: z.number(), name: z.string(), url }), tally: z.array(z.object({ choice: z.string(), n: z.number() })),
      votes: z.array(z.object({ vote_id: z.number(), at: z.string().nullable(), about: z.string(), choice: z.string(), matter: matterRef })), next_before_id: z.number().nullable(),
    },
    annotations: ro,
  }, async (a) => out(await T.memberVotes(ctx, a)));

  s.registerTool("get_law", {
    title: "Get a law (lög) from the law collection",
    description: "A law in the consolidated law collection (lagasafn): title, chapter, in-force note, article index, which acts amended it, which matters in parliament amend it, and article text on request. 'lög nr. 34/1991' -> year=1991, nr=34. Or pass a title to find it.",
    inputSchema: {
      year: z.number().int().min(1800).max(2100).optional(), nr: z.number().int().optional(), title: z.string().min(3).optional().describe("Words of the title, e.g. 'fjárfestingu erlendra aðila'"),
      article: z.string().optional().describe("Article number, e.g. '3' or '3. gr.'; returns its text"), include_text: z.boolean().optional().describe("Return article text (about 20 KB; articles_truncated says if more)"),
    },
    outputSchema: {
      law: z.object({ year: z.number(), nr: z.number(), id: z.string(), title: z.string().nullable(), in_force: z.string().nullable(), url, althingi_url: z.string() }).optional(),
      articles_index: z.array(z.object({ article: z.string(), heading: z.string().nullable() })).optional(),
      articles: z.array(z.object({ article: z.string(), heading: z.string().nullable(), text: z.string() })).optional(),
      candidates: z.array(z.object({ year: z.number(), nr: z.number(), title: z.string() })).optional(),
    },
    annotations: ro,
  }, async (a) => out(await T.getLaw(ctx, a)));

  s.registerTool("get_sitting", {
    title: "Get a sitting (þingfundur) and its agenda",
    description: "One plenary sitting: start/end, the agenda (dagskrá) with matters, events (debate closed, bill passed as law, postponed) and the speeches in order. Find by lthing+fundur, or by date.",
    inputSchema: { lthing: z.number().int().optional(), fundur: z.number().int().optional().describe("Sitting number in the session"), date: iso.optional() },
    outputSchema: {
      sitting: z.object({ lthing: z.number(), fundur: z.number(), starts: z.string().nullable(), ends: z.string().nullable() }).optional(),
      agenda: z.array(z.object({ seq: z.number(), title: z.string().nullable() })).optional(),
      events: z.array(z.object({ at: z.string(), kind: z.string() })).optional(),
      speeches: z.array(z.object({ id: z.string(), started: z.string(), url })).optional(),
      candidates: z.array(z.object({ lthing: z.number(), fundur: z.number() })).optional(),
    },
    annotations: ro,
  }, async (a) => out(await T.getSitting(ctx, a)));

  s.registerTool("list_sittings", {
    title: "List sittings of a session",
    description: "Sittings (þingfundir) of one session, newest first, with agenda and speech counts.",
    inputSchema: { lthing: z.number().int(), date_from: iso.optional(), date_to: iso.optional(), limit: z.number().int().min(1).max(200).optional() },
    outputSchema: { lthing: z.number(), sittings: z.array(z.object({ fundur: z.number(), starts: z.string().nullable(), items: z.number(), speeches: z.number() })) },
    annotations: ro,
  }, async (a) => out(await T.listSittings(ctx, a)));

  s.registerTool("aggregate", {
    title: "Count speeches or words",
    description: "Group counts: by year, member, party (on the speech date), speech type or session; optionally only speeches matching a query. Counts speeches (with at least one matching paragraph) or words. Top 50 buckets.",
    inputSchema: {
      metric: z.enum(["speeches", "words"]), group_by: z.enum(["year", "member", "party", "speech_type", "lthing"]),
      q: z.string().max(200).optional(), date_from: iso.optional(), date_to: iso.optional(), lthing: z.number().int().optional(),
      speech_type: z.string().optional(), member_id: z.number().int().optional(), substantive_only: z.boolean().optional().describe("Skip points of order and the presiding officer"),
    },
    outputSchema: { corpus, metric: z.string(), group_by: z.string(), buckets: z.array(z.object({ key: z.string(), value: z.number() })), caveats: z.array(z.string()) },
    annotations: ro,
  }, async (a) => out(await T.aggregate(ctx, a)));

  s.registerTool("first_use", {
    title: "First use of a word or phrase",
    description: "Earliest paragraphs matching a query plus a speeches-per-year strip. 'First' means first in the text corpus (from 2005), see `corpus`.",
    inputSchema: { q: z.string().min(1).max(200), limit: z.number().int().min(1).max(20).optional() },
    outputSchema: { corpus, earliest: z.array(z.object({ speech_id: z.string(), mgr: z.number(), started: z.string(), text: z.string(), url })), speeches_per_year: z.array(z.object({ year: z.number(), speeches: z.number() })), caveat: z.string() },
    annotations: ro,
  }, async (a) => out(await T.firstUse(ctx, a)));

  s.registerTool("explain_query", {
    title: "Explain how a query is interpreted",
    description: "Shows the lemma groups, phrase chains, dropped stopwords and numbers behind a query, so you can verify what a search actually matched.",
    inputSchema: { q: z.string().min(1).max(200) },
    outputSchema: { query: z.string(), interpreted_as: z.string(), dropped_stopwords: z.array(z.string()), notes: z.array(z.string()) },
    annotations: ro,
  }, async (a) => out(await T.explainQuery(ctx, a)));

  s.registerTool("list_sessions", {
    title: "List sessions and what text is available",
    description: "Sessions (löggjafarþing) with their dates and how many speeches have text, are pending, or are index-only (pre-2005). Call this first to learn the corpus boundary.",
    inputSchema: {},
    outputSchema: { corpus, sessions: z.array(z.object({ lthing: z.number(), starts: z.string().nullable(), ends: z.string().nullable(), speeches_with_text: z.number(), text_complete: z.boolean() })) },
    annotations: ro,
  }, async () => out(await T.listSessions(ctx)));

  // ---- the generic pair ChatGPT (deep research, company knowledge) and other connectors look for
  s.registerTool("search", {
    title: "Search (generic)",
    description: "Generic search for connectors that expect search/fetch: speeches (lemma-aware Icelandic keywords) plus members, matters and laws whose names match. Returns ids to pass to `fetch`. Prefer search_speeches for filters.",
    inputSchema: { query: z.string().min(1).max(200).describe("Icelandic keywords, a name, or '300. mál'") },
    outputSchema: { results: z.array(z.object({ id: z.string(), title: z.string(), url: z.string() })) },
    annotations: ro,
  }, async ({ query }) => {
    const [sp, ent] = await Promise.all([T.searchSpeeches(ctx, { q: query, limit: 10 }), searchEntities(sql, query, currentLthing, 3)]);
    const results = [
      ...[...ent.thingmenn, ...ent.mal, ...ent.log, ...ent.flokkar].map((e) => ({ id: canonicalPath(e.href), title: e.title, url: `${SITE}${e.href}` })),
      ...sp.hits.map((h) => ({ id: `/raeda/${h.speech_id}`, title: `${h.member.name ?? ""}, ${h.speech_type} ${h.date}${h.matter?.title ? ` – ${h.matter.title}` : ""}: ${h.paragraphs[0]?.text.slice(0, 160) ?? ""}`, url: h.url })),
    ];
    const data = { results };
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data };
  });

  s.registerTool("fetch", {
    title: "Fetch a document (generic)",
    description: "Full Markdown of one page by id from `search` (or any althingi.solberg.is URL/path): a speech (/raeda/<id>), matter (/mal/<lthing>/a/<nr>), member (/thingmadur/<id>), law (/log/<year>/<nr>), day (/dagur/YYYY-MM-DD), party or document.",
    inputSchema: { id: z.string().min(2).max(300).describe("e.g. /raeda/rad20180306T163325, /mal/157/a/300, https://althingi.solberg.is/log/1991/34") },
    outputSchema: { id: z.string(), title: z.string(), text: z.string(), url: z.string(), metadata: z.record(z.string(), z.string()).nullable(), truncated: z.boolean().optional() },
    annotations: ro,
  }, async ({ id }) => {
    const d = await renderMd(sql, id, currentLthing);
    if (!d) return out({ error: "not_found", hint: "Use an id from `search`, or a path like /raeda/rad20180306T163325, /mal/157/a/300, /thingmadur/633, /log/1991/34." });
    const text = capMd(d.markdown, `${SITE}${d.path}`);
    const data = { id: d.path, title: d.title, text, url: `${SITE}${d.path}`, metadata: d.althingi_url ? { althingi_url: d.althingi_url, format: "text/markdown" } : { format: "text/markdown" }, ...(text !== d.markdown ? { truncated: true } : {}) };
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data };
  });

  // ---- resources: the Markdown page behind every citable https URL, as templates (the corpus is too big to list)
  const md = (name: string, title: string, tpl: string, description: string) =>
    s.registerResource(name, new ResourceTemplate(`${SITE}${tpl}.md`, { list: undefined }), { title, description, mimeType: "text/markdown" }, async (uri) => {
      const d = await renderMd(sql, uri.href, currentLthing);
      if (!d) throw new Error(`Not found: ${uri.href}`);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: capMd(d.markdown, `${SITE}${d.path}`) }] };
    });
  md("speech", "Ræða (speech)", "/raeda/{speech_id}", "Full text of a speech with numbered paragraphs (#mgr-N) and a citation.");
  md("matter", "Þingmál (matter)", "/mal/{lthing}/{class}/{nr}", "A matter: status, sponsors, documents, votes, speeches. class is a or b.");
  md("member", "Þingmaður (member)", "/thingmadur/{member_id}", "A member's seats and recent speeches.");
  md("law", "Lög (law)", "/log/{year}/{nr}", "A law from the law collection with its text and amendment history.");
  md("day", "Þingdagur (sitting day)", "/dagur/{date}", "All speeches of one day, grouped by matter. date is YYYY-MM-DD.");
  s.registerResource("guide", `${SITE}/llms.txt`, { title: "How to use this server (llms.txt)", description: "Corpus boundary, URL scheme, tools, attribution.", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: await llmsTxt(sql) }] }));

  // ---- prompts: two research recipes users can pick from a menu
  s.registerPrompt("debate_on_topic", {
    title: "How was a topic debated?",
    description: "Find what was said about a topic, by whom and when, with citations.",
    argsSchema: { topic: z.string().describe("Topic in any language"), period: z.string().optional().describe("e.g. 2023, or 157. þing") },
  }, ({ topic, period }) => ({
    messages: [{ role: "user", content: { type: "text", text:
      `Using the Alþingi tools: translate "${topic}" into 1–3 Icelandic keyword queries (check them with explain_query), run search_speeches${period ? ` limited to ${period}` : ""}, use aggregate(group_by=party) for the balance, open the most relevant speeches with get_context, and answer with quotes cited by their url (#mgr-N). State the corpus boundary from the corpus block.` } }],
  }));
  s.registerPrompt("member_record", {
    title: "A member's record",
    description: "Seats, main topics, and voting record of one member.",
    argsSchema: { name: z.string().describe("Member's name") },
  }, ({ name }) => ({
    messages: [{ role: "user", content: { type: "text", text:
      `Using the Alþingi tools: resolve "${name}" with get_member, summarise their seats, use aggregate(group_by=year, member_id) for activity, member_votes for their voting record (note 'nei' votes against their party with get_vote), and list matters they sponsored if any. Cite every claim with a url.` } }],
  }));

  return s;
}

/** Stateless Streamable HTTP handler for Hono (POST only; GET/DELETE/OPTIONS are answered in web.tsx). */
export async function handleMcp(c: Context, sql: Sql, currentLthing: number): Promise<Response> {
  const server = buildServer(sql, currentLthing);
  // plain JSON responses: no notifications or progress are ever sent, so an SSE stream buys nothing
  const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const res = await transport.handleRequest(c);
  return res ?? c.body(null, 202);
}

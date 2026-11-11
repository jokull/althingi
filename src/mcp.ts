// MCP server (Streamable HTTP, stateless: one McpServer + transport per request). Read-only tools over the corpus.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import type { Context } from "hono";
import { z } from "zod";
import type { Sql } from "./db.ts";
import * as T from "./mcp-tools.ts";

const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const out = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data as Record<string, unknown> });
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

const INSTRUCTIONS = [
  "Search and fetch Icelandic parliament (Alþingi) speeches, matters, votes and members. Speech TEXT exists from 2005 only; every response has a `corpus` block stating what is covered — never claim something 'never' happened without checking it.",
  "Queries are lemmatized: an inflected word finds all its forms; all words must occur in the same paragraph; \"quoted\" = exact adjacent phrase; a number must be near a query word. Use explain_query to see how a query was read.",
  "Ids chain: search_speeches -> speech_id -> get_speech / get_context; matter {lthing,class,nr} -> get_matter; member.id -> get_member. Every item has a url you can cite. Party is always 'party_at_date' (seat on that day).",
  "Fields marked inferred/derived are not source facts. Interjections (framíköll) are shown but not searchable.",
].join(" ");

export function buildServer(sql: Sql, currentLthing: number): McpServer {
  const ctx = { sql, currentLthing };
  const s = new McpServer({ name: "althingi-search", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  s.registerTool("search_speeches", {
    title: "Search speeches",
    description: "Lemma-aware full-text search over speech paragraphs (text from 2005). Returns hits grouped by speech with the best paragraph snippets, party at the speech date, matter, cite-able urls, and `total` (matching speeches over all pages, exact up to 10000). Zero hits return a structured `why`. `q` is KEYWORDS, not a question: put content words in Icelandic (any inflection; all forms match) and move people, parties, dates, matters and speech types into the structured filters (resolve names with get_member first). Quote exact phrases.",
    inputSchema: {
      q: z.string().min(1).max(200).describe("Query: words (any inflection), \"quoted phrase\", numbers near words. Not a law/matter number lookup — use get_matter for that."),
      member_id: z.number().int().optional(), party_id: z.number().int().optional().describe("Party id; resolved through seats ON the speech date"),
      date_from: iso.optional(), date_to: iso.optional(), lthing: z.number().int().optional(),
      speech_type: z.string().optional().describe("ræða, andsvar, flutningsræða, svar, um atkvæðagreiðslu, grein fyrir atkvæði, um fundarstjórn"),
      office: z.string().optional().describe("Minister portfolio abbreviation prefix, e.g. 'fjmrh.'"),
      debate: z.array(z.enum(["1", "2", "3", "*", "S", "E", "F", "T"])).optional(),
      capacity: z.string().optional().describe("Decoded speaker capacity, e.g. 'ráðherra', 'forseti'"),
      matter: z.string().regex(/^[abAB]\/\d{1,5}$/).optional().describe("Restrict to one matter of the given lthing: 'a/300' (use with lthing)"),
      sort: z.enum(["relevance", "newest", "oldest"]).optional(), limit: z.number().int().min(1).max(100).optional().describe("Default 10; above 25 results are compacted"),
      cursor: z.string().optional(),
    },
    annotations: ro,
  }, async (a) => out(await T.searchSpeeches(ctx, a)));

  s.registerTool("get_speech", {
    title: "Get a speech",
    description: "Full text of one speech (paragraphs numbered as in the url anchors #mgr-N), speaker, party at date, matter, audio/video links, a ready cite string, and the source file revision hash. Large speeches are paged with next_from.",
    inputSchema: { speech_id: z.string().regex(/^rad\d{8}T\d{6}$/), from: z.number().int().min(1).optional(), to: z.number().int().min(1).optional() },
    annotations: ro,
  }, async (a) => out(await T.getSpeech(ctx, a)));

  s.registerTool("get_context", {
    title: "Get a paragraph with context",
    description: "A paragraph and its neighbours (window 0-5) with a precise citation: the evidence package for a quote.",
    inputSchema: { speech_id: z.string().regex(/^rad\d{8}T\d{6}$/), mgr: z.number().int().min(1), window: z.number().int().min(0).max(5).optional() },
    annotations: ro,
  }, async (a) => out(await T.getContext(ctx, a)));

  s.registerTool("get_matter", {
    title: "Get a matter (þingmál)",
    description: "Status, topics, laws it amends, related matters, documents (ids + althingi.is links), vote summaries with counts, consultation counts, and an index of the speeches on it. B-mál (class B) have no documents or votes.",
    inputSchema: { lthing: z.number().int(), class: z.enum(["A", "B", "a", "b"]).optional(), nr: z.number().int() },
    annotations: ro,
  }, async (a) => out(await T.getMatter(ctx, a)));

  s.registerTool("get_member", {
    title: "Get a member of parliament",
    description: "Seat history with party, constituency and dates ('með varamann' = on leave, not sitting), and recent speeches. Look up by member_id or by name.",
    inputSchema: { member_id: z.number().int().optional(), name: z.string().min(3).optional() },
    annotations: ro,
  }, async (a) => out(await T.getMember(ctx, a)));

  s.registerTool("list_votes", {
    title: "List votes",
    description: "Vote summaries (counts, result, method) for a session, optionally one matter or one day. Per-member ballots are not in the corpus yet.",
    inputSchema: {
      lthing: z.number().int(), class: z.enum(["A", "B", "a", "b"]).optional(), nr: z.number().int().optional(), date: iso.optional(),
      doc_nr: z.number().int().optional().describe("Votes on one þingskjal (document number)"),
      after_id: z.number().int().optional().describe("Paging: pass next_after_id from the previous call"),
      limit: z.number().int().min(1).max(200).optional(),
    },
    annotations: ro,
  }, async (a) => out(await T.listVotes(ctx, a)));

  s.registerTool("aggregate", {
    title: "Count speeches or words",
    description: "Group counts: by year, member, party (on the speech date), speech type or session; optionally only speeches matching a query. Counts speeches (with at least one matching paragraph) or words.",
    inputSchema: {
      metric: z.enum(["speeches", "words"]), group_by: z.enum(["year", "member", "party", "speech_type", "lthing"]),
      q: z.string().max(200).optional(), date_from: iso.optional(), date_to: iso.optional(), lthing: z.number().int().optional(),
      speech_type: z.string().optional(), member_id: z.number().int().optional(), substantive_only: z.boolean().optional(),
    },
    annotations: ro,
  }, async (a) => out(await T.aggregate(ctx, a)));

  s.registerTool("first_use", {
    title: "First use of a word or phrase",
    description: "Earliest paragraphs matching a query in the corpus plus a speeches-per-year strip. 'First' means first in the text corpus (from 2005), see `corpus`.",
    inputSchema: { q: z.string().min(1).max(200), limit: z.number().int().min(1).max(20).optional() },
    annotations: ro,
  }, async (a) => out(await T.firstUse(ctx, a)));

  s.registerTool("explain_query", {
    title: "Explain how a query is interpreted",
    description: "Shows the lemma groups, phrase chains, dropped stopwords and numbers behind a query, so you can verify what a search actually matched.",
    inputSchema: { q: z.string().min(1).max(200) }, annotations: ro,
  }, async (a) => out(await T.explainQuery(ctx, a)));

  s.registerTool("list_sessions", {
    title: "List sessions and what text is available",
    description: "Sessions with their dates and how many speeches have text, are pending, or are index-only (pre-2005).",
    inputSchema: {}, annotations: ro,
  }, async () => out(await T.listSessions(ctx)));

  return s;
}

/** Stateless Streamable HTTP handler for Hono. */
export async function handleMcp(c: Context, sql: Sql, currentLthing: number): Promise<Response> {
  const server = buildServer(sql, currentLthing);
  // plain JSON responses: no notifications or progress are ever sent, so an SSE stream buys nothing
  const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const res = await transport.handleRequest(c);
  return res ?? c.body(null, 204);
}

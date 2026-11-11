# Agent-friendly site and MCP: research and decisions (2026-11-11)

This is the design record for althingi.solberg.is as a public, no-auth MCP server and agent-readable website. It is not an
instruction file for coding agents. Sources were read on 2026-11-11. Each finding is tagged:

- **adopted**: in a published spec, or shipped and documented by the vendor;
- **proposal**: a draft, SEP or convention without a standard;
- **unverified**: not confirmed against a primary source.

Code: `src/mcp.ts` (server, schemas, resources, prompts), `src/mcp-tools.ts` (tool bodies), `src/md-routes.ts` +
`src/markdown.ts` (Markdown twins), `src/agent-docs.ts` (llms.txt, connect text, server card, OpenAPI),
`src/agent-pages.tsx` (/mcp page, front-page section), `src/ratelimit.ts`. Tests: `test/agents.test.ts`.

## 1. Protocol and transport

| Finding | Status | Source |
|---|---|---|
| The current spec is **2026-07-28**. It is stateless: no `initialize`, no `Mcp-Session-Id`, `server/discover`, a `_meta` protocol version, `Mcp-Method`/`Mcp-Name` headers, and `resultType`/`ttlMs`/`cacheScope` on results. Only the TS SDK v2 (`@modelcontextprotocol/server` ≥ 2.0) implements it, and only on opt-in. | adopted | https://modelcontextprotocol.io/specification/2026-07-28/changelog, https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.md |
| Our SDK (1.32.2) speaks **2025-11-25** (also 06-18, 03-26, 2024-11-05). Claude's and OpenAI's connector docs still cite 2025-era specs. | adopted | `node_modules/@modelcontextprotocol/sdk/dist/esm/types.js`; https://platform.claude.com/docs/en/agents-and-tools/mcp-connector |
| Under 2025-11-25 Streamable HTTP, a POST may be answered with `application/json` or SSE (clients MUST accept both). A server MAY omit sessions. GET MUST return SSE or **405**. DELETE MAY be 405. A missing `MCP-Protocol-Version` means 2025-03-26. | adopted | https://modelcontextprotocol.io/specification/2025-11-25/basic/transports |
| Servers MUST validate `Origin` and return 403 if it is invalid. The spec leaves "valid" undefined; the threat is DNS rebinding against local servers. | adopted | same |
| HTTP+SSE (the 2024 transport) has been deprecated since 2025-03-26. Clients fall back to it on their own. | adopted | same; https://code.claude.com/docs/en/mcp |
| Authorization is OPTIONAL. OAuth discovery starts from a **401**. Claude Code treats 401 and 403 as "needs auth". OpenAI says to return **404** on the OAuth well-known routes so ChatGPT does not surface 502s. | adopted | https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization, https://developers.openai.com/apps-sdk/quickstart |
| The spec has no CORS section. The SDK examples use `origin: *` and expose `Mcp-Session-Id`, `Mcp-Protocol-Version`, `Last-Event-Id`, `WWW-Authenticate`. | adopted (absence) | SDK `examples/legacy-routing/server.ts` |
| Servers MUST rate limit tool invocations. HTTP 429 and `Retry-After` are not specified. JSON-RPC codes -32000 to -32019 are implementation-defined. | adopted | https://modelcontextprotocol.io/specification/2026-07-28/server/tools |

**Decisions**

- **Version and sessions:** 2025-11-25, stateless, `enableJsonResponse: true`. We send no notifications or progress, so SSE adds nothing, and plain JSON works with curl and is safe behind the tunnel. Move to the v2 SDK later: its `createMcpHandler` with `legacy: 'stateless'` serves both protocol generations from one factory.
- **HTTP methods on `/mcp`:**
  - POST only.
  - `GET` without `Accept: text/event-stream` (browsers, htmx, curl) returns the connect page. A GET asking for SSE, and DELETE, returns 405 with `Allow: POST, OPTIONS`. Before this change, the live GET hung, because the transport opened a standalone SSE stream.
- **No auth:**
  - Never 401, never `WWW-Authenticate`.
  - `/.well-known/oauth-protected-resource*` and `/.well-known/oauth-authorization-server` stay 404, and tests assert it.
  - We deliberately serve no protected-resource metadata.
- **Origin:** a public read-only server treats every origin as valid: web, `chrome-extension://`, webviews, IPv6 localhost. Only a malformed `Origin` (no `scheme://`) gets 403, and `null` is allowed. This is the only 403 `/mcp` can emit, and Claude Code reads 403 as "needs auth", so the check is deliberately loose.
- **CORS:**
  - Methods: `Allow-Origin: *`, methods GET/POST/OPTIONS.
  - Allowed headers: `Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, Mcp-Method, Mcp-Name, Authorization`.
  - Exposed headers: `Mcp-Session-Id, MCP-Protocol-Version, Retry-After`.
  - `max-age` is 86400.
  - The public read endpoints (`*.md`, `*.json`, `*.txt`, `*.xml`, `/mcp/server-card`, `/.well-known/*`) also send `Allow-Origin: *`.
- **Rate limit:** an in-process token bucket per `cf-connecting-ip`: 60 requests a minute, burst 60. When exceeded it returns HTTP 429 with an integer `Retry-After` and a JSON-RPC error `-32000` with `data.retry_after_seconds`. The Cloudflare rule (40 req / 10 s per IP on /leit* and /mcp*) remains the hard edge.
- **Health:** `/healthz` is unchanged. It is listed in OpenAPI.

## 2. Tool design

| Finding | Status | Source |
|---|---|---|
| Tool names: 1–128 characters of `A-Za-z0-9_-.`. Claude's directory review wants ≤ 64 characters, a `title` and the applicable hints. | adopted | https://modelcontextprotocol.io/specification/2026-07-28/server/tools, https://claude.com/docs/connectors/building/review-criteria.md |
| With an `outputSchema`, `structuredContent` MUST conform, and the server SHOULD also return the JSON as text. | adopted | tools spec |
| Annotation defaults: readOnly false, destructive true, idempotent false, openWorld true. ChatGPT treats any tool without `readOnlyHint` as a write and asks for confirmation. | adopted | tools spec; https://developers.openai.com/api/docs/guides/custom-mcp-server |
| Business errors go in the result with `isError: true` and actionable text. Protocol errors are JSON-RPC errors. | adopted | tools spec |
| ChatGPT deep research and company knowledge use a read-only `search({query})` → `{results:[{id,title,url}]}` and `fetch({id})` → `{id,title,text,url,metadata}`. Each result is structuredContent plus one text item holding the JSON. Citations appear only when `url` is non-empty. | adopted | https://developers.openai.com/api/docs/mcp |
| Size limits: claude.ai accepts about 150k characters and 240 s per call; Claude Code caps output at 25k tokens (`MAX_MCP_OUTPUT_TOKENS`). Claude.ai does not support resource subscriptions or sampling. The Anthropic Messages API MCP connector supports **tools only**. | adopted | https://claude.com/docs/connectors/building/index.md, https://platform.claude.com/docs/en/agents-and-tools/mcp-connector |
| Resources may use `https://` URIs when the client can fetch them. Templates follow RFC 6570. Pagination uses opaque cursors. | adopted | spec (server/resources) |
| ChatGPT: the first 512 characters of `instructions` should stand on their own. | adopted | custom-mcp-server guide |

**Decisions**

- **Annotations:** every tool is `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false`. They are closed-world because they read our own index, not the internet. Every tool has a `title` and an `outputSchema`; the schemas are shallow, give the stable top-level keys, and allow extra keys.
- **Errors:** `{error, hint}` payloads are returned with `isError: true`. The text is the JSON itself, so old clients can still parse it, and `hint` names the tool that gives a valid id.
- **Names:** all existing names are kept; no renames. New tools:
  - `get_vote`: per-member ballots with party on the vote date, verbatim choice plus an English gloss, and a per-party tally.
  - `member_votes`: one member's record, filterable by session, matter and choice, with a tally; paged by `before_id`.
  - `get_law`: lagasafn metadata, article index, `amended_by`/`amends`, the matters that amend it, and article text on request within a ~20 KB budget. Can also be looked up by title.
  - `get_sitting` / `list_sittings`: agenda, events with English glosses, speeches in order.
  - `search` / `fetch`: the ChatGPT pair. `fetch` returns the page's Markdown.
- **Added to existing tools:**
  - `get_matter` adds `sponsors` (flutningsmenn, with office), `rapporteurs` and `sitting_events`.
  - `get_speech` adds `reply_to` (with `inferred`) and `replies`.
  - The stale "ballots not in the corpus" text in `list_votes` is fixed.
- **Descriptions** are written for models. They give worked examples ("lög nr. 34/1991 → year=1991, nr=34"; a natural-language question → keyword `q` plus date filters), state the id chain, and name the next tool.
- **Resources:** templates at the same https URLs as the Markdown pages (`/raeda/{speech_id}.md`, `/mal/{lthing}/{class}/{nr}.md`, `/thingmadur/{member_id}.md`, `/log/{year}/{nr}.md`, `/dagur/{date}.md`), plus one static `llms.txt` guide resource. Templates are not enumerated, because the corpus is too large to list. https was chosen over a custom scheme because the URIs are then also citable and fetchable.
- **Prompts:** `debate_on_topic` and `member_record`. These are research recipes that chain the tools.
- **Not done:** icons, completions, `resource_link` items in tool results (the urls are already in the JSON).

## 3. Discovery

| Finding | Status | Source |
|---|---|---|
| Official MCP Registry: `server.json` with `$schema` `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`. Required: `name` (`^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$`), `description` (≤ 100), `version`. A remote server uses `remotes: [{type: "streamable-http", url}]`. | adopted | https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/CHANGELOG.md |
| Namespace verification by HTTP: `https://<domain>/.well-known/mcp-registry-auth` containing `v=MCPv1; k=ed25519; p=<pubkey>`, which grants `is.solberg.althingi/*` for althingi.solberg.is. DNS TXT at the apex grants `is.solberg/*`. The registry does not check the remote URL. | adopted | https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/authentication.mdx |
| **MCP Server Cards** (SEP-2127, Extensions Track, Final 2026-10-06): `GET <mcp url>/server-card` returns `application/mcp-server-card+json`, indexed from `/.well-known/ai-catalog.json`. `/.well-known/mcp/server-card` (SEP-1649) was explicitly rejected. Client adoption is unknown. | adopted (extension) | SEP-2127 in modelcontextprotocol/modelcontextprotocol |
| llms.txt: an H1, a blockquote, prose without headings, then H2 sections of `[name](url): notes`, with `## Optional` skippable. `llms-full.txt` is only a community convention. Whether major agents fetch either is unverified. | proposal | https://llmstxt.org/ |
| RFC 8631 link relations: `service-desc`, `service-doc`, `service-meta`, `status`. | adopted | https://www.rfc-editor.org/rfc/rfc8631 |

**Decisions**

- **`server.json`** is in the repo root, generated from `serverJson(VERSION)` in `src/agent-docs.ts`, and a test asserts the two match. Name: `is.solberg.althingi/althingi`, which needs HTTP verification on the subdomain. It is prepared, not published.
- **Server card and catalog:** `/mcp/server-card` and `/.well-known/ai-catalog.json` are served with CORS and a 1 h cache. No `/.well-known/mcp*` files, since that path was rejected.
- **Links in every HTML `<head>` and in a `Link` header:**
  - `rel="help"` → `/llms.txt`
  - `rel="service-doc"` → `/mcp`
  - `rel="service-meta"` → `/mcp/server-card`
  - `rel="service-desc"` → `/openapi.json`
  - `rel="alternate" type="text/markdown"` → the page's `.md` twin (a convention, not a standard)
- **llms.txt** follows the llmstxt.org format exactly, in this order:
  1. MCP endpoint and one-line connect per client;
  2. corpus boundary, computed from the DB;
  3. query rules;
  4. Markdown/citation scheme;
  5. rate limits;
  6. attribution;
  7. H2 link lists: MCP, URL scheme, Data, Optional.
- **llms-full.txt** is served as llms.txt plus every tool description, the resource templates and the glossary. Reason: the convention is "the docs expanded", and our docs are a few KB. A corpus dump would be hundreds of MB, competes with the MCP, and DECISIONS.md already rejects it.
- **robots.txt:**
  - `*` gets `Allow: /`, `Allow: /leit.json`, `Disallow: /leit`. HTML search is an infinite URL space and stays out of indexes; the JSON search is fine.
  - The user-triggered agents (`ChatGPT-User`, `Claude-User`, `Perplexity-User`) get `Allow: /`, because they fetch on a person's behalf.
  - `Disallow: /mcp` is dropped: robots does not govern MCP clients, and the rule only hid the connect page.
  - `Content-Signal: search=yes, ai-input=yes`. `ai-train` is deliberately left unstated: the owner chose to stay neutral (2026-11-11), so neither yes nor no is signalled. Cloudflare's managed default is `ai-train=no`.
- **Sitemaps:** `/sitemap.xml` was referenced but returned 404 on the live site. It is now an index over:
  - `static`;
  - `members`;
  - `laws`;
  - one sitemap per session with text (matters plus speeches, with `lastmod`).

## 4. Content for agents

| Finding | Status | Source |
|---|---|---|
| Cloudflare Markdown for Agents converts HTML at the edge on `Accept: text/markdown` (Pro plan and up), sends `Vary: Accept`, and by default sends `content-signal: ai-train=yes, search=yes, ai-input=yes`. The `x-markdown-tokens` header was removed on 2026-10-09. | adopted | https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/, https://developers.cloudflare.com/changelog/post/2026-10-09-markdown-for-agents-in-process-conversion/ |
| Cloudflare's cache does not key on `Vary: Accept` (Vary is honoured only for images). | unverified this session (long-standing CF behaviour) | — |
| schema.org `Legislation` and its `legislation*` properties are adopted. Dataset/DataCatalog with `license`/`creditText` are standard types. | adopted | https://schema.org/Legislation |
| AI user agents: `GPTBot` and `ClaudeBot` train; `OAI-SearchBot`, `Claude-SearchBot` and `PerplexityBot` search; `ChatGPT-User`, `Claude-User` and `Perplexity-User` are user-triggered. Perplexity-User generally ignores robots. | adopted | https://developers.openai.com/api/docs/bots, https://support.claude.com/en/articles/8896518, https://docs.perplexity.ai/guides/bots |
| IETF aipref vocab (`Content-Usage`) is still a draft without consensus. `__usage_ai-training` is an individual draft that Anthropic honours from 2026-10-30. | proposal | draft-ietf-aipref-vocab-08, draft-kelley-aipref-training-preference-signal-00 |

**Decisions**

- **`.md` URLs are canonical.** Every entity page has one: speech, matter, member, law, day, party, document, plus `/index.md`, `/um.md` and `/mcp.md`. One renderer (`src/md-routes.ts`) feeds the routes, the MCP resources and `fetch`.
  - Each file has a small front matter (url, ids, citation) and the same facts as the HTML.
  - Speech paragraphs keep their `#mgr-N` anchors.
- **`Accept: text/markdown`** (when preferred over HTML) on an HTML URL gets a **302 to the `.md` twin**, not inline negotiation. Inline negotiation would cross-poison the edge cache. Behind Cloudflare the 302 only fires on an edge miss, because a cached HTML page is served whatever the Accept header says. So the `.md` URLs, not Accept, are what llms.txt and the `<link rel=alternate>` advertise. HTML responses also carry `Vary: Accept` for caches that honour it.
- **Size cap:** MCP-returned Markdown (from `fetch` and `resources/read`) is capped at 60k characters, with a trailing pointer to the `.md` URL and `get_law(article=N)`, and `fetch` sets `truncated: true`. 84 laws exceed 60k characters; the largest is 404k. The HTTP `.md` routes are never cut.
- **JSON:** `/leit.json` plus the MCP. Per-entity `.json` twins were deferred: the MCP tools already return that JSON.
- **OpenAPI 3.1** is at `/openapi.json`, covering `/leit.json`, the feeds, the CSV exports, `/healthz`, `/llms.txt` and the `.md` routes.
- **JSON-LD on the front page:** `WebSite` with a `SearchAction`, and a `Dataset` whose `distribution` lists the MCP endpoint, `/leit.json` and `llms.txt`, with `creditText` attribution. The existing `Person`, `Legislation` and `CreativeWork` blocks stay.
- **Licence:** we attribute Alþingi and link to it, and claim no licence over its data, since none was verified. The BÍN/lemma-is credit stays as DECISIONS.md specifies.
- **Front page:** one plain "Fyrir gervigreind" section, below the house chart. It shows the endpoint with a copy button, one line each for Claude, ChatGPT and Claude Code, and links to `/mcp`, llms.txt, the API and the `.md` twins. `/um` and the footer link to `/mcp`.

## 5. Connect instructions (as published on /mcp)

| Client | How | Source |
|---|---|---|
| Claude (web, Desktop, mobile; Free has one custom connector) | Customize › Connectors › Add › Add custom connector → URL → Authentication "No sign-in". On Team/Enterprise an Owner adds it under Organization settings › Connectors. | https://claude.com/docs/connectors/custom/add-unlisted.md |
| ChatGPT | chatgpt.com/plugins › + › Add custom MCP server → "No authentication" → install → `@` in chat. Plan availability unverified. | https://developers.openai.com/api/docs/guides/custom-mcp-server |
| Claude Code | `claude mcp add --transport http althingi https://althingi.solberg.is/mcp --scope user` | https://code.claude.com/docs/en/mcp |
| Cursor | `~/.cursor/mcp.json`: `{"mcpServers":{"althingi":{"url":"…/mcp"}}}` | https://cursor.com/docs/context/mcp |
| VS Code | `.vscode/mcp.json`: `{"servers":{"althingi":{"type":"http","url":"…/mcp"}}}` | https://code.visualstudio.com/docs/agents/reference/mcp-configuration |
| OpenAI Responses API | `{"type":"mcp","server_label":"althingi","server_url":"…/mcp","require_approval":"never"}` | https://developers.openai.com/api/docs/guides/tools-connectors-mcp |
| Anthropic Messages API | `anthropic-beta: mcp-client-2026-09-15`; `mcp_servers:[{type:"url",url,name}]` + `tools:[{type:"mcp_toolset",mcp_server_name}]` | https://platform.claude.com/docs/en/agents-and-tools/mcp-connector |

## 6. Deferred / open

- **v2 SDK** with 2026-07-28 support (`server/discover`, `ttlMs`/`cacheScope: "public"`). Wait until Claude and ChatGPT document 2026 clients.
- **Registry publish:** generate an Ed25519 key, serve `/.well-known/mcp-registry-auth`, then run `mcp-publisher login http --domain althingi.solberg.is` and `publish`. The owner does this.
- **`ai-train`** in Content-Signal (and `__usage_ai-training`): decided 2026-11-11, stay neutral (no signal either way). Revisit only if the owner asks.
- **Smaller deferrals:**
  - per-entity `.json` twins;
  - icons in serverInfo and the server card;
  - completions for resource-template variables;
  - `Legislation` JSON-LD on `l`-type matter pages.
- **Unknowns:**
  - What Claude.ai fetches to "detect" auth settings.
  - Whether ChatGPT probes the OAuth routes before any 401.
  - Whether Cloudflare's edge Markdown conversion would touch our origin-served `.md`. It is off on Free anyway.

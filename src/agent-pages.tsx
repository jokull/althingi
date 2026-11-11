// Agent-facing pages: the MCP connect page (GET /mcp in a browser) and the short front-page section.
import { Layout, SITE } from "./pages.tsx";
import { ATTRIBUTION, CLIENTS, MCP_URL, RATE } from "./agent-docs.ts";

const Endpoint = ({ id }: { id: string }) => (
  <div class="cite-row">
    <input id={id} class="cite" type="text" readonly value={MCP_URL} onfocus="this.select()" aria-label="Slóð MCP-þjóns" />
    <button type="button" class="btn" data-copy={id}>Afrita</button>
  </div>
);

export const McpPage = () => (
  <Layout title="Tengjast með MCP" desc="Opinn MCP-þjónn fyrir gervigreindarforrit: leit í ræðum, málum, atkvæðum og lögum Alþingis." canonical="/mcp" md="/mcp.md">
    <article class="doc">
      <h1>Tengjast með MCP</h1>
      <p class="lede">Gervigreindarforrit eins og Claude, ChatGPT og Cursor geta leitað beint í ræðum, málum, atkvæðagreiðslum og lögum Alþingis í gegnum opinn MCP-þjón. Engin innskráning; aðeins lestur.</p>
      <Endpoint id="mcp-url" />
      {CLIENTS.map((c) => (
        <section>
          <h2 id={c.id}>{c.name}</h2>
          <p>{c.steps}</p>
          {c.code && <>
            <pre class="code" id={`cfg-${c.id}`}>{c.code}</pre>
            <p><button type="button" class="btn" data-copy={`cfg-${c.id}`}>Afrita</button></p>
          </>}
        </section>
      ))}
      <h2>Hvað er í boði</h2>
      <p>Leit í ræðutexta frá 131. þingi (október 2004) sem finnur allar beygingarmyndir, ræður með tölusettum málsgreinum, mál með flutningsmönnum, skjölum og atkvæðagreiðslum (og afdrifum þeirra), þróun umræðu um efni ár frá ári (topic_timeline), atkvæði hvers þingmanns, þingfundir með dagskrá og lagasafnið. Hver niðurstaða hefur slóð til að vísa í.</p>
      <p>Þjónninn notar Streamable HTTP án lota (stateless) og svarar JSON. Takmörk: {RATE}</p>
      <h2>Fyrir forritara og gervigreind</h2>
      <ul>
        <li><a href="/llms.txt">llms.txt</a>: leiðbeiningar fyrir mállíkön (á ensku) · <a href="/llms-full.txt">llms-full.txt</a></li>
        <li><a href="/mcp/server-card">Server card</a> og <a href="/.well-known/ai-catalog.json">ai-catalog.json</a></li>
        <li><a href="/openapi.json">OpenAPI</a> fyrir /leit.json · hver síða er líka til sem Markdown: bættu <code>.md</code> við slóðina</li>
      </ul>
      <p class="hint">{ATTRIBUTION}</p>
    </article>
  </Layout>
);

/** Front page: a plain section for people who use AI assistants. */
export const AgentsSection = () => (
  <section class="agents" aria-labelledby="agents-h">
    <h2 id="agents-h">Fyrir gervigreind</h2>
    <p>Claude, ChatGPT, Cursor og önnur forrit geta leitað hér beint um opinn MCP-þjón, án innskráningar:</p>
    <Endpoint id="mcp-home" />
    <p class="hint">
      Í Claude: Connectors › Add custom connector. Í ChatGPT: Plugins › Add custom MCP server. Í Claude Code: <code>claude mcp add --transport http althingi {MCP_URL}</code>.{" "}
      <a href="/mcp">Allar leiðbeiningar</a> · <a href="/llms.txt">llms.txt</a> · <a href="/openapi.json">API</a> · hver síða er líka til sem Markdown (<code>.md</code>).
    </p>
  </section>
);

export { SITE };

// Agent-facing pages: the MCP connect page (GET /mcp in a browser).
import { Layout, SITE } from "./pages.tsx";

export const MCP_URL = `${SITE}/mcp`;

export const McpPage = () => (
  <Layout title="Tengjast með MCP" canonical="/mcp">
    <article class="doc">
      <h1>Tengjast með MCP</h1>
      <p class="lede">Opinn MCP-þjónn: {MCP_URL}</p>
    </article>
  </Layout>
);

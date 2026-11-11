// Agent-facing surfaces: MCP over Streamable HTTP without auth, CORS, rate limiting, new tools, resources, Markdown and
// JSON variants, and every discovery file (llms.txt, robots, sitemaps, .well-known, <link rel>, server.json).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "../src/web.tsx";
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
    }
    const list = await rpc("tools/list");
    expect(list.json.result.tools.length).toBeGreaterThanOrEqual(10);
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

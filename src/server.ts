#!/usr/bin/env bun
// bun src/server.ts — binds the app to 127.0.0.1:$PORT (default 3050). Uses the READ-ONLY role when configured.
import postgres from "postgres";
import { connect } from "./db.ts";
import { createApp } from "./web.tsx";

const sql = connect(process.env.DATABASE_URL_RO ?? process.env.DATABASE_URL, 8);
// MCP: own pool, 8 s statement timeout (the read-only role defaults to 2 s, right for web pages). Agents fire several
// heavy aggregates in parallel; 2 s failed them under crawler load (2026-11-11).
const mcpSql = postgres(process.env.DATABASE_URL_RO ?? process.env.DATABASE_URL!, {
  max: 6, idle_timeout: 30, onnotice: () => {}, connection: { statement_timeout: 8000 },
});
const app = createApp(sql, { mcpSql });
const port = Number(process.env.PORT ?? 3050);
Bun.serve({ port, hostname: "127.0.0.1", fetch: app.fetch });
console.log(`althingi-web listening on http://127.0.0.1:${port}`);

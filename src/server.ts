#!/usr/bin/env bun
// bun src/server.ts — binds the app to 127.0.0.1:$PORT (default 3050). Uses the READ-ONLY role when configured.
import postgres from "postgres";
import { connect } from "./db.ts";
import { createApp } from "./web.tsx";

const url = process.env.DATABASE_URL_RO ?? process.env.DATABASE_URL!;
// Both pools (docs/PERFORMANCE.md §3.1): enable_seqscan off because a seq scan with `tsvector @@ q` as its filter
// detoasts the whole table (1.6 s on speech_index, 8–13 s on paragraphs) and the planner picks it for near-stopword
// lexemes; with it off the GIN is always used and no index-less table of ours is big enough to care. jit off: compile
// time exceeds run time for these queries.
const planner = { enable_seqscan: "off", jit: "off" };
const sql = postgres(url, { max: 8, idle_timeout: 30, onnotice: () => {}, connection: planner });
// MCP: own pool, 8 s statement timeout (the read-only role defaults to 2 s, right for web pages). Agents fire several
// heavy aggregates in parallel; 2 s failed them under crawler load (2026-11-11).
const mcpSql = postgres(url, { max: 6, idle_timeout: 30, onnotice: () => {}, connection: { ...planner, statement_timeout: 8000 } });
const app = createApp(sql, { mcpSql });
const port = Number(process.env.PORT ?? 3050);
Bun.serve({ port, hostname: "127.0.0.1", fetch: app.fetch });
console.log(`althingi-web listening on http://127.0.0.1:${port}`);

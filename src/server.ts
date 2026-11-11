#!/usr/bin/env bun
// bun src/server.ts — binds the app to 127.0.0.1:$PORT (default 3050). Uses the READ-ONLY role when configured.
import { connect } from "./db.ts";
import { createApp } from "./web.tsx";

const sql = connect(process.env.DATABASE_URL_RO ?? process.env.DATABASE_URL, 8);
const app = createApp(sql);
const port = Number(process.env.PORT ?? 3050);
Bun.serve({ port, hostname: "127.0.0.1", fetch: app.fetch });
console.log(`althingi-web listening on http://127.0.0.1:${port}`);

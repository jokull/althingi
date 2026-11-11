#!/usr/bin/env bun
// Phase 0 exit gate (docs/DECISIONS.md §9). Usage: DATABASE_URL=… bun scripts/eval.ts [--show]
//   - golden queries: FTS/phrase (printed for judging; P@5 scored where test/golden/judged.json has judgments),
//     routing (exact path), member (clear winner), typo (suggestion)
//   - automatic: random matter titles from the DB -> query = their rarest lemmas -> MRR of speeches on that matter
//   - latency: DB time per search, p50/p95
import { readFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { connect } from "../src/db.ts";
import { describe } from "../src/explain.ts";
import { route } from "../src/route.ts";
import { search } from "../src/search.ts";
import { clearWinner, findMembers, suggest } from "../src/suggest.ts";
import { indexLemmas } from "../src/lemma.ts";
import { parseQuery } from "../src/explain.ts";
import { phraseTsQuery, recallTsQuery } from "../src/search.ts";

const { values: v } = parseArgs({ options: { show: { type: "boolean" }, current: { type: "string" }, dump: { type: "string" } } });
const dump: unknown[] = [];
const CURRENT = Number(v.current ?? 157);
const sql = connect();
const golden = JSON.parse(readFileSync(new URL("../test/golden/queries.json", import.meta.url), "utf8")) as {
  id: string; q: string; kind: string; expect?: { route?: string; suggests?: string };
}[];
const judgedPath = new URL("../test/golden/judged.json", import.meta.url);
// { "q01": { "relevantSpeechIds": ["rad…"] } }  — recorded after a human/agent review of the printed top 5
const judged: Record<string, { relevantSpeechIds: string[]; trueNegative?: boolean }> = existsSync(judgedPath) ? JSON.parse(readFileSync(judgedPath, "utf8")) : {};

const times: number[] = [];
const dbTimes: number[] = [];
const appTimes: number[] = [];
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] ?? 0;
const results: { id: string; pass: boolean | null; note: string }[] = [];

async function timed<T extends { timing?: { dbMs: number; appMs: number } }>(f: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const r = await f();
  times.push(performance.now() - t0);
  if (r.timing) { dbTimes.push(r.timing.dbMs); appTimes.push(r.timing.appMs); }
  return r;
}

try {
  // warm-up: the first call loads the 115 MB lemma-is model and primes the connection/cache; not part of the timings
  await search(sql, { q: "verðbólga", limit: 5, currentLthing: CURRENT });
  await search(sql, { q: "forseti", limit: 5, currentLthing: CURRENT });

  // ---- golden
  let fts = 0, ftsScored = 0, ftsPass = 0;
  for (const g of golden) {
    if (g.kind === "route") {
      const r = route(g.q, CURRENT);
      results.push({ id: g.id, pass: r?.path === g.expect?.route, note: `${g.q} -> ${r?.path ?? "none"}` });
    } else if (g.kind === "member") {
      const m = await findMembers(sql, g.q);
      const w = clearWinner(m);
      results.push({ id: g.id, pass: w !== null, note: `${g.q} -> ${w ? `${w.name} (#${w.id}, ${w.score.toFixed(2)})` : `no clear winner (${m.map((x) => x.name).join(", ") || "no match"})`}` });
    } else if (g.kind === "typo") {
      const s = await suggest(sql, g.q);
      const got = s.flatMap((x) => x.suggestions);
      results.push({ id: g.id, pass: got.includes(g.expect!.suggests!), note: `${g.q} -> ${got.join(", ") || "no suggestion"}` });
    } else {
      fts++;
      const r = await timed(() => search(sql, { q: g.q, limit: 5, currentLthing: CURRENT }));
      const ids = r.hits.map((h) => h.speechId);
      const j = judged[g.id];
      let note = `${r.hits.length} hits [${r.query.description}] db ${r.timing?.dbMs.toFixed(1)} ms, app ${r.timing?.appMs.toFixed(1)} ms`;
      let pass: boolean | null = null;
      if (j?.trueNegative) {
        // the corpus has no relevant text: correct behaviour is zero hits; excluded from the pass-rate denominator
        pass = r.hits.length === 0 ? null : false;
        if (pass === false) { ftsScored++; }
        note += r.hits.length === 0 ? " (true negative: 0 hits, correct)" : ` FALSE POSITIVES: ${r.hits.length} hits for a query the corpus cannot answer`;
      } else if (j) {
        ftsScored++;
        const rel = ids.filter((id) => j.relevantSpeechIds.includes(id)).length;
        pass = rel >= 4 || (r.hits.length < 5 && rel === r.hits.length && r.hits.length > 0);
        if (pass) ftsPass++;
        note += ` P@5=${rel}/${Math.min(5, r.hits.length)}`;
      } else note += " (unjudged)";
      results.push({ id: g.id, pass, note });
      if (v.dump) {
        const keys = r.hits.flatMap((h) => h.paragraphs.map((p) => ({ sid: h.speechId, seq: p.seq })));
        const full = keys.length
          ? await sql<{ speech_id: string; seq: number; text: string }[]>`
              select p.speech_id, p.seq, p.text from paragraphs p
              join unnest(${keys.map((k) => k.sid)}::text[], ${keys.map((k) => k.seq)}::int[]) as k(sid, sq) on p.speech_id = k.sid and p.seq = k.sq`
          : [];
        dump.push({
          id: g.id, query: g.q, kind: g.kind, expandedQuery: r.query.description, dropped: r.query.parsed.dropped, totalReturned: r.hits.length,
          hits: r.hits.map((h, i) => ({
            rank: i + 1, speechId: h.speechId, speaker: h.memberName, type: h.speechType, date: h.date, matter: h.matter?.title ?? null,
            paragraphs: h.paragraphs.map((p) => ({ seq: p.seq, text: full.find((f) => f.speech_id === h.speechId && f.seq === p.seq)?.text ?? "" })),
          })),
        });
      }
      if (v.show) {
        for (const h of r.hits) {
          const sn = h.paragraphs[0]?.snippets[0]?.text ?? "";
          console.log(`   ${g.id} ${h.speechId} ${h.memberName} · ${h.speechType} · ${h.matter?.title ?? "—"}\n      ${sn.slice(0, 160)}`);
        }
      }
    }
  }

  // ---- automatic: matter titles -> speeches on that matter
  const matters = await sql<{ lthing: number; cls: string; nr: number; title: string; n: number }[]>`
    select m.lthing, m.cls, m.nr, m.title, count(*)::int n from matters m
    join speeches s on s.lthing = m.lthing and s.matter_cls = m.cls and s.matter_nr = m.nr and s.text_state = 'done'
    where m.cls = 'A' and length(m.title) > 12
    group by 1,2,3,4 having count(*) >= 3 order by md5(m.title) limit 100`;
  const vocab = new Map((await sql<{ word: string; ndoc: number }[]>`select word, ndoc from vocab`).map((r) => [r.word, r.ndoc]));
  let rr = 0, autoN = 0;
  for (const m of matters) {
    const lemmas = indexLemmas(m.title).filter((l) => vocab.has(l)).sort((a, b) => (vocab.get(a) ?? 0) - (vocab.get(b) ?? 0));
    const q = lemmas.slice(0, 3).join(" ");
    if (!q) continue;
    const truth = new Set((await sql<{ id: string }[]>`select id from speeches where lthing = ${m.lthing} and matter_cls = ${m.cls} and matter_nr = ${m.nr}`).map((r) => r.id));
    const res = await timed(() => search(sql, { q, limit: 25, currentLthing: CURRENT }));
    const rank = res.hits.findIndex((h) => truth.has(h.speechId));
    rr += rank >= 0 ? 1 / (rank + 1) : 0;
    autoN++;
  }
  const mrr = autoN ? rr / autoN : 0;

  // ---- report
  for (const r of results) console.log(`${r.pass === true ? "PASS" : r.pass === false ? "FAIL" : "  - "} ${r.id} ${r.note}`);
  const routing = results.filter((r) => /^q2[1-4]$/.test(r.id));
  console.log("\n== Phase 0 gate ==");
  const gate = (name: string, ok: boolean | null, detail: string) => console.log(`${ok === null ? "n/a " : ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  gate("P@5 over judged FTS/phrase queries", ftsScored ? ftsPass / ftsScored >= 0.8 : null, `${ftsPass}/${ftsScored} judged (${fts} queries total; need >= 0.8)`);
  gate("routing lands on the right entity", routing.every((r) => r.pass), `${routing.filter((r) => r.pass).length}/${routing.length}`);
  gate("member name routes to a clear winner", results.find((r) => r.id === "q25")?.pass ?? null, results.find((r) => r.id === "q25")?.note ?? "");
  gate("typo shows the suggestion", results.find((r) => r.id === "q26")?.pass ?? null, results.find((r) => r.id === "q26")?.note ?? "");
  gate("auto MRR >= 0.6", autoN ? mrr >= 0.6 : null, `${mrr.toFixed(3)} over ${autoN} matter titles`);
  gate("DB time p95 <= 20 ms (main query)", dbTimes.length ? pct(dbTimes, 0.95) <= 20 : null, `p50 ${pct(dbTimes, 0.5).toFixed(1)} ms, p95 ${pct(dbTimes, 0.95).toFixed(1)} ms over ${dbTimes.length} searches`);
  gate("app time p95 <= 40 ms (query lemmatizing, snippets, cards)", appTimes.length ? pct(appTimes, 0.95) <= 40 : null, `p50 ${pct(appTimes, 0.5).toFixed(1)} ms, p95 ${pct(appTimes, 0.95).toFixed(1)} ms`);
  console.log(`      end-to-end (db+app): p50 ${pct(times, 0.5).toFixed(1)} ms, p95 ${pct(times, 0.95).toFixed(1)} ms`);
  // size: per-done-speech cost of the text tables, plus the index row every speech has, projected linearly to 250k.
  // Linear is a deliberate overestimate: GIN posting lists share vocabulary, so per-speech cost falls with corpus size.
  const sz = await sql`
    select (select count(*)::float8 from speeches where text_state = 'done') as done,
           (select count(*)::float8 from speeches) as indexed,
           pg_total_relation_size('paragraphs')::float8 + pg_total_relation_size('paragraph_tokens')::float8 as text_bytes,
           pg_total_relation_size('speeches')::float8 as index_bytes`;
  const z = sz[0]!;
  const gb = ((Number(z.text_bytes) / Math.max(1, Number(z.done))) * 250_000 + (Number(z.index_bytes) / Math.max(1, Number(z.indexed))) * 250_000) / 1e9;
  gate("size projection <= 8 GB at 250k speeches (disk free on mini: 38 GB)", gb <= 8,
    `${gb.toFixed(1)} GB linear (text tables ${(Number(z.text_bytes) / Number(z.done) / 1024).toFixed(1)} KB/speech) — an overestimate`);

  // ---- property: a 1-3 word window of a stored paragraph, used as a query, must match THAT paragraph in the stored index
  {
    const sample = await sql<{ speech_id: string; seq: number; text: string }[]>`
      select speech_id, seq, text from paragraphs where length(text) > 200 order by md5(speech_id || seq::text) limit 300`;
    let checked = 0, missed = 0;
    const misses: string[] = [];
    for (const p of sample) {
      const words = p.text.split(" ");
      for (let i = 0; i + 3 <= words.length; i += 9) {
        const q = words.slice(i, i + 3).join(" ");
        const parsed = parseQuery(q);
        const rq = recallTsQuery(parsed);
        if (!rq) continue; // stopword-only window: nothing to search
        checked++;
        const hit = await sql`select 1 from paragraphs where speech_id = ${p.speech_id} and seq = ${p.seq} and search_vector @@ to_tsquery('simple', ${rq})`;
        if (hit.length === 0) { missed++; if (misses.length < 6) misses.push(`${q} -> ${describe(parsed)}`); }
      }
    }
    const rate = checked ? 1 - missed / checked : 1;
    gate("property: query windows find their own paragraph >= 99.9%", rate >= 0.999, `${(rate * 100).toFixed(2)}% of ${checked} windows (${missed} missed)${misses.length ? ": " + misses.join(" | ") : ""}`);
  }

  // ---- persona coverage (reported, not gated): verdicts are against the PLAN, see docs/PERSONAS.md
  const personasPath = new URL("../test/golden/personas.json", import.meta.url);
  if (existsSync(personasPath)) {
    const tasks = JSON.parse(readFileSync(personasPath, "utf8")) as { persona: string; verdict: "served" | "partial" | "gap" }[];
    const by = new Map<string, { served: number; partial: number; gap: number }>();
    for (const t of tasks) {
      const c = by.get(t.persona) ?? { served: 0, partial: 0, gap: 0 };
      c[t.verdict]++;
      by.set(t.persona, c);
    }
    console.log("\n== Persona coverage (plan verdicts) ==");
    console.table(Object.fromEntries(by));
  }
  if (v.dump) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(v.dump, JSON.stringify(dump, null, 2));
    console.log(`dumped ${dump.length} queries to ${v.dump}`);
  }
} finally {
  await sql.end();
}

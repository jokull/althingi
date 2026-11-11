import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { type Sql, connect, migrate } from "../src/db.ts";
import { searchEntities } from "../src/entities.ts";
import { ingestLawDir } from "../src/laws-ingest.ts";
import { latin1, parseChapterIndex, parseLaw } from "../src/laws.ts";
import { createApp } from "../src/web.tsx";

const DIR = fileURLToPath(new URL("../fixtures/lagasafn", import.meta.url));
const raw = (n: string) => latin1(readFileSync(`${DIR}/${n}`));

describe("law collection parsers", () => {
  test("a law in force: title, edition, in-force line, matter link, amendments, articles", () => {
    const l = parseLaw("2016046.html", raw("2016046.html"));
    expect(l).toMatchObject({ year: 2016, nr: 46, edition: "158a", title: "Lög um ríkisendurskoðanda og endurskoðun ríkisreikninga", inForce: "Tóku gildi 1. janúar 2017" });
    expect(l.matter).toEqual({ lthing: 145, nr: 112 });
    expect(l.amendments[0]).toEqual({ year: 2016, nr: 130, effective: "tóku gildi 1. júlí 2017" });
    expect(l.amendments.find((a) => a.nr === 72 && a.year === 2019)!.effective).toContain("EES-samningurinn");
    expect(l.articles[0]).toMatchObject({ id: "G1", heading: "1. gr. Ríkisendurskoðandi og Ríkisendurskoðun." });
    expect(l.articles[0]!.text).toContain("Ríkisendurskoðandi starfar á vegum Alþingis");
    expect(l.articles[0]!.text).not.toContain("II. kafli");
  });

  test("a repealed law keeps its status line", () => {
    const l = parseLaw("1955003.html", raw("1955003.html"));
    expect(l.title).toBe("Lög um skógrækt");
    expect(l.inForce).toBe("Felld úr gildi skv. l. 33/2019, 24. gr");
    expect(l.articles).toEqual([]);
  });

  test("chapter index", () => {
    const c = parseChapterIndex(raw("11.html"));
    expect(c.edition).toBe("158a");
    expect(c.laws.find((x) => x.file === "2016046")?.chapter).toMatch(/^11\.a\. /);
  });

  test("sub-part files are not laws", () => {
    expect(() => parseLaw("1979010.2c3.html", raw("1979010.2c3.html"))).toThrow();
  });
});

const ADMIN = process.env.TEST_PG ?? "postgres://postgres:dev@localhost:5433/postgres";
const NAME = `althingi_laws_test_${process.pid}`;
let sql: Sql;
let admin: postgres.Sql;
let ok = false;
beforeAll(async () => {
  admin = postgres(ADMIN, { max: 1, onnotice: () => {} });
  try { await admin`select 1`; } catch { return; }
  await admin.unsafe(`create database ${NAME}`);
  sql = connect(ADMIN.replace(/\/[^/]*$/, `/${NAME}`));
  await migrate(sql);
  ok = true;
});
afterAll(async () => {
  if (!ok) return;
  await sql.end();
  await admin.unsafe(`drop database ${NAME} with (force)`);
  await admin.end();
});

describe("laws in the db and on the site", () => {
  test("ingest, law page, entity search by title", async () => {
    if (!ok) return;
    const r = await ingestLawDir(sql, DIR);
    expect(r).toMatchObject({ laws: 2, skipped: 1, edition: "158a" });
    expect((await sql`select count(*)::int n from law_articles where year = 2016 and nr = 46`)[0]!.n).toBeGreaterThan(20);
    const page = await (await createApp(sql).request("http://x/log/2016/46")).text();
    expect(page).toContain("Lög um ríkisendurskoðanda og endurskoðun ríkisreikninga");
    expect(page).toContain("11.a.");
    expect(page).toContain(`href="https://www.althingi.is/lagas/nuna/2016046.html" rel="noopener">Á vef Alþingis →`);
    expect(page).toContain(`href="/log/2016/130"`);
    const e = await searchEntities(sql, "ríkisendurskoðanda", 157);
    expect(e.log[0]).toMatchObject({ href: "/log/2016/46", title: "Lög um ríkisendurskoðanda og endurskoðun ríkisreikninga" });
    expect((await ingestLawDir(sql, DIR)).laws).toBe(2); // rerun: same rows, no duplicates
    expect((await sql`select count(*)::int n from laws`)[0]!.n).toBe(2);
  });
});

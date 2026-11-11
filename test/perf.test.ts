// Pure pieces of docs/PERFORMANCE.md: the migration splitter, the candidate estimate and the rank window, the LRU.
import { describe, expect, test } from "bun:test";
import { Lru, memo } from "../src/cache.ts";
import { splitStatements } from "../src/db.ts";
import { estimateCandidates, idCeil, idFloor, rankWindow } from "../src/search.ts";
import type { SessionInfo } from "../src/corpus.ts";
import { parseQuery } from "../src/explain.ts";

describe("splitStatements (no-transaction migrations)", () => {
  test("splits on top-level semicolons only: strings, dollar-quoted bodies and comments are kept whole", () => {
    const s = splitStatements(`-- migrate: no-transaction
create table t (a text default 'x;y');
create or replace function f() returns int language plpgsql as $$
begin return 1; end $$;
-- a comment; with a semicolon
create index concurrently if not exists i on t (a);
select f();
`);
    expect(s).toHaveLength(4);
    expect(s[0]).toContain("default 'x;y'");
    expect(s[1]).toContain("begin return 1; end $$");
    expect(s[2]).toContain("create index concurrently if not exists i on t (a)"); // a leading comment travels with its statement
    expect(s[3]).toBe("select f()");
  });
});

describe("candidate cap", () => {
  const sessions: SessionInfo[] = [158, 157, 156, 155].map((lthing, i) => ({
    lthing, period: null, starts: null, ends: null, done: 10_000, pending: 0, unavailable: 0,
    first_date: `${2026 - i}-01-01`, last_date: `${2026 - i}-12-31`, complete: lthing < 158,
  }));
  test("ids are dates: floor is inclusive, ceiling is the next day", () => {
    expect(idFloor("2017-01-01")).toBe("rad20170101");
    expect(idCeil("2019-12-31")).toBe("rad20200101");
    expect(idCeil("2024-02-29")).toBe("rad20240301");
  });
  test("estimate: sum over a word's alternatives, minimum over AND-parts, unknown lemmas ignored", () => {
    const p = parseQuery("húsnæðislán vextir");
    const counts = new Map([["húsnæðislán", 900], ["vöxtur", 30_000]]);
    expect(estimateCandidates(p, counts)).toBe(900);
    expect(estimateCandidates(parseQuery("veiðigjald"), new Map([["veiðigjald", 7190]]))).toBe(7190);
    expect(estimateCandidates(parseQuery("veiðigjald"), new Map())).toBe(0);
  });
  test("window: none under the cap; else the newest sessions whose share of the corpus fits the cap", () => {
    expect(rankWindow(4000, sessions, 40_000, false, 5000)).toEqual({ from: null, to: null });
    // 40k est × (10k/40k) = 10k ≥ cap after the first session
    expect(rankWindow(40_000, sessions, 40_000, false, 5000)).toEqual({ from: "2026-01-01", to: null });
    // 12k est: one session gives 3k, two give 6k ≥ 5k
    expect(rankWindow(12_000, sessions, 40_000, false, 5000)).toEqual({ from: "2025-01-01", to: null });
    expect(rankWindow(12_000, sessions, 40_000, true, 5000)).toEqual({ from: null, to: "2024-12-31" });
  });
});

describe("Lru + memo", () => {
  test("evicts the oldest, shares in-flight promises, never caches a failure", async () => {
    const lru = new Lru<Promise<number>>(2);
    let calls = 0;
    const f = memo(lru, (k: string) => k, async (k) => { calls++; if (k === "bad") throw new Error("x"); return k.length; });
    expect(await Promise.all([f("a"), f("a"), f("bb")])).toEqual([1, 1, 2]);
    expect(calls).toBe(2);
    await f("ccc"); // evicts "a"
    await f("a");
    expect(calls).toBe(4);
    await expect(f("bad")).rejects.toThrow("x");
    await expect(f("bad")).rejects.toThrow("x");
    expect(calls).toBe(6);
  });
});

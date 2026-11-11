import { describe, expect, test } from "bun:test";
import { Blocked, Fetcher, RateLimited, normalizeUrl } from "../src/fetcher.ts";

function fake(responses: Array<{ status: number; body?: string } | Error>) {
  const calls: { url: string; headers: Record<string, string>; t: number }[] = [];
  let t = 0;
  const sleeps: number[] = [];
  const f = new Fetcher({
    minGapMs: 5000,
    backoffMs: [60_000, 180_000],
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, t });
      const r = responses.shift()!;
      if (r instanceof Error) throw r;
      return new Response(r.body ?? "<ok/>", { status: r.status });
    }) as unknown as typeof fetch,
  });
  return { f, calls, sleeps, advance: (ms: number) => { t += ms; } };
}

describe("normalizeUrl allowlist", () => {
  test("accepts XML service and speech text files, upgrades to https://www", () => {
    expect(normalizeUrl("http://www.althingi.is/xml/157/raedur/rad20250911T103151.xml")).toBe(
      "https://www.althingi.is/xml/157/raedur/rad20250911T103151.xml");
    expect(normalizeUrl("http://althingi.is/altext/xml/thingmenn/?lthing=157")).toBe(
      "https://www.althingi.is/altext/xml/thingmenn/?lthing=157");
  });

  test("refuses HTML, sgml, pdf, laws, other hosts", () => {
    for (const u of [
      "https://www.althingi.is/altext/raeda/157/rad20250911T103151.html",
      "https://www.althingi.is/altext/123/03/r02133209.sgml",
      "https://www.althingi.is/altext/pdf/157/s/0001.pdf",
      "https://www.althingi.is/lagas/nuna/1998046.html",
      "https://www.althingi.is/dba-bin/ferill.pl?ltg=131&mnr=100",
      "https://www.althingi.is/",
      "https://example.com/altext/xml/thingmenn/",
      "https://www.althingi.is/xml/157/raedur/../../altext/157/s/0001.html",
    ]) expect(() => normalizeUrl(u)).toThrow();
  });
});

describe("Fetcher", () => {
  test("sends a descriptive User-Agent with contact info", async () => {
    const { f, calls } = fake([{ status: 200 }]);
    await f.get("https://www.althingi.is/altext/xml/thingmenn/?lthing=157");
    expect(calls[0]!.headers["User-Agent"]).toMatch(/althingi-search\/.* \(.+@.+\)/);
  });

  test("keeps >= 5 s between requests", async () => {
    const { f, calls, advance } = fake([{ status: 200 }, { status: 200 }, { status: 200 }]);
    const u = "https://www.althingi.is/altext/xml/thingmenn/?lthing=157";
    await f.get(u);
    advance(1000);
    await f.get(u);
    await f.get(u);
    expect(calls[1]!.t - calls[0]!.t).toBeGreaterThanOrEqual(5000);
    expect(calls[2]!.t - calls[1]!.t).toBeGreaterThanOrEqual(5000);
  });

  test("403 stops immediately with Blocked and is never retried", async () => {
    const { f, calls } = fake([{ status: 403 }, { status: 200 }]);
    await expect(f.get("https://www.althingi.is/altext/xml/thingmenn/?lthing=157")).rejects.toBeInstanceOf(Blocked);
    expect(calls.length).toBe(1);
  });

  test("an HTML body (challenge page served as 200) is treated as Blocked", async () => {
    const { f } = fake([{ status: 200, body: "<!DOCTYPE html><html>Attention Required</html>" }]);
    await expect(f.get("https://www.althingi.is/altext/xml/thingmenn/?lthing=157")).rejects.toBeInstanceOf(Blocked);
  });

  test("429 backs off on the schedule, then succeeds", async () => {
    const { f, sleeps } = fake([{ status: 429 }, { status: 429 }, { status: 200, body: "<a/>" }]);
    const r = await f.get("https://www.althingi.is/altext/xml/thingmenn/?lthing=157");
    expect(r.status).toBe(200);
    expect(sleeps.filter((s) => s >= 60_000)).toEqual([60_000, 180_000]);
  });

  test("persistent 429 ends in RateLimited", async () => {
    const { f } = fake([{ status: 429 }, { status: 429 }, { status: 429 }]);
    await expect(f.get("https://www.althingi.is/altext/xml/thingmenn/?lthing=157")).rejects.toBeInstanceOf(RateLimited);
  });

  test("404 is returned to the caller, not retried", async () => {
    const { f, calls } = fake([{ status: 404, body: "<nf/>" }]);
    const r = await f.get("https://www.althingi.is/xml/157/raedur/rad20250911T103151.xml");
    expect(r.status).toBe(404);
    expect(calls.length).toBe(1);
  });

  test("network errors retry then give up", async () => {
    const { f } = fake([new Error("ECONNRESET"), new Error("ECONNRESET"), new Error("ECONNRESET")]);
    await expect(f.get("https://www.althingi.is/altext/xml/thingmenn/?lthing=157")).rejects.toThrow(/giving up/);
  });
});

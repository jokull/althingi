import { describe, expect, test } from "bun:test";
import { describe as describeQuery, parseQuery } from "../src/explain.ts";
import { numberProximityTsQuery, phraseTsQuery, recallTsQuery } from "../src/search.ts";
import { route } from "../src/route.ts";

const R = (q: string) => route(q, 157)?.path ?? null;

describe("route", () => {
  test("laws", () => {
    expect(R("lög nr. 34/1991")).toBe("/log/1991/34");
    expect(R("Lög nr 46/2016")).toBe("/log/2016/46");
    expect(R("46/2016")).toBe("/log/2016/46");
    expect(R("  lög 7/2020 ")).toBe("/log/2020/7");
  });

  test("þingskjöl default to the current session", () => {
    expect(R("þskj. 421")).toBe("/thingskjal/157/421");
    expect(R("þingskjal 421")).toBe("/thingskjal/157/421");
    expect(R("þskj. 150/12")).toBe("/thingskjal/150/12");
  });

  test("matters: class defaults to A, B when given", () => {
    expect(R("300. mál")).toBe("/mal/157/a/300");
    expect(R("mál 300")).toBe("/mal/157/a/300");
    expect(R("157/300")).toBe("/mal/157/a/300");
    expect(R("157/b/307")).toBe("/mal/157/b/307");
    expect(R("131. þing 100. mál")).toBe("/mal/131/a/100");
  });

  test("ordinary text and numbers that are not references are not routed", () => {
    for (const q of ["veiðigjald", "fjárlög 2026", "hér á landi", "2026", "1991", "lög um veiðigjald", "157"]) {
      expect(route(q, 157)).toBeNull();
    }
  });
});

describe("parseQuery / describe", () => {
  test("inflected words expand to lemma groups; stopwords are reported, not silently lost", () => {
    const p = parseQuery("húsnæðislán og vextir");
    expect(p.empty).toBe(false);
    expect(p.parts.length).toBe(2);
    expect(p.parts[0]!.lemmas).toContain("húsnæðislán");
    expect(p.dropped).toContain("og");
    expect(describeQuery(p)).toMatch(/vextir|vöxtur|vaxtar/);
  });

  test("quoted phrase becomes ordered adjacent lemmas (stopwords dropped on both sides)", () => {
    const p = parseQuery('"hér á landi" veiðigjald');
    const phrase = p.parts.find((x) => x.kind === "phrase")!;
    expect(phrase.lemmas).toEqual(["hér", "á", "land"]); // exact: the stopword stays inside quotes
    expect(p.parts.some((x) => x.kind === "word")).toBe(true);
    expect(describeQuery(p)).toContain('"hér á land"');
  });

  test("stopword-only and blank queries are empty", () => {
    expect(parseQuery("og").empty).toBe(true);
    expect(parseQuery("   ").empty).toBe(true);
    expect(parseQuery('""').empty).toBe(true);
  });
});

describe("recall query shape", () => {
  test("known compound = whole lemma only (no 'mál' leakage); unknown compound = whole | (part & part)", () => {
    const known = recallTsQuery(parseQuery("loftslagsmál"))!;
    expect(known).toBe("'loftslagsmál'");
    expect(describeQuery(parseQuery("loftslagsmál"))).toBe("loftslagsmál");
    const unknown = recallTsQuery(parseQuery("hvalkjötsframleiðsla"))!;
    expect(unknown).toContain("'hvalkjötsframleiðsla'");
    expect(unknown).toContain("('hvalkjöt' & 'framleiðsla')");
    expect(describeQuery(parseQuery("hvalkjötsframleiðsla"))).toContain("(hvalkjöt & framleiðsla)");
  });

  test('a stopword-heavy quoted phrase is exact, not collapsed to its one content word ("ekki er allt sem sýnist")', () => {
    const q = phraseTsQuery(parseQuery('"ekki er allt sem sýnist"'))!;
    expect(q.match(/<->/g)?.length).toBe(4); // five tokens, four adjacency links: nothing was dropped
    expect(q.startsWith("('ekki' <->")).toBe(true);
    expect(q.endsWith("<-> 'sem' <-> 'sýna')")).toBe(true);
  });

  test("a year must sit near a query word, not anywhere in the paragraph", () => {
    const q = numberProximityTsQuery(parseQuery("fjárlög 2026"))!;
    expect(q).toContain("'fjárlög' <1> '2026'");
    expect(q).toContain("'2026' <8> 'fjárlög'");
    expect(q).not.toContain("<9>");
    expect(numberProximityTsQuery(parseQuery("veiðigjald"))).toBeNull();
  });
});

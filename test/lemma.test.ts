import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { analyze, indexLemmaMultiset, indexLemmaSets, indexLemmas, queryGroupsStructured, lemmaText, lemmaVersion, queryGroups, searchTsQuery, seqLemmas, toTsQuery, tokenStream } from "../src/lemma.ts";
import { parseSpeechText } from "../src/parse.ts";

const dir = new URL("../fixtures/sample/", import.meta.url);
const paragraphs = readdirSync(dir)
  .filter((f) => /^speech_.*_rad\d{8}T\d{6}_xml\.xml$/.test(f))
  .flatMap((f) => parseSpeechText(readFileSync(new URL(f, dir), "utf8")).paragraphs.map((p) => p.text));

describe("lemma.ts (single source for ingest and query)", () => {
  test("version string pins package + binary", () => {
    expect(lemmaVersion()).toMatch(/^lemma-is@0\.13\.0\+[0-9a-f]{12}\/r\d+$/);
  });

  test("lemmas are lowercase and deduplicated", () => {
    const l = indexLemmas("Börnin keypti hestinn. Hestarnir komu.");
    expect(l).toContain("barn");
    expect(l).toContain("hestur");
    expect(l.every((x) => x === x.toLowerCase())).toBe(true);
    expect(new Set(l).size).toBe(l.length);
  });

  test("inflected query matches inflected text: hestum ~ hestinum", () => {
    const doc = new Set(indexLemmas("Ég sá hestinn í gær"));
    const g = queryGroups("hestum");
    expect(g.length).toBe(1);
    expect(g[0]!.some((x) => doc.has(x))).toBe(true);
  });

  test("compounds: 'lán' finds 'húsnæðislán'", () => {
    const doc = new Set(indexLemmas("Húsnæðislán hækkuðu verulega."));
    expect(queryGroups("lán")[0]!.some((x) => doc.has(x))).toBe(true);
  });

  // The premise of the whole design: any phrase taken from a paragraph, used as a query,
  // should produce groups that each intersect that paragraph's index set. Not strictly 100%:
  // lemma-is is context-sensitive (e.g. "klukkan fimm á morgnana" is a phrase that skips tokens),
  // so we bound the miss rate instead of hiding it. Measured 0.03% on 135 paragraphs.
  test("property: windows of real paragraphs match their own paragraph (miss rate < 0.5%)", () => {
    expect(paragraphs.length).toBeGreaterThan(100);
    let checked = 0;
    const misses: string[] = [];
    for (const p of paragraphs) {
      const idx = new Set(indexLemmas(p));
      const words = p.split(" ");
      for (let i = 0; i + 3 <= words.length; i += 3) {
        const q = words.slice(i, i + 3).join(" ");
        for (const g of queryGroups(q)) {
          checked++;
          if (!g.some((x) => idx.has(x))) misses.push(`${q} :: ${g.join("|")}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(3000);
    expect(misses.length / checked).toBeLessThan(0.005);
  }, 30_000);

  test("hyphenated ellipsis compounds are split into single lexemes without stopwords", () => {
    const l = indexLemmas("hljóð- og myndmiðlun");
    expect(l).toContain("myndmiðlun");
    expect(l.every((x) => !/\s/.test(x))).toBe(true);
    expect(l).not.toContain("og");
  });

  test("tsquery building is safe and shaped as AND of OR-groups", () => {
    expect(toTsQuery([["a"], ["b", "c"]])).toBe("'a' & ('b' | 'c')");
    expect(toTsQuery([["it's"]])).toBe("'it''s'");
    expect(toTsQuery([])).toBeNull();
    expect(searchTsQuery("   ")).toBeNull();
  });

  test("lemmaText is the space-joined index set", () => {
    expect(lemmaText("Börnin keypti hestinn")).toBe(indexLemmas("Börnin keypti hestinn").join(" "));
  });

  test("token stream: offsets slice the original text; disambiguation is contextual", () => {
    const text = "Ég á 5 hesta, klukkan fimm á morgnana.";
    const tk = tokenStream(text);
    for (const t of tk) expect(text.slice(t.start, t.start + t.len)).toBe(t.surface);
    const a = tk.filter((t) => t.surface === "á");
    expect(a.map((t) => t.lemma)).toEqual(["eiga", "á"]); // verb after "Ég", preposition after a time phrase
    expect(a[0]!.pos).toBe("so");
    expect(tk.find((t) => t.surface === "5")).toMatchObject({ lemma: "5", conf: -1, kind: "number" });
    expect(tk.find((t) => t.surface === "hesta")).toMatchObject({ lemma: "hestur", pos: "no" });
  });

  test("seqLemmas: ordered best lemma, stopwords dropped, numbers kept, same function for phrase queries", () => {
    expect(seqLemmas("hér á landi")).toEqual(["hér", "á", "land"]); // stopwords stay: quoted phrases are exact
    expect(seqLemmas("virðulegi forseti")).toEqual(["virðulegur", "forseti"]);
    expect(seqLemmas("Ég á 5 hesta og húsnæðislán")).toEqual(["ég", "eiga", "5", "hestur", "og", "húsnæðislán"]);
    expect(seqLemmas("hljóð- og myndmiðlun")).toEqual(["hljóð", "og", "myndmiðlun"]);
    // exact lemma choice for function words is lemma-is's business; what matters is that ALL five tokens are kept
    const ph = seqLemmas("ekki er allt sem sýnist");
    expect(ph.length).toBe(5);
    expect([ph[0], ph[3], ph[4]]).toEqual(["ekki", "sem", "sýna"]);
  });

  test("analyze: arrays line up and lemma_seq is the sequence side", () => {
    const a = analyze("Virðulegi forseti, hér á landi.");
    expect(a.tokens.length).toBe(5);
    expect(a.lemmaSeq).toBe("virðulegur forseti hér á land");
    expect(a.lemmaText.split(" ")).toContain("land");
  });

  test("query side: a KNOWN word is never split (verðbólga, lögregla); an UNKNOWN compound gets one OR-group per part", () => {
    for (const w of ["verðbólga", "lögregla", "loftslagsmál"]) {
      const [g] = queryGroupsStructured(w);
      expect(g!.allOf).toBeNull(); // dictionary words have their own indexed lemma; no etymology on the query side
      expect(g!.any).toContain(w);
      expect(g!.any).not.toContain("lög"); // lögregla != lög & regla
      expect(g!.any).not.toContain("mál");
    }
    const [h] = queryGroupsStructured("hvalkjötsframleiðsla");
    expect(h!.any).toContain("hvalkjötsframleiðsla");
    expect(h!.allOf).toEqual([["hvalkjöt"], ["framleiðsla"]]); // each part its own group, not one giant AND of variants
    const [k] = queryGroupsStructured("kaffibollastaða");
    expect(k!.allOf!.length).toBe(2);
    // the INDEX side still adds parts, so the reverse direction works: "lán" finds "húsnæðislán"
    expect(indexLemmas("húsnæðislán")).toEqual(expect.arrayContaining(["húsnæðislán", "húsnæði", "lán"]));
    expect(queryGroupsStructured("hestur")[0]!.allOf).toBeNull();
  });


  test("compound parts are indexed separately (low weight) and never mixed into the whole-word set", () => {
    const a = analyze("Þetta lýðræði og húsnæðislán og tilefni.");
    const whole = a.lemmaText.split(" ");
    const parts = a.lemmaParts.split(" ").filter(Boolean);
    expect(whole).toEqual(expect.arrayContaining(["lýðræði", "húsnæðislán", "tilefni"]));
    expect(whole).not.toContain("ræða"); // the junk constituent of lýðræði is NOT a whole-word lemma
    expect(whole).not.toContain("lán");
    expect(parts).toContain("lán"); // but it stays findable, at weight D
    expect(parts.some((x) => whole.includes(x))).toBe(false); // disjoint sets
  });

  test("term frequency survives into the index: one entry per occurrence, same lexeme set as lemma-is", () => {
    const text = "Lögreglan kom. Lögreglan fór. Lögreglan sagði ekkert um hestinn.";
    const a = analyze(text);
    const count = (w: string) => a.lemmaText.split(" ").filter((x) => x === w).length;
    expect(count("lögregla")).toBe(3);
    expect(count("hestur")).toBe(1);
    // recall is unchanged: the SET of lexemes equals what lemma-is's own extractIndexableLemmas produces
    const multi = indexLemmaMultiset(text);
    const set = indexLemmaSets(text);
    expect(new Set(multi.whole)).toEqual(new Set(set.whole));
    expect(new Set(multi.parts)).toEqual(new Set(set.parts));
    // parts repeat too, and stay disjoint from the whole-word lexemes
    const b = analyze("Lögreglustjóraembættið og lögreglustjóraembættin og lögreglustjóri.");
    expect(b.lemmaParts.split(" ").filter(Boolean).length).toBeGreaterThan(new Set(b.lemmaParts.split(" ")).size - 1);
    expect(b.lemmaParts.split(" ").some((x) => b.lemmaText.split(" ").includes(x))).toBe(false);
  });
});

test("known compounds never leak their parts as free query alternatives", () => {
  // lemma-is lists non-lemma part strings ("umhverfis") and stopword parts ("meðal") among the readings; the group must
  // still be recognised as the compound's, or "umhverfismál" matches every paragraph that contains "mál"
  for (const [w, whole] of [["umhverfismál", "umhverfismál"], ["meðalhóf", "meðalhóf"], ["umhverfisráðherra", "umhverfisráðherra"], ["innanríkisráðherra", "innanríkisráðherra"]] as const) {
    expect(queryGroupsStructured(w)).toEqual([{ any: [whole], allOf: null }]);
  }
  // multi-word lemmas from ellipsis compounds are split and stopword-filtered like the index side
  expect(queryGroups("umhverfis- og samgöngunefnd").flat()).not.toContain(" og samgöngunefnd");
});

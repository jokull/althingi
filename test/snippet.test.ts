import { describe, expect, test } from "bun:test";
import { snippetFromTokens } from "../src/snippet.ts";
import { tokenStream } from "../src/lemma.ts";

const prep = (text: string) => {
  const t = tokenStream(text);
  return { text, tok: { lemma: t.map((x) => x.lemma), start: t.map((x) => x.start), len: t.map((x) => x.len) } };
};

describe("snippetFromTokens (stored tokens, no lemma-is per hit)", () => {
  test("highlights inflected matches by their stored lemma and keeps exact original text", () => {
    const { text, tok } = prep("Ég sá hestana í haganum og hestinn hans Jóns við ána.");
    const s = snippetFromTokens(text, tok, ["hestur"])!;
    expect(s.length).toBe(1);
    const hl = s[0]!.segments.filter((x) => x.highlight).map((x) => x.text);
    expect(hl).toEqual(["hestana", "hestinn"]);
    // segments reassemble to the exact source slice
    expect(s[0]!.segments.map((x) => x.text).join("")).toBe(text.slice(s[0]!.start, s[0]!.end));
  });

  test("a compound containing the query word is highlighted (lán in húsnæðislán)", () => {
    const { text, tok } = prep("Húsnæðislán hafa hækkað mikið á þessu ári.");
    const s = snippetFromTokens(text, tok, ["lán"])!;
    expect(s[0]!.segments.filter((x) => x.highlight).map((x) => x.text)).toEqual(["Húsnæðislán"]);
  });

  test("stem match through linking vowels: lögregla ~ lögreglumaður, verðbólga ~ verðbólgumarkmið", () => {
    const a = prep("Lögreglumaður kom á staðinn og lögreglan fór heim.");
    expect(snippetFromTokens(a.text, a.tok, ["lögregla"])![0]!.segments.filter((x) => x.highlight).map((x) => x.text)).toEqual(["Lögreglumaður", "lögreglan"]);
    const b = prep("Nýtt verðbólgumarkmið var kynnt í dag.");
    expect(snippetFromTokens(b.text, b.tok, ["verðbólga"])![0]!.segments.some((x) => x.highlight && x.text === "verðbólgumarkmið")).toBe(true);
  });

  test("no matching stored token -> null so the caller falls back to lemma-is", () => {
    const { text, tok } = prep("Ég sá hesta.");
    expect(snippetFromTokens(text, tok, ["kýr"])).toBeNull();
  });

  test("long paragraph: window around the densest match, ellipses, and a second non-overlapping snippet", () => {
    const filler = (n: number) => Array.from({ length: n }, () => "orð").join(" ");
    const { text, tok } = prep(`${filler(60)} hestur og hestur ${filler(80)} hestur ${filler(40)}`);
    const s = snippetFromTokens(text, tok, ["hestur"], { words: 20, max: 2 })!;
    expect(s.length).toBe(2);
    expect(s[0]!.text.startsWith("…")).toBe(true);
    expect(s[0]!.end).toBeLessThanOrEqual(s[1]!.start);
  });
});

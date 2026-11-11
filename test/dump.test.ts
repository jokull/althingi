import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ballotChoice, debateCode, dumpSpeechId, parseDagskra, parseDumpSpeech, parseFjarvist, parseFundur, parseInn, parseLidaskjal,
  parseUtbyting, speechType,
} from "../src/dump.ts";

const fx = (p: string) => readFileSync(new URL(`../fixtures/dump/157/${p}`, import.meta.url), "utf8");

describe("dump parsers", () => {
  test("ns:-prefixed speech file: index fields + text in one pass", () => {
    const s = parseDumpSpeech("rad20250911T104951.xml", fx("raedur/rad20250911T104951.xml"));
    expect(s.fileId).toBe("rad20250911T104951");
    expect(s).toMatchObject({ lthing: 157, fundur: 3, speakerAbbr: "DMK", office: "fjmrh.", tegr: "A", type: "andsvar" });
    expect(s.matter).toMatchObject({ nr: 1, cls: "A", title: "fjárlög 2026" });
    expect(s.paragraphs.length).toBeGreaterThan(0);
  });

  test("speech id comes from the file name, tolerating a leading space or a missing rad prefix", () => {
    expect(dumpSpeechId(" rad20250911T110053.xml", { id: "rad20250911T110100" })).toBe("rad20250911T110053");
    expect(dumpSpeechId("20250915T150039.xml", { id: "x" })).toBe("rad20250915T150039");
    expect(dumpSpeechId("odd.xml", { id: "rad20250915T150039" })).toBe("rad20250915T150039");
  });

  test("NFD abbreviations come out NFC", () => {
    const xml = readFileSync(new URL("../fixtures/dump-nfd/157/raedur/rad20260427T184758.xml", import.meta.url), "utf8");
    expect(xml.includes("Á")).toBe(true);
    const s = parseDumpSpeech("rad20260427T184758.xml", xml);
    expect(s.speakerAbbr).toBe("ÁLÞ");
    expect(s.speakerAbbr).toBe(s.speakerAbbr!.normalize("NFC"));
  });

  test("decoders", () => {
    expect(speechType("B")).toBe("ber af sér sakir");
    expect(speechType("Q")).toBe("óþekkt (Q)");
    expect(debateCode("1f")).toBe("1");
    expect(debateCode("*")).toBe("*");
    expect(ballotChoice("greiðir_ekki_atkv")).toBe("greiðir ekki atkvæði");
  });

  test("lidaskjal with ballots", () => {
    const l = parseLidaskjal(fx("lidaskjol/lid20251007T140445.xml"));
    expect(l).toMatchObject({ lthing: 157, fundur: 13 });
    expect(l.matter).toMatchObject({ nr: 137, cls: "A", kind: "b" });
    expect(l.matter!.sponsors.map((s) => s.abbr).slice(0, 3)).toEqual(["DBE", "ArnaJ", "ÁBH"]);
    const v = l.parts[0]!.votes[0]!;
    expect(v).toMatchObject({ id: 68227, docNr: 140, methodCode: "S", kindCode2: "bn", yes: 37, no: 0, absent: 26, abstain: 0, unanimous: true });
    expect(v.ballots.length).toBe(63);
    expect(v.ballots.filter((b) => b.choice === "já").length).toBe(37);
  });

  test("ns:-prefixed lidaskjal parses like a plain one", () => {
    const l = parseLidaskjal(fx("lidaskjol/lid20251016T113756.xml"));
    expect(l.lthing).toBe(157);
    expect(l.parts.flatMap((p) => p.votes).length).toBeGreaterThan(0);
    expect(l.parts.flatMap((p) => p.votes).every((v) => v.ballots.length > 0 || v.methodCode !== "S")).toBe(true);
  });

  test("lidaskjal speech order with sponsor + office", () => {
    const l = parseLidaskjal(fx("lidaskjol/lid20250912T130054.xml"));
    expect(l.matter!.sponsors).toEqual([{ abbr: "DMK", office: "fjmrh." }]);
    expect(l.matter!.debate).toBe("1f");
    const sp = l.parts.flatMap((p) => p.speeches);
    expect(sp[0]).toMatchObject({ abbr: "AMöll", started: "2025-09-12T13:01:33", tegr: "R", office: "heilbrrh." });
  });

  test("fundir: items and timeline events", () => {
    const d = parseFundur(fx("fundir/fun020.xml"));
    expect(d).toMatchObject({ lthing: 157, fundur: 20, ends: "2025-10-16T15:39:06" });
    expect(d.items[0]!.lidId).toBe("lid20251016T113756");
    expect(d.events.filter((e) => e.kind === "frvAfgreittSemLög").length).toBeGreaterThan(0);
    expect(d.events.find((e) => e.kind === "frvAfgreittSemLög")!.docNr).toBe(207);
  });

  test("dagskra, utbyting, fjarvistir, inn", () => {
    const a = parseDagskra(fx("dagskra/dag009.xml"));
    expect(a.fundur).toBe(9);
    expect(a.items.find((i) => i.matter?.nr === 106)).toMatchObject({ docNr: 106, offAgenda: false });
    expect(a.items.filter((i) => i.parentSeq !== null).length).toBe(4);
    const u = parseUtbyting(fx("utbyting/utb20251006T150022.xml"));
    expect(u.docs.find((d) => d.nr === 156)).toMatchObject({ type: "svar", matterNr: 93, sponsors: [{ abbr: "DMK", office: "fjmrh." }] });
    expect(parseFjarvist(fx("fjarvistir/fja019.xml")).people.map((p) => p.abbr)).toEqual(["IngD", "KFrost", "LE"]);
    expect(parseInn(fx("inn/inn009.xml")).people.length).toBe(3);
  });

  test("provisional speech file parses with the same parser", () => {
    const s = parseDumpSpeech("rad20260209T163926.xml", fx("raedur_bradabirgda/rad20260209T163926.xml"));
    expect(s).toMatchObject({ fileId: "rad20260209T163926", speakerAbbr: "VilÁ", type: "andsvar" });
  });
});

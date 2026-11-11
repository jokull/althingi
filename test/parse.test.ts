import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CAPACITY,
  parseCommittees,
  parseMatterDetail,
  decodeCapacity,
  parseMatterList,
  parseMembers,
  parseSeats,
  parseSessions,
  parseSpeechList,
  parseSpeechText,
} from "../src/parse.ts";

const fx = (p: string) => readFileSync(new URL(`../fixtures/${p}`, import.meta.url), "utf8");

describe("speech text", () => {
  test("plain variant (2025): paragraphs, ids, matter", () => {
    const s = parseSpeechText(fx("sample/speech_d_rad20251021T133058_xml.xml"));
    expect(s.id).toBe("rad20251021T133058");
    expect(s.lthing).toBe(157);
    expect(s.paragraphs.length).toBeGreaterThan(0);
    expect(s.paragraphs.every((p) => p.text.length > 0)).toBe(true);
  });

  test("namespace-prefixed variant (ns:) yields paragraphs, not zero", () => {
    const s = parseSpeechText(fx("sample/speech_d_rad20251021T141933_xml.xml"));
    expect(s.id).toBe("rad20251021T141933");
    expect(s.paragraphs.length).toBe(1);
    expect(s.matter).toEqual({ nr: 69, cls: "A", kind: "l", title: "sjúkraskrár" });
    expect(s.paragraphs[0]!.text.startsWith("Virðulegur forseti.")).toBe(true);
    // hard-wrapped lines are collapsed
    expect(s.paragraphs.every((p) => !/\s{2,}|\n/.test(p.text))).toBe(true);
  });

  test("interjections are separated from the indexed text", () => {
    const s = parseSpeechText(fx("sample/speech_d20180306_rad20180306T133436_xml.xml"));
    const withInterj = s.paragraphs.filter((p) => p.interjections.length > 0);
    expect(withInterj.length).toBe(1);
    expect(withInterj[0]!.interjections).toEqual(["Heyr, heyr."]);
    expect(withInterj[0]!.text).not.toContain("Heyr");
  });

  test("processing-instruction-only interjection is dropped, text stays joined", () => {
    const s = parseSpeechText(fx("sample/speech_p20100309_rad20100309T140739_xml.xml"));
    const all = s.paragraphs.map((p) => p.text).join(" ");
    expect(all).not.toContain("xm-replace_text");
    expect(s.paragraphs.flatMap((p) => p.interjections)).toEqual([]);
    expect(all).toContain("Þau skilja ekki einföld pólitísk skilaboð.");
  });

  test("nefnd, continued and capacity decode (tegflm)", () => {
    const committee = parseSpeechText(fx("sample/speech_d_rad20251021T143227_xml.xml"));
    expect(committee.nefnd).toBe("vf");
    expect(committee.tegflm).toBe("N");
    expect(decodeCapacity(committee.tegflm)).toBe("framsögumaður nefndarálits");
    expect(committee.continued).toBe(false);
    const plain = parseSpeechText(fx("sample/speech_d_rad20251021T141933_xml.xml"));
    expect(plain.nefnd).toBeNull();
    expect(decodeCapacity(plain.tegflm)).toBe("þingmaður");
    expect(decodeCapacity(undefined)).toBeNull();
    expect(decodeCapacity("?")).toBeNull();
    expect(CAPACITY["L"]!.confidence).toBe("low");
    expect(CAPACITY["Þ"]!.confidence).toBe("high");
  });

  test("CDATA inside a paragraph is text (defensive: none seen in 680 real speeches)", () => {
    const xml = `<?xml version="1.0"?><ræða id="r2025-01-02T03:04:05" skst="X"><umsýsla fundur="1" tími="2025-01-02T03:04:05" lgþ="157"></umsýsla><ræðutexti><mgr>Halló <![CDATA[heimur & <vinir>]]> bless.</mgr></ræðutexti></ræða>`;
    expect(parseSpeechText(xml).paragraphs[0]!.text).toBe("Halló heimur & <vinir> bless.");
  });

  test("every sampled speech parses with a stable id matching its filename", () => {
    const { readdirSync } = require("node:fs");
    const files: string[] = readdirSync(new URL("../fixtures/sample/", import.meta.url)).filter((f: string) =>
      /^speech_.*_rad\d{8}T\d{6}_xml\.xml$/.test(f),
    );
    expect(files.length).toBeGreaterThan(15);
    for (const f of files) {
      const s = parseSpeechText(fx(`sample/${f}`));
      expect(f).toContain(s.id);
      expect(s.paragraphs.length).toBeGreaterThan(0);
    }
  });
});

describe("speech lists", () => {
  test("2018 day: counts, types, útbýting excluded as speech", () => {
    const l = parseSpeechList(fx("days/d20180306.xml"));
    expect(l.length).toBe(84);
    expect(l.filter((e) => !e.isSpeech).length).toBe(3);
    expect(l.filter((e) => e.type === "grein fyrir atkvæði").length).toBe(20);
    expect(l.filter((e) => e.isSpeech).every((e) => e.id !== null)).toBe(true);
    expect(l.filter((e) => !e.isSpeech).every((e) => e.id === null)).toBe(true);
    expect(new Set(l.map((e) => e.date))).toEqual(new Set(["2018-03-06"]));
  });

  test("útbýting entries have no matter; B-mál carry class B", () => {
    const l = parseSpeechList(fx("days/d20180306.xml"));
    expect(l.filter((e) => !e.isSpeech).every((e) => e.matter === null)).toBe(true);
    const b = l.filter((e) => e.matter?.cls === "B");
    expect(b.length).toBe(15);
  });

  test("speaker roles", () => {
    const l = parseSpeechList(fx("sample/../days/d.xml"));
    expect(l.some((e) => e.roleKind === "ráðherra")).toBe(true);
    expect(l.some((e) => e.roleKind === "forseti")).toBe(true);
  });

  test("SGML era (1999): kept as an index with stable sgml ids; no XML url", () => {
    const l = parseSpeechList(fx("days/d19990302.xml"));
    expect(l.length).toBe(43);
    const speeches = l.filter((e) => e.isSpeech);
    expect(speeches.length).toBe(39);
    expect(speeches.every((e) => e.era === "sgml" && e.xmlUrl === null && e.sourceUrl !== null)).toBe(true);
    // /altext/123/03/r02133209.sgml -> sgml123_03_r02133209 (stem alone repeats across months)
    expect(speeches[0]!.id).toBe("sgml123_03_r02133209");
    expect(new Set(speeches.map((e) => e.id)).size).toBe(speeches.length);
  });

  test("matter slóðir is not mistaken for the speech slóðir", () => {
    const l = parseSpeechList(fx("sample/../days/d19990302.xml"));
    // in 1999 the <mál><slóðir><xml> points at a matter page, which must not become the speech xml url
    expect(l.every((e) => e.xmlUrl === null)).toBe(true);
  });

  test("2005 era is XML with svar type", () => {
    const l = parseSpeechList(fx("days/p20050302.xml"));
    expect(l.some((e) => e.type === "svar")).toBe(true);
    expect(l.filter((e) => e.isSpeech).every((e) => e.id !== null && e.era === "xml")).toBe(true);
  });

  test("per-member list spans eras (MP 7: SGML majority)", () => {
    const l = parseSpeechList(fx("sample/thingmadur_raedur_7.xml"));
    expect(l.length).toBe(2110);
    expect(new Set(l.map((e) => e.memberId))).toEqual(new Set([7]));
    expect(l.filter((e) => e.era === "xml").length).toBe(103);
  });
});

describe("members, seats, matters, sessions", () => {
  test("members 157", () => {
    const m = parseMembers(fx("sample/thingmenn_157.xml"));
    expect(m.length).toBe(114);
    expect(m.find((x) => x.id === 1547)).toMatchObject({ name: "Aðalsteinn Leifsson", abbr: "ALeif" });
  });

  test("seats carry party with dates; party changes over time", () => {
    const s = parseSeats(fx("sample/thingseta_633.xml"));
    expect(s.length).toBe(51);
    expect(new Set(s.map((x) => x.party))).toContain("Samfylkingin");
    expect(new Set(s.map((x) => x.party))).toContain("Samtök um kvennalista");
    expect(s.every((x) => x.memberId === 633)).toBe(true);
    const old = parseSeats(fx("sample/thingseta_7.xml"));
    expect(old[0]).toMatchObject({ lthing: 115, kind: "varamaður", party: "Alþýðuflokkur", from: "1991-10-08", to: "1991-10-30" });
    // constituency is a CDATA section in the source; it was silently empty before the CDATA fix
    expect(old[0]!.constituency).toBe("Reykjanes");
    expect(s.every((x) => x.constituency && x.constituency.length > 3)).toBe(true);
  });

  test("matters 157 and 131", () => {
    const m = parseMatterList(fx("sample/thingmalalisti_157.xml"));
    expect(m.length).toBe(1070);
    expect(m[0]).toMatchObject({ lthing: 157, nr: 1, cls: "A", title: "fjárlög 2026", typeCode: "l", typeLabel: "Frumvarp til laga" });
    expect(parseMatterList(fx("sample/thingmalalisti_131.xml")).length).toBe(922);
  });

  test("sessions", () => {
    const s = parseSessions(fx("lthing.xml"));
    expect(s.length).toBe(158);
    expect(s.find((x) => x.lthing === 157)).toMatchObject({ start: "2025-09-09", hasRecord: true });
    expect(s.find((x) => x.lthing === 20)).toMatchObject({ start: "1907-07-01" });
  });
});

describe("matter detail", () => {
  // expected counts were cross-checked with independent regex counts over the same files
  test("157/A/300: law matter with consultations, submissions, votes with counts, related and amended laws", () => {
    const d = parseMatterDetail(fx("sample/thingmal_157_300.xml"));
    expect(d).toMatchObject({ lthing: 157, cls: "A", nr: 300, typeCode: "l", statusText: "Samþykkt sem lög frá Alþingi." });
    expect(d.documents.length).toBe(7);
    expect(d.documents[0]).toMatchObject({ nr: 421, type: "stjórnarfrumvarp" });
    expect(d.votes.length).toBe(36);
    expect(d.votes.filter((v) => v.yes !== null).length).toBe(29); // electronic votes carry counts
    expect(d.votes[0]).toMatchObject({ id: 68958, kindCode: "v2", docNr: 421, method: "yfirlýsing forseta/mál gengur", yes: null });
    expect(d.consultations.length).toBe(38);
    expect(d.consultations[0]).toMatchObject({ roundId: 12917, recipient: "Eleven Experience á Íslandi", committeeId: 202, due: "2026-01-29" });
    // rounds, not recipients, carry the number: 38 recipients, 2 rounds
    expect(new Set(d.consultations.map((c) => c.roundId)).size).toBe(2);
    expect(d.submissions.length).toBe(17);
    expect(d.submissions[0]).toMatchObject({ id: 1393, sender: "Atvinnuvegaráðuneyti", committeeId: 202, kindCode: "ky" });
    expect(d.laws).toEqual([{ year: 1991, nr: 34 }]); // the matter amends lög nr. 34/1991
    expect(d.links).toEqual([{ kind: "lagtFramÁðurSem", lthing: 154, cls: "A", nr: 726, title: expect.stringContaining("rýni á fjárfestingum") }]);
    expect(d.topics.length).toBe(4);
    expect(d.rapporteurs).toEqual([{ memberId: 1004, name: "Arna Lára Jónsdóttir" }]);
  });

  test("157/A/1 (budget): 122 votes, 231 submissions, skyltMál relation", () => {
    const d = parseMatterDetail(fx("sample/thingmal_157_1.xml"));
    expect(d.title).toBe("fjárlög 2026");
    expect(d.votes.length).toBe(122);
    expect(d.votes.filter((v) => v.yes !== null).length).toBe(116);
    expect(d.votes.find((v) => v.id === 68539)).toMatchObject({ kindCode: "as", docNr: 462, method: "atkvæðagreiðslukerfi", yes: 33, no: 0, abstain: 0, result: "samþykkt" });
    expect(d.submissions.length).toBe(231);
    expect(d.documents.length).toBe(23);
    expect(d.links.map((l) => `${l.kind}:${l.lthing}/${l.cls}/${l.nr}`)).toEqual(["skyltMál:157/A/317"]);
  });

  test("old-era question (131/A/100): status text, no votes or consultations", () => {
    const d = parseMatterDetail(fx("sample/thingmal_131_100.xml"));
    expect(d).toMatchObject({ lthing: 131, nr: 100, typeCode: "m", statusText: "Fyrirspurninni var svarað munnlega.", questionTo: "menntamálaráðherra" });
    expect(d.documents.length).toBe(1);
    expect(d.votes).toEqual([]);
    expect(d.consultations).toEqual([]);
  });

  test("committees", () => {
    const c = parseCommittees(fx("sample/nefndir_157.xml"));
    expect(c.length).toBe(20);
    expect(c[0]).toEqual({ id: 201, name: "allsherjar- og menntamálanefnd", abbr: "am", abbrLong: "allsh.- og menntmn.", firstLthing: 140 });
  });
});

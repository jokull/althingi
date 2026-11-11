import { describe, expect, test } from "bun:test";
import { interpret, sameWord } from "../src/intent.ts";

const ctx = {
  members: [
    { id: 1417, name: "Kristrún Frostadóttir" }, { id: 1332, name: "Inga Sæland" }, { id: 729, name: "Sigmundur Davíð Gunnlaugsson" },
    { id: 1327, name: "Bergþór Ólason" }, { id: 9, name: "Dagur B. Eggertsson" },
  ],
  parties: [{ id: 38, name: "Samfylkingin" }, { id: 46, name: "Flokkur fólksins" }, { id: 47, name: "Miðflokkurinn" }, { id: 45, name: "Viðreisn" }, { id: 17, name: "utan þingflokka" }],
  today: new Date(Date.UTC(2026, 10, 11)), // Wednesday 11 Nov 2026
  currentLthing: 157,
};
const it = (q: string) => interpret(q, ctx);

describe("intent", () => {
  test("inflected names match", () => {
    expect(sameWord("Kristrúnar", "Kristrún")).toBe(true);
    expect(sameWord("Frostadóttur", "Frostadóttir")).toBe(true);
    expect(sameWord("Miðflokksins", "Miðflokkurinn")).toBe(true);
    expect(sameWord("barnsins", "B.")).toBe(false);
    expect(sameWord("J.", "Jóhann")).toBe(true);
  });

  test("member + topic + relative week; question filler dropped", () => {
    const r = it("Hvað sagði Kristrún Frostadóttir um Landspítala í þessari viku?");
    expect(r).toMatchObject({ memberId: 1417, q: "Landspítala", dateFrom: "2026-11-09", dateTo: "2026-11-11", changed: true });
  });

  test("today, debate filler and sort words", () => {
    expect(it("veiðigjöldin umræða í dag")).toMatchObject({ q: "veiðigjöldin", dateFrom: "2026-11-11", dateTo: "2026-11-11" });
    expect(it("vindorka vindorkuver nýjast fyrst")).toMatchObject({ q: "vindorka vindorkuver", sort: "newest" });
    expect(it("Hver sagði fyrst orkuskortur")).toMatchObject({ q: "orkuskortur", sort: "oldest" });
    expect(it("forsætisráðherra síðustu viku")).toMatchObject({ q: "", office: "forsrh.", dateFrom: "2026-11-02", dateTo: "2026-11-08" });
  });

  test("member + type + month; a speaker title keeps the addressed member as text", () => {
    expect(it("Inga Sæland fundarstjórn október 2026")).toMatchObject({ q: "", memberId: 1332, type: "um fundarstjórn", dateFrom: "2026-10-01", dateTo: "2026-10-31" });
    expect(it("Bergþór Ólason andsvar")).toMatchObject({ q: "", memberId: 1327, type: "andsvar" });
    const pm = it("forsætisráðherra andsvar Sigmundur Davíð");
    expect(pm).toMatchObject({ office: "forsrh.", type: "andsvar", q: "Sigmundur Davíð" });
    expect(pm.memberId).toBeUndefined();
  });

  test("party names in the query, inflected; a lone party name is left alone", () => {
    expect(it("Samfylkingin húsnæðismál")).toMatchObject({ partyId: 38, q: "húsnæðismál" });
    expect(it("ræður Flokks fólksins um öryrkja")).toMatchObject({ partyId: 46 });
    expect(it("Flokkur fólksins").changed).toBe(false);
    expect(it("viðreisn efnahagslífsins").partyId).toBeUndefined();
  });

  test("matter numbers inside a sentence", () => {
    expect(it("umsagnir 300. mál")).toMatchObject({ matter: { lthing: 157, cls: "A", nr: 300 }, matterSection: "umsagnir" });
    expect(it("hverjir studdu 412. mál")).toMatchObject({ matter: { nr: 412 }, matterSection: "atkvaedi" });
    expect(it("Flokkur fólksins atkvæði 300. mál")).toMatchObject({ matterSection: "atkvaedi" });
    const m = it("meðalhóf 300. mál");
    expect(m).toMatchObject({ q: "meðalhóf", matter: { nr: 300 } });
    expect(m.matterSection).toBeUndefined();
    expect(it("framsöguræða ráðherra 1. umræða 300. mál")).toMatchObject({ debate: "1", type: "flutningsræða", capacity: "ráðherra", matter: { nr: 300 } });
  });

  test("things that must stay word searches", () => {
    for (const q of ["fjárlög 2026", "hvað er andsvar", "Kristrún Frostadóttir", "veiðigjald", "dagur barnsins", "\"í dag\""]) expect(it(q).changed).toBe(false);
    expect(it("hvað sagði þingmaðurinn minn um leikskóla")).toMatchObject({ q: "leikskóla", changed: true });
  });
});

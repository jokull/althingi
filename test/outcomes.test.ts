import { describe, expect, test } from "bun:test";
import { finalVoteIndex, matterStatus, voteResult } from "../src/outcomes.ts";
import { sessionRanges } from "../src/mcp-tools.ts";

const v = (o: Partial<Parameters<typeof voteResult>[0]>) => voteResult({ method: null, method_code: null, result: null, yes: null, no: null, abstain: null, ...o });

describe("derived vote results", () => {
  test("source result wins; counted votes by yes > no (a tie fails); K/E by method; procedural votes stay empty", () => {
    expect(v({ result: "Fellt", yes: 40, no: 1, method_code: "S" })).toEqual({ result: "Fellt", result_derived: false });
    expect(v({ method_code: "S", yes: 37, no: 25 })).toEqual({ result: "samþykkt", result_derived: true });
    expect(v({ method: "nafnakall", yes: 18, no: 35 })).toEqual({ result: "Fellt", result_derived: true });
    expect(v({ method_code: "S", yes: 20, no: 20 }).result).toBe("Fellt");
    expect(v({ method_code: "K", yes: 0, no: 0 }).result).toBe("kallað aftur");
    expect(v({ method_code: "E" }).result).toBe("kom ekki til atkvæðagreiðslu");
    expect(v({ method_code: "G", method: "yfirlýsing forseta/mál gengur", yes: 0, no: 0 })).toEqual({ result: null, result_derived: false });
    expect(v({ method_code: "S", yes: 0, no: 0, abstain: 0 }).result).toBeNull();
  });

  test("final vote = the last whole-bill (lg) or whole-resolution (þa) vote", () => {
    expect(finalVoteIndex([{ code: "v2" }, { code: "lg" }, { code: "gr" }, { code: "lg" }, { code: "n3" }])).toBe(3);
    expect(finalVoteIndex([{ code: "þa" }])).toBe(0);
    expect(finalVoteIndex([{ code: "gr" }, { code: null }])).toBe(-1);
  });

  test("status: source text, then the passed-as-law event, then a passed final vote; nothing negative", () => {
    expect(matterStatus("Bíður 1. umræðu.", true, null)).toEqual({ status: "Bíður 1. umræðu.", status_source: "althingi" });
    expect(matterStatus(null, true, null)).toEqual({ status: "Samþykkt sem lög frá Alþingi.", status_source: "sitting_event" });
    expect(matterStatus("", false, { code: "þa", result: "samþykkt" })).toEqual({ status: "Samþykkt sem ályktun Alþingis.", status_source: "final_vote" });
    expect(matterStatus(null, false, { code: "lg", result: "Fellt" })).toEqual({ status: null, status_source: null });
  });

  test("corpus session ranges", () => {
    expect(sessionRanges([131, 132, 133, 149, 150, 157])).toBe("131–133, 149–150, 157");
    expect(sessionRanges([])).toBe("");
  });
});

// "What did we search for?" — the expanded query as data, for the UI chip and the MCP explain_query tool.
import { isStopword } from "lemma-is";
import { queryGroups, queryGroupsStructured, seqLemmas, tokenStream } from "./lemma.ts";

export interface QueryPart {
  /** quoted phrase (adjacent lemmas) or a plain word group */
  kind: "phrase" | "word";
  /** the user's text for this part */
  text: string;
  /** word: alternative lemmas of the whole word (OR). phrase: the ordered lemmas that must be adjacent. */
  lemmas: string[];
  /** word only: compound alternative — one OR-group per part, all parts must be present */
  allOf?: string[][];
}

export interface ParsedQuery {
  parts: QueryPart[];
  /** words ignored as stopwords (shown to the user, never silently dropped) */
  dropped: string[];
  /** plain integers in the query ("fjárlög 2026"): lemma-is skips numbers, so they filter on the surface text instead */
  numbers: string[];
  /** true when there is nothing searchable */
  empty: boolean;
}

/** Split `"quoted phrases"` from free words, lemmatize both with the same functions the index uses. */
export function parseQuery(raw: string): ParsedQuery {
  const q = raw.trim().slice(0, 200);
  const parts: QueryPart[] = [];
  const dropped: string[] = [];
  const numbers = [
    ...new Set(
      tokenStream(q.replace(/"/g, " "))
        .filter((t) => t.kind === "number" && /^\d{1,6}$/.test(t.surface))
        .map((t) => t.surface),
    ),
  ];

  const phraseRe = /"([^"]+)"/g;
  let rest = q;
  for (const m of q.matchAll(phraseRe)) {
    const text = m[1]!.trim();
    const lemmas = seqLemmas(text);
    if (lemmas.length > 0) parts.push({ kind: "phrase", text, lemmas });
    rest = rest.replace(m[0], " ");
  }
  rest = rest.replace(/"/g, " ").trim();
  if (rest) {
    const groups = queryGroupsStructured(rest);
    const words = tokenStream(rest).filter((t) => t.kind === "word");
    for (const g of groups) {
      parts.push({ kind: "word", text: g.any[0] ?? "", lemmas: g.any, ...(g.allOf ? { allOf: g.allOf } : {}) });
    }
    for (const t of words) if (isStopword(t.lemma)) dropped.push(t.surface);
  }
  return { parts: parts.filter((x) => x.lemmas.length > 0 || (x.allOf?.length ?? 0) > 0), dropped: [...new Set(dropped)], numbers, empty: parts.every((x) => x.lemmas.length === 0 && !x.allOf?.length) };
}

/** Human-readable form, e.g. `(húsnæði | húsnæðislán) & vextir & "hér land"`. */
export function describe(p: ParsedQuery): string {
  return p.parts
    .map((x) => {
      if (x.kind === "phrase") return `"${x.lemmas.join(" ")}"`;
      const alts = [...x.lemmas, ...(x.allOf ? [`(${x.allOf.map((g) => (g.length > 1 ? `(${g.join(" | ")})` : g[0])).join(" & ")})`] : [])];
      return alts.length > 1 ? `(${alts.join(" | ")})` : alts[0];
    })
    .concat(p.numbers.map((n) => `"${n}"`))
    .join(" & ");
}

// The ONE place lemma-is is configured. Ingest and query both import from here so the two sides
// cannot drift (docs: "same lemmatizer at index and query time").
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  BinaryLemmatizer,
  CompoundSplitter,
  type ProcessOptions,
  buildSearchQuery,
  createKnownLemmaSet,
  extractIndexableLemmas,
  extractSnippets,
  processText,
  type Snippet,
  isStopword,
} from "lemma-is";

const require = createRequire(import.meta.url);

/**
 * Bump when OUR indexing rules change (not lemma-is): reindex then rewrites everything from stored text.
 * r2: lemma_seq keeps stopwords (exact phrases); compound parts go to a separate low-weight field.
 * r3: lemma_text / lemma_parts keep one entry PER OCCURRENCE (a multiset): the ranker can see term frequency.
 *     (lemma-is returns a Set; a paragraph mentioning lögreglustjóri three times ranked like one mentioning it once.)
 */
const INDEX_REV = 3;

interface Engine {
  lem: BinaryLemmatizer;
  opts: ProcessOptions;
  version: string;
}

let engine: Engine | undefined;

function load(): Engine {
  if (engine) return engine;
  const binPath = process.env.LEMMA_BIN ?? require.resolve("lemma-is/data/lemma-is.bin");
  const buf = readFileSync(binPath);
  const sha = createHash("sha256").update(buf).digest("hex").slice(0, 12);
  // slice() hands loadFromBuffer a view of the file's ArrayBuffer instead of a copy
  const lem = BinaryLemmatizer.loadFromBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const splitter = new CompoundSplitter(lem, createKnownLemmaSet(lem.getAllLemmas()));
  const pkgVersion = (require("lemma-is/package.json") as { version: string }).version;
  engine = {
    lem,
    opts: { bigrams: lem, compoundSplitter: splitter, removeStopwords: true },
    version: `lemma-is@${pkgVersion}+${sha}/r${INDEX_REV}`,
  };
  return engine;
}

/** Stored per speech so a lemma-is upgrade can be detected and re-indexed. */
export const lemmaVersion = (): string => load().version;

/**
 * Index side: unique lowercased single-word lexemes of `text`, in first-seen order.
 * lemma-is can emit multi-word lemmas for hyphenated ellipsis compounds ("hljóð- og myndmiðlun");
 * Postgres would split those on whitespace anyway and bring stopwords ("og") back, so split here,
 * strip dangling hyphens and re-apply the stopword filter. The part lexemes ("myndmiðlun") are kept.
 */
export function indexLemmas(text: string): string[] {
  const { lem, opts } = load();
  const out = new Set<string>();
  for (const l of extractIndexableLemmas(text, lem, opts)) {
    for (const raw of l.toLowerCase().split(/\s+/)) {
      const part = raw.replace(/^-+|-+$/g, "");
      if (part && !isStopword(part)) out.add(part);
    }
  }
  return [...out];
}

/** Whole-word lemmas and compound-part lemmas separately: parts are indexed at the lowest weight. */
export function indexLemmaSets(text: string): { whole: string[]; parts: string[] } {
  const { lem, opts } = load();
  const norm = (set: Iterable<string>) => {
    const out = new Set<string>();
    for (const l of set) {
      for (const raw of l.toLowerCase().split(/\s+/)) {
        const part = raw.replace(/^-+|-+$/g, "");
        if (part && !isStopword(part)) out.add(part);
      }
    }
    return out;
  };
  // without the splitter: exactly what the words themselves are; with it: plus constituents
  const { compoundSplitter: _omit, ...noSplit } = opts;
  void _omit;
  const whole = norm(extractIndexableLemmas(text, lem, noSplit));
  const all = norm(extractIndexableLemmas(text, lem, opts));
  return { whole: [...whole], parts: [...all].filter((x) => !whole.has(x)) };
}

/**
 * The same indexing rules as lemma-is extractIndexableLemmas (skip entities and stopword surface forms; every candidate
 * lemma of a token; compound constituents), but one entry per OCCURRENCE instead of a Set, so term frequency reaches the
 * tsvector positions. Compound parts (weight D) are kept apart from whole-word lemmas (weight A).
 */
export function indexLemmaMultiset(text: string): { whole: string[]; parts: string[] } {
  const { lem, opts } = load();
  const whole: string[] = [];
  const parts: string[] = [];
  const pieces = (l: string) => l.toLowerCase().split(/\s+/).map((x) => x.replace(/^-+|-+$/g, "")).filter((x) => x && !isStopword(x));
  for (const t of processText(text, lem, opts)) {
    if (t.isEntity) continue;
    if (isStopword(t.original)) continue;
    const partSet = new Set<string>();
    if (t.compoundSplit?.isCompound) for (const l of t.compoundLemmas ?? t.compoundSplit.parts) for (const x of pieces(l)) partSet.add(x);
    const seen = new Set<string>(); // a lemma listed twice for one token counts once for that token
    for (const l of t.lemmas) {
      for (const x of pieces(l)) {
        if (seen.has(x)) continue;
        seen.add(x);
        (partSet.has(x) ? parts : whole).push(x);
      }
    }
    for (const x of partSet) if (!seen.has(x)) { seen.add(x); parts.push(x); }
  }
  // a lexeme that is a whole-word candidate anywhere in the paragraph is not ALSO a part (keeps the two fields disjoint)
  const wholeSet = new Set(whole);
  return { whole, parts: parts.filter((x) => !wholeSet.has(x)) };
}

/** Space-joined whole-word lemmas + parts (used for short texts such as matter titles). */
export const lemmaText = (text: string): string => indexLemmas(text).join(" ");

/** Query side: per-token candidate groups (OR within a group, AND across groups). */
export function queryGroups(q: string): string[][] {
  const { lem, opts } = load();
  return buildSearchQuery(q, lem, opts).groups.map((g) => [...new Set(g.map((x) => x.toLowerCase()))]);
}

/** Escape one lexeme for a Postgres tsquery literal. */
const lex = (s: string): string => `'${s.replace(/'/g, "''").replace(/\\/g, "\\\\")}'`;

/** tsquery string for `to_tsquery('simple', …)`; null when the input has no indexable word. */
export function toTsQuery(groups: string[][]): string | null {
  const parts = groups
    .filter((g) => g.length > 0)
    .map((g) => (g.length === 1 ? lex(g[0]!) : `(${g.map(lex).join(" | ")})`));
  return parts.length ? parts.join(" & ") : null;
}

export const searchTsQuery = (q: string): string | null => toTsQuery(queryGroups(q));

export type { Snippet };

/** Highlighted excerpts of `doc` for query `q` (original text, with match segments). Call on the few hits only. */
export function snippets(q: string, doc: string, opts: { words?: number; max?: number } = {}): Snippet[] {
  const { lem, opts: base } = load();
  return extractSnippets(q, doc, lem, { ...base, snippetWords: opts.words ?? 30, maxSnippets: opts.max ?? 2 }).snippets;
}

// ---------------------------------------------------------------- ordered token stream (phrases, trends, word pages)

export interface Token {
  surface: string;
  /** best guess after disambiguation, lowercase */
  lemma: string;
  /** word class of that lemma for this surface form ('' when unknown) */
  pos: string;
  /** disambiguation confidence 0..1, -1 when not applicable (numbers, times…) */
  conf: number;
  start: number;
  len: number;
  kind: string;
}

/** All tokens in order (stopwords and numbers kept). Offsets index into `text`. */
export function tokenStream(text: string): Token[] {
  const { lem, opts } = load();
  const out: Token[] = [];
  for (const t of processText(text, lem, { ...opts, removeStopwords: false, includeNumbers: true, includeOffsets: true })) {
    if (t.kind !== "word" && t.kind !== "number" && t.kind !== "time" && t.kind !== "percent") continue;
    const lemma = (t.disambiguated ?? t.lemmas[0] ?? t.original).toLowerCase();
    const pos = t.kind === "word" ? (lem.lemmatizeWithPOS(t.original).find((x) => x.lemma.toLowerCase() === lemma)?.pos ?? "") : "";
    out.push({
      surface: t.original,
      lemma,
      pos: String(pos),
      conf: t.kind === "word" ? (t.confidence ?? -1) : -1,
      start: t.span?.start ?? 0,
      len: t.span ? t.span.end - t.span.start : t.original.length,
      kind: t.kind,
    });
  }
  return out;
}

/**
 * Sequence side of phrase search: best lemma per token, in order, ALL tokens kept (stopwords and numbers too).
 * Index side AND query side both call this, so "hér á landi" matches by exact adjacency of the same lexemes.
 */
export function seqFromTokens(tokens: Token[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    for (const raw of t.lemma.split(/\s+/)) {
      const part = raw.replace(/^-+|-+$/g, "");
      if (part) out.push(part); // stopwords stay: a quoted phrase is exact ("ekki er allt sem sýnist")
    }
  }
  return out;
}

export const seqLemmas = (text: string): string[] => seqFromTokens(tokenStream(text));

export interface Analysis {
  /** all-candidates whole-word lemmas, space-joined (feeds paragraphs.lemma_text, weight A) */
  lemmaText: string;
  /** compound constituents, space-joined (feeds paragraphs.lemma_parts, weight D) */
  lemmaParts: string;
  /** ordered best-guess lemmas of ALL tokens, space-joined (feeds paragraphs.lemma_seq) */
  lemmaSeq: string;
  tokens: Token[];
}

/** Everything the ingest side stores for one paragraph. */
export function analyze(text: string): Analysis {
  const tokens = tokenStream(text);
  const sets = indexLemmaMultiset(text);
  return { lemmaText: sets.whole.join(" "), lemmaParts: sets.parts.join(" "), lemmaSeq: seqFromTokens(tokens).join(" "), tokens };
}

// ---------------------------------------------------------------- query side, compound-aware

export interface QueryGroup {
  /** candidate lemmas of the whole word (OR) */
  any: string[];
  /**
   * Compound alternative: one OR-group per part, ALL parts must occur, e.g. verðbólga -> [[verð, verður, verða, verja], [bólga]].
   * Null when no clean two-part split can be reconstructed (then only the whole-word lemmas are used: never over-strict).
   */
  allOf: string[][] | null;
}

/**
 * lemma-is exposes only a flat list of part variants for a compound. Recover which variants belong to which part by
 * finding the split point whose two halves lemmatize to exactly those variants (linking s/a/u tolerated).
 */
function groupParts(lem: BinaryLemmatizer, words: string[], flat: string[]): string[][] | null {
  const want = new Set(flat);
  let best: { groups: string[][]; score: number } | null = null;
  for (const word of words) {
    for (let k = 2; k <= word.length - 2; k++) {
      for (const cut of [k, k - 1]) {
        // cut = end of the left part (k-1 drops a linking letter)
        if (cut < 2) continue;
        if (cut !== k && !"sau".includes(word[k - 1]!)) continue;
        const left = new Set(lem.lemmatize(word.slice(0, cut)).map((x) => x.toLowerCase()));
        const right = new Set(lem.lemmatize(word.slice(k)).map((x) => x.toLowerCase()));
        const l = flat.filter((x) => left.has(x));
        const r = flat.filter((x) => right.has(x));
        if (!l.length || !r.length) continue;
        const covered = new Set([...l, ...r]);
        if (![...want].every((x) => covered.has(x))) continue;
        const score = l.length + r.length;
        if (!best || score > best.score) best = { groups: [l, r], score };
      }
    }
  }
  return best?.groups ?? null;
}

/**
 * Like queryGroups, but compound parts are not independent alternatives. The index side adds the parts of every
 * compound (so "lán" finds "húsnæðislán"); the query side must not do the reverse, or "verðbólga" matches any
 * paragraph containing "verð", and "loftslagsmál" any paragraph containing "mál".
 * Shape: whole-word lemmas | ((part1 variants) & (part2 variants)).
 */
export function queryGroupsStructured(q: string): QueryGroup[] {
  const { lem, opts } = load();
  const groups = queryGroups(q);
  const toks = processText(q, lem, { ...opts, removeStopwords: false, includeNumbers: false }).filter(
    (t) => t.kind === "word" && t.compoundLemmas && t.compoundLemmas.length > 0,
  );
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  return groups.map((g): QueryGroup => {
    const t = toks.find((x) => same([...new Set(x.lemmas.map((l) => l.toLowerCase()))], g));
    if (!t) return { any: g, allOf: null };
    // A word the dictionary knows ("lögregla", "verðbólga") has its own indexed lemma; splitting it on the query side
    // would turn it into etymology ("lög & regla"). Parts are only an alternative for words BÍN does not know.
    if (lem.isKnown(t.original.toLowerCase()) || lem.isKnown(t.original)) return { any: g.filter((x) => !(t.compoundLemmas ?? []).map((l) => l.toLowerCase()).includes(x)) || g, allOf: null };
    const flat = [...new Set((t.compoundLemmas ?? []).map((l) => l.toLowerCase()))];
    const any = g.filter((x) => !flat.includes(x));
    const words = [...new Set([(t.disambiguated ?? t.lemmas[0] ?? t.original).toLowerCase(), t.original.toLowerCase()])];
    return { any: any.length ? any : g, allOf: groupParts(lem, words, flat) };
  });
}

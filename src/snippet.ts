// Fast snippets from the STORED token stream (paragraph_tokens): no lemma-is call per hit.
// Returns null when no token matches (e.g. the hit came from a non-best candidate reading), so the caller can
// fall back to lemma-is extractSnippets for that paragraph.
import type { Snippet } from "./lemma.ts";

export interface StoredTokens { lemma: string[]; start: number[]; len: number[] }

/** Does a stored best-guess lemma match one of the query lemmas? Exact, or a compound that contains the query word. */
function matches(lemma: string, wanted: Set<string>): boolean {
  if (wanted.has(lemma)) return true;
  if (lemma.length < 6) return false;
  for (const q of wanted) {
    if (q.length >= 3 && q.length < lemma.length - 1 && (lemma.endsWith(q) || lemma.startsWith(q))) return true;
    // linking vowels and inflected stems: lögregla ~ lögreglumaður, leikskóli ~ leikskólastarf, verðbólga ~ verðbólgumarkmið.
    // Highlight-only and the paragraph already matched the query, so a stem match is safe.
    if (q.length >= 6 && lemma.length > q.length - 1 && lemma.startsWith(q.slice(0, Math.max(5, q.length - 3)))) return true;
  }
  return false;
}

export function snippetFromTokens(
  text: string, tok: StoredTokens, wantedLemmas: Iterable<string>, opts: { words?: number; max?: number } = {},
): Snippet[] | null {
  const wanted = new Set([...wantedLemmas].map((x) => x.toLowerCase()));
  const hit: boolean[] = tok.lemma.map((l) => matches(l, wanted));
  if (!hit.some(Boolean)) return null;
  const W = opts.words ?? 30;
  const max = opts.max ?? 2;
  const n = tok.lemma.length;

  // greedy: best window of W tokens by match count, then the next best that does not overlap
  const prefix = [0];
  for (let i = 0; i < n; i++) prefix.push(prefix[i]! + (hit[i] ? 1 : 0));
  const taken: [number, number][] = [];
  const out: Snippet[] = [];
  for (let k = 0; k < max; k++) {
    let best = -1, bestScore = 0;
    for (let a = 0; a < n; a++) {
      const b = Math.min(n, a + W);
      if (taken.some(([x, y]) => a < y && b > x)) continue;
      const score = prefix[b]! - prefix[a]!;
      if (score > bestScore) { bestScore = score; best = a; }
    }
    if (best < 0) break;
    // center the window on its first match so the hit is not at the very edge
    const first = hit.indexOf(true, best);
    const a = Math.max(0, Math.min(first - 6, n - W)), b = Math.min(n, a + W);
    taken.push([a, b]);
    const start = tok.start[a]!, end = tok.start[b - 1]! + tok.len[b - 1]!;
    const segments: Snippet["segments"] = [];
    let pos = start;
    for (let i = a; i < b; i++) {
      if (!hit[i]) continue;
      const s = tok.start[i]!, e = s + tok.len[i]!;
      if (s > pos) segments.push({ text: text.slice(pos, s), highlight: false });
      segments.push({ text: text.slice(s, e), highlight: true });
      pos = e;
    }
    if (pos < end) segments.push({ text: text.slice(pos, end), highlight: false });
    const body = text.slice(start, end);
    out.push({
      text: `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`,
      segments, score: bestScore / Math.max(1, b - a), start, end,
    });
  }
  return out.length ? out : null;
}

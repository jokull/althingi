// Parsers for the law collection (lagasafn/zip/nuna/allt.zip, docs/INGEST.md §3 Laws). Pure: bytes/string in, rows out.
// Files are ISO-8859-1 HTML: `YYYYNNN.html` per law (sub-parts like `1979010.2c3.html` are skipped), `01.html`…`48.html`
// chapter indexes that also name the edition ("útgáfa 158a").

/** ISO-8859-1 bytes → string (WHATWG maps the label to windows-1252, a superset for the printable range). */
export const latin1 = (b: Uint8Array): string => new TextDecoder("iso-8859-1").decode(b);

export const LAW_FILE = /^(\d{4})(\d{3})\.html$/;
export const CHAPTER_FILE = /^(\d{2})\.html$/;

const ENT: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m);
/** Tags out (block-ish tags become spaces), entities decoded, whitespace squashed. */
export const plain = (html: string) =>
  decode(html.replace(/<sup[^>]*>.*?<\/sup>/gis, "").replace(/<\/?(a|i|em|b|strong|small|span|sup|sub|u)\b[^>]*>/gi, "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ").replace(/ ([,.;:)])/g, "$1").trim();

export interface LawAmendment { year: number; nr: number; effective: string | null }
export interface LawArticle { id: string; heading: string; text: string }
export interface Law {
  year: number; nr: number; edition: string | null; title: string; inForce: string | null;
  matter: { lthing: number; nr: number } | null;
  amendments: LawAmendment[];
  articles: LawArticle[];
  text: string;
}

export function parseLaw(fileName: string, html: string): Law {
  const m = LAW_FILE.exec(fileName);
  if (!m) throw new Error(`not a law file: ${fileName}`);
  const title = plain(/<h2>(.*?)<\/h2>/is.exec(html)?.[1] ?? /<title>[^/]*\/(.*?)<\/title>/is.exec(html)?.[1] ?? "");
  const edition = /Útgáfa\s+(\d{3}[a-z]?)/i.exec(html)?.[1] ?? null;
  // "Tóku gildi 1. janúar 2017." or, for a repealed law, "Felld úr gildi skv. l. 33/2019, 24. gr."
  const inForce = (() => { const x = /<small>\s*<b>(.*?)<\/b>/is.exec(html)?.[1]; return x ? plain(x).replace(/\.$/, "") || null : null; })();
  const fer = /ferill\/\?ltg=(\d+)&(?:amp;)?mnr=(\d+)/.exec(html);
  // "Breytt með:" list up to the end of its <small> block; effective text may contain nested parentheses
  const amendments: LawAmendment[] = [];
  const block = /Breytt með:\s*<\/em>(.*?)<\/small>/is.exec(html)?.[1] ?? "";
  const re = /<a [^>]*>\s*L\.\s*(\d+)\/(\d{4})\s*<\/a>\s*(\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))?/g;
  for (let a; (a = re.exec(block)); ) {
    amendments.push({ nr: Number(a[1]), year: Number(a[2]), effective: a[3] ? plain(a[3].slice(1, -1)) : null });
  }
  // articles: <span id="G12"></span> … up to the next article anchor (paragraph ids like G1M1 are not anchors)
  const articles: LawArticle[] = [];
  const parts = html.split(/<span id="(G\d+[a-z]?)"><\/span>/);
  for (let i = 1; i < parts.length; i += 2) {
    const id = parts[i]!;
    const body = parts[i + 1]!.split(/<br>\s*<br>\s*<b>[IVXLC]+\. kafli/i)[0]!.split(/<\/body>/i)[0]!;
    const num = plain(/<b>(.*?)<\/b>/is.exec(body)?.[1] ?? "");
    const name = plain(/<em>(.*?)<\/em>/is.exec(body)?.[1] ?? "");
    articles.push({ id, heading: [num, name].filter(Boolean).join(" "), text: plain(body) });
  }
  const bodyHtml = /<body[^>]*>(.*)<\/body>/is.exec(html)?.[1] ?? html;
  return {
    year: Number(m[1]), nr: Number(m[2]), edition, title, inForce,
    matter: fer ? { lthing: Number(fer[1]), nr: Number(fer[2]) } : null,
    amendments: [...new Map(amendments.map((a) => [`${a.year}/${a.nr}`, a])).values()],
    articles: [...new Map(articles.map((a) => [a.id, a])).values()], text: plain(bodyHtml),
  };
}

/** Chapter index: "1.a. Stjórnskipunarlög" for every law file it lists, plus the edition. */
export function parseChapterIndex(html: string): { edition: string | null; laws: { file: string; chapter: string }[] } {
  const edition = /útgáfa\s+(\d{3}[a-z]?)/i.exec(html)?.[1] ?? null;
  const top = plain(/<h2>[^:]*:\s*(.*?)<\/h2>/is.exec(html)?.[1] ?? "");
  const laws: { file: string; chapter: string }[] = [];
  let chapter = top;
  for (const tok of html.matchAll(/<h3>(.*?)<\/h3>|href="(\d{7})\.html"/gis)) {
    if (tok[1] !== undefined) chapter = plain(tok[1]);
    else laws.push({ file: tok[2]!, chapter });
  }
  return { edition, laws };
}

/** althingi.is page of a law in the current collection (pattern confirmed by the zip's own links, e.g. `lagas/nuna/…`). */
export const lawUrl = (year: number, nr: number) => `https://www.althingi.is/lagas/nuna/${year}${String(nr).padStart(3, "0")}.html`;

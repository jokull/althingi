// Query routing: numeric references never reach full-text search (lemma-is skips numbers by design).
// Pure function; member-name routing needs the database and lives in the web layer.

export interface Route {
  kind: "law" | "matter" | "document";
  path: string;
  label: string;
}

const norm = (q: string) => q.trim().replace(/\s+/g, " ").toLowerCase();

/** `currentLthing` resolves bare references ("300. mál", "þskj. 421") to the current session. */
export function route(q: string, currentLthing: number): Route | null {
  const s = norm(q);
  let m: RegExpMatchArray | null;

  // lög nr. 46/2016 | lög 46/2016 | 46/2016  (four-digit year distinguishes it from 157/300)
  if ((m = s.match(/^(?:lög(?:\s+nr\.?)?\s+)?(\d{1,3})\/((?:19|20)\d{2})$/))) {
    return { kind: "law", path: `/log/${m[2]}/${Number(m[1])}`, label: `lög nr. ${Number(m[1])}/${m[2]}` };
  }
  // þskj. 421 | þingskjal 421 | þskj. 157/421
  if ((m = s.match(/^þ(?:skj|ingskjal)\.?\s*(?:(\d{1,3})\/)?(\d{1,4})$/))) {
    const lthing = m[1] ? Number(m[1]) : currentLthing;
    return { kind: "document", path: `/thingskjal/${lthing}/${Number(m[2])}`, label: `þingskjal ${Number(m[2])} á ${lthing}. þingi` };
  }
  // 157/b/307 | 157/a/300 | 157/300
  if ((m = s.match(/^(\d{1,3})\/(?:([ab])\/)?(\d{1,4})$/))) {
    const cls = m[2] ?? "a";
    return { kind: "matter", path: `/mal/${Number(m[1])}/${cls}/${Number(m[3])}`, label: `${Number(m[3])}. mál ${cls === "b" ? "(B) " : ""}á ${Number(m[1])}. þingi` };
  }
  // 300. mál | mál 300 | 300 mál | 157. þing 300. mál
  if ((m = s.match(/^(?:(\d{1,3})\.\s*þing\s+)?(?:(\d{1,4})\.?\s*mál|mál\s*(?:nr\.?\s*)?(\d{1,4}))$/))) {
    const lthing = m[1] ? Number(m[1]) : currentLthing;
    const nr = Number(m[2] ?? m[3]);
    return { kind: "matter", path: `/mal/${lthing}/a/${nr}`, label: `${nr}. mál á ${lthing}. þingi` };
  }
  return null;
}

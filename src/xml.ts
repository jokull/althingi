// Tiny namespace-tolerant XML helpers on top of htmlparser2's DOM.
// Alþingi serves both plain (`<ræða>`) and prefixed (`<ns:ræða>`) variants; all lookups use the local name.
import { parseDocument } from "htmlparser2";
import { type Element, type ChildNode, isTag, isText } from "domhandler";

export type El = Element;

export const localName = (n: string): string => {
  const i = n.indexOf(":");
  return i < 0 ? n : n.slice(i + 1);
};

export function parseXml(xml: string): El {
  const doc = parseDocument(xml, { xmlMode: true, decodeEntities: true });
  const root = doc.children.find(isTag);
  if (!root) throw new Error("no root element");
  return root;
}

/** Direct child elements, optionally filtered by local name. */
export function kids(el: El | undefined, name?: string): El[] {
  if (!el) return [];
  return el.children.filter(isTag).filter((c) => name === undefined || localName(c.name) === name);
}

export function kid(el: El | undefined, name: string): El | undefined {
  return kids(el, name)[0];
}

/** All descendant elements with the given local name (document order). */
export function descendants(el: El | undefined, name: string): El[] {
  const out: El[] = [];
  const walk = (e: El) => {
    for (const c of e.children) {
      if (!isTag(c)) continue;
      if (localName(c.name) === name) out.push(c);
      walk(c);
    }
  };
  if (el) walk(el);
  return out;
}

export function attr(el: El | undefined, name: string): string | undefined {
  if (!el) return undefined;
  for (const [k, v] of Object.entries(el.attribs)) if (localName(k) === name) return v;
  return undefined;
}

/** Collapse all whitespace (the XML is hard-wrapped) and trim. */
export const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Text content of an element (CDATA included), ignoring comments / processing instructions. */
export function text(el: El | undefined): string {
  if (!el) return "";
  let out = "";
  const walk = (nodes: ChildNode[]) => {
    for (const n of nodes) {
      if (isText(n)) out += n.data;
      else if (isTag(n)) walk(n.children);
      else if (n.type === "cdata") walk((n as unknown as { children: ChildNode[] }).children); // <![CDATA[…]]>
    }
  };
  walk(el.children);
  return squash(out);
}

/** "11.09.2025" -> "2025-09-11"; empty/invalid -> null. */
export function dmy(s: string | undefined): string | null {
  const m = s?.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
}

export const int = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
};

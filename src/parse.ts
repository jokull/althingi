// Parsers for the Alþingi XML service. Pure functions: string in, typed rows out.
// Built from samples in fixtures/ (no XSD available); see docs/STRUCTURE.md for the quirks handled here.
import { type El, attr, descendants, dmy, int, kid, kids, parseXml, squash, text } from "./xml.ts";
import { type ChildNode, isTag, isText } from "domhandler";

// ---------------------------------------------------------------- speech text

export interface Paragraph {
  seq: number;
  /** The speaker's own words, whitespace-normalised. Interjections removed. */
  text: string;
  /** Inline <frammíkall> by other members; display only, never indexed. */
  interjections: string[];
}

export interface SpeechText {
  /** `rad20250911T103151`, derived from the start time (== xml filename stem). */
  id: string;
  lthing: number | null;
  fundur: number | null;
  /** Naive local timestamp as served, e.g. 2025-09-11T10:31:51 (Iceland is UTC+0 year-round). */
  started: string;
  speakerAbbr: string | null;
  /** `embætti` attribute, e.g. "fjmrh." */
  office: string | null;
  tegr: string | null;
  tegflm: string | null;
  /** `fl` (flutningsmaður marker) or a committee abbreviation (am, ev, forsn…) */
  nefnd: string | null;
  /** frhr <> "0": continuation of an interrupted speech (all "0" in the 300 texts checked) */
  continued: boolean | null;
  matter: { nr: number; cls: string | null; kind: string | null; title: string } | null;
  paragraphs: Paragraph[];
}

/**
 * tegflm = speaker capacity. Decoded from value distributions vs known fields (docs/DECISIONS.md §3).
 * HIGH: Þ R F S N.  MEDIUM (UI says "giskað"): 1 2 M 0.  LOW: L (raw only).
 */
export const CAPACITY: Record<string, { label: string; confidence: "high" | "medium" | "low" }> = {
  Þ: { label: "þingmaður", confidence: "high" },
  R: { label: "ráðherra", confidence: "high" },
  F: { label: "forseti", confidence: "high" },
  S: { label: "fyrirspyrjandi", confidence: "high" },
  N: { label: "framsögumaður nefndarálits", confidence: "high" },
  "1": { label: "1. flutningsmaður", confidence: "medium" },
  "2": { label: "2. flutningsmaður", confidence: "medium" },
  M: { label: "meðflutningsmaður / minnihluti", confidence: "medium" },
  "0": { label: "óraðaður flutningsmaður", confidence: "medium" },
  L: { label: "óþekkt (L)", confidence: "low" },
};

/** Label for the speaker_capacity column; null when the code is absent or unknown. */
export function decodeCapacity(tegflm: string | null | undefined): string | null {
  if (!tegflm) return null;
  return CAPACITY[tegflm]?.label ?? null;
}

export const speechIdFromTime = (t: string): string => "rad" + t.replace(/[-:]/g, "");

function paragraphOf(mgr: El, seq: number): Paragraph {
  let main = "";
  const interjections: string[] = [];
  const walk = (nodes: ChildNode[], inInterjection: boolean) => {
    for (const n of nodes) {
      if (isText(n)) {
        if (!inInterjection) main += n.data;
        else interjections.push(n.data);
      } else if (isTag(n)) {
        const name = n.name.includes(":") ? n.name.slice(n.name.indexOf(":") + 1) : n.name;
        if (name === "frammíkall") {
          const before = interjections.length;
          walk(n.children, true);
          // merge fragments of one interjection into a single string
          const merged = squash(interjections.splice(before).join(" "));
          if (merged) interjections.push(merged);
          main += " "; // an interjection splits the sentence but not the word stream
        } else if (name === "undirtitill") {
          main += " ";
        } else {
          walk(n.children, inInterjection);
        }
      } else if (n.type === "cdata") {
        walk((n as unknown as { children: ChildNode[] }).children, inInterjection); // <![CDATA[…]]> is text too
      }
      // comments / processing instructions (<?xm-replace_text …?>) are ignored
    }
  };
  walk(mgr.children, false);
  return { seq, text: squash(main), interjections };
}

export function parseSpeechText(xml: string): SpeechText {
  const root = parseXml(xml);
  const adm = kid(root, "umsýsla");
  const started = attr(adm, "tími") ?? (attr(root, "id") ?? "").replace(/^r/, "");
  if (!started) throw new Error("speech without start time");
  const malEl = kid(adm, "mál");
  const matter = malEl
    ? {
        nr: int(attr(malEl, "nr")) ?? -1,
        cls: attr(malEl, "málsflokkur") ?? null,
        kind: attr(malEl, "málstegund") ?? null,
        title: text(kid(malEl, "málsheiti")),
      }
    : null;
  const paragraphs: Paragraph[] = [];
  for (const mgr of descendants(kid(root, "ræðutexti"), "mgr")) {
    const p = paragraphOf(mgr, paragraphs.length);
    if (p.text) paragraphs.push(p);
  }
  return {
    id: speechIdFromTime(started),
    lthing: int(attr(adm, "lgþ")),
    fundur: int(attr(adm, "fundur")),
    started,
    speakerAbbr: attr(root, "skst") ?? null,
    office: attr(root, "embætti") ?? null,
    tegr: attr(root, "tegr") ?? null,
    tegflm: attr(root, "tegflm") ?? null,
    nefnd: attr(root, "nefnd") ?? null,
    continued: attr(root, "frhr") === undefined ? null : attr(root, "frhr") !== "0",
    matter: matter && matter.nr >= 0 ? matter : null,
    paragraphs,
  };
}

// ---------------------------------------------------------------- speech lists

export interface SpeechIndexEntry {
  /** `rad…` (XML era) or `sgml<lthing>_<dir>_<stem>` (SGML era, text unavailable); null if neither link exists. */
  id: string | null;
  era: "xml" | "sgml";
  /** sgml/html link for SGML-era entries (never fetched) */
  sourceUrl: string | null;
  memberId: number;
  memberName: string;
  roleKind: "ráðherra" | "forseti" | "framsögumaður" | null;
  roleTitle: string | null;
  date: string | null; // ISO date
  lthing: number;
  fundur: number | null;
  started: string;
  ended: string | null;
  type: string;
  /** Debate code as served: 1 2 3 * S E F or "". */
  debate: string;
  /** Not a real speech (útbýting þingskjala). */
  isSpeech: boolean;
  matter: { nr: number; cls: string; title: string } | null;
  xmlUrl: string | null;
  htmlUrl: string | null;
  sgmlUrl: string | null;
  audioUrl: string | null;
  vodUrl: string | null;
}

const ID_FROM_URL = /\/(rad\d{8}T\d{6})\.xml$/;
// /altext/123/03/r02133209.sgml -> sgml123_03_r02133209 (the bare stem is day+time and repeats across months)
const SGML_ID = /\/altext\/(\d+)\/(\w+)\/(r\w+)\.sgml$/;

export function parseSpeechList(xml: string): SpeechIndexEntry[] {
  const root = parseXml(xml);
  return kids(root, "ræða").map((r): SpeechIndexEntry => {
    const speaker = kid(r, "ræðumaður");
    const rm = text(kid(speaker, "ráðherra"));
    const fo = text(kid(speaker, "forsetiAlþingis"));
    const fr = text(kid(speaker, "framsögumaðurNefndarálits"));
    const roleKind = rm ? "ráðherra" : fo ? "forseti" : fr ? "framsögumaður" : null;
    const mal = kid(r, "mál");
    const nr = int(text(kid(mal, "málsnúmer")));
    const urls = kid(r, "slóðir"); // direct child only: <mál> has its own <slóðir>
    const u = (n: string) => text(kid(urls, n)) || null;
    const xmlUrl = u("xml");
    const sgmlUrl = u("sgml");
    const type = text(kid(r, "tegundræðu"));
    const sgml = sgmlUrl?.match(SGML_ID);
    const xmlId = xmlUrl?.match(ID_FROM_URL)?.[1] ?? null;
    return {
      id: xmlId ?? (sgml ? `sgml${sgml[1]}_${sgml[2]}_${sgml[3]}` : null),
      era: xmlId ? "xml" : "sgml",
      sourceUrl: xmlId ? null : (sgmlUrl ?? u("html")),
      memberId: int(attr(speaker, "id")) ?? -1,
      memberName: text(kid(speaker, "nafn")),
      roleKind,
      roleTitle: rm || fo || fr || null,
      date: dmy(text(kid(r, "dagur"))),
      lthing: int(text(kid(r, "löggjafarþing"))) ?? -1,
      fundur: int(text(kid(r, "fundur"))),
      started: text(kid(r, "ræðahófst")),
      ended: text(kid(r, "ræðulauk")) || null,
      type,
      debate: text(kid(r, "umræða")),
      isSpeech: type !== "útbýting þingskjala",
      matter:
        nr !== null && mal
          ? { nr, cls: text(kid(mal, "málsflokkur")), title: text(kid(mal, "málsheiti")) }
          : null,
      xmlUrl,
      htmlUrl: u("html"),
      sgmlUrl,
      audioUrl: u("hljóð"),
      vodUrl: u("vod"),
    };
  });
}

// ---------------------------------------------------------------- members

export interface Member {
  id: number;
  name: string;
  born: string | null;
  abbr: string | null;
}

export function parseMembers(xml: string): Member[] {
  return kids(parseXml(xml), "þingmaður").map((m) => ({
    id: int(attr(m, "id")) ?? -1,
    name: text(kid(m, "nafn")),
    born: text(kid(m, "fæðingardagur")) || null,
    abbr: text(kid(m, "skammstöfun")) || null,
  }));
}

export interface Seat {
  memberId: number;
  lthing: number;
  /** "þingmaður" | "varamaður" (as served) */
  kind: string;
  abbr: string | null;
  partyId: number | null;
  party: string | null;
  constituencyId: number | null;
  constituency: string | null;
  from: string | null;
  to: string | null;
}

export function parseSeats(xml: string): Seat[] {
  const root = parseXml(xml);
  const memberId = int(attr(root, "id")) ?? -1;
  return descendants(kid(root, "þingsetur"), "þingseta").map((s): Seat => {
    const period = kid(s, "tímabil");
    const party = kid(s, "þingflokkur");
    const cons = kid(s, "kjördæmi");
    return {
      memberId,
      lthing: int(text(kid(s, "þing"))) ?? -1,
      kind: text(kid(s, "tegund")),
      abbr: text(kid(s, "skammstöfun")) || null,
      partyId: int(attr(party, "id")),
      party: text(party) || null,
      constituencyId: int(attr(cons, "id")),
      constituency: text(cons) || null,
      from: dmy(text(kid(period, "inn"))),
      to: dmy(text(kid(period, "út"))),
    };
  });
}

// ---------------------------------------------------------------- matters / sessions

export interface MatterRow {
  lthing: number;
  nr: number;
  /** "A" (matters with documents) or "B" (without) */
  cls: string;
  title: string;
  /** efnisgreining: short qualifier shown after the title */
  subtitle: string | null;
  typeCode: string | null;
  typeLabel: string | null;
}

export function parseMatterList(xml: string): MatterRow[] {
  return kids(parseXml(xml), "mál").map((m) => {
    const t = kid(m, "málstegund");
    return {
      lthing: int(attr(m, "þingnúmer")) ?? -1,
      nr: int(attr(m, "málsnúmer")) ?? -1,
      cls: attr(m, "málsflokkur") ?? "A",
      title: text(kid(m, "málsheiti")),
      subtitle: text(kid(m, "efnisgreining")) || null,
      typeCode: attr(t, "málstegund") ?? null,
      typeLabel: text(kid(t, "heiti")) || null,
    };
  });
}

export interface SessionRow {
  lthing: number;
  period: string;
  start: string | null;
  end: string | null;
  hasRecord: boolean;
}

export function parseSessions(xml: string): SessionRow[] {
  return kids(parseXml(xml), "þing").map((s) => ({
    lthing: int(attr(s, "númer")) ?? -1,
    period: text(kid(s, "tímabil")),
    start: dmy(text(kid(s, "þingsetning"))),
    end: dmy(text(kid(s, "þinglok"))),
    hasRecord: attr(s, "alþingistíðindi") === "já",
  }));
}

// ---------------------------------------------------------------- matter detail (A-mál): one request buys all of this

export interface MatterDetail {
  lthing: number;
  cls: string;
  nr: number;
  title: string;
  subtitle: string | null;
  typeCode: string | null;
  typeLabel: string | null;
  /** staðamáls: free-text status, e.g. "Samþykkt sem lög frá Alþingi." */
  statusText: string | null;
  /** fyrirspurntil: whom a question (fsp.) is addressed to */
  questionTo: string | null;
  laws: { year: number; nr: number }[];
  links: { kind: string; lthing: number; cls: string; nr: number; title: string }[];
  topics: { parentId: number | null; parentName: string | null; id: number; name: string; description: string | null }[];
  documents: { nr: number; issued: string | null; type: string; htmlUrl: string | null; pdfUrl: string | null; xmlUrl: string | null }[];
  votes: {
    id: number; votedAt: string | null; kindCode: string | null; kindLabel: string; docNr: number | null;
    method: string | null; result: string | null; yes: number | null; no: number | null; abstain: number | null;
  }[];
  consultations: { roundId: number; requested: string | null; due: string | null; recipient: string; committeeId: number | null; committee: string | null }[];
  submissions: { id: number; sender: string; committeeId: number | null; kindCode: string | null; kind: string | null; received: string | null; sent: string | null; pdfUrl: string | null }[];
  rapporteurs: { memberId: number; name: string }[];
  /** <ræður>: the matter's speeches with member ids (incl. non-MP ministers). No <vod> here (docs/INGEST.md §9). */
  speeches: SpeechIndexEntry[];
}

/** Matter detail's <ræður> block. Shape differs from ræðulisti: ids in attributes, no date/matter children. */
export function parseDetailSpeeches(root: El, matter: { lthing: number; cls: string; nr: number; title: string }): SpeechIndexEntry[] {
  return kids(kid(root, "ræður"), "ræða").map((r): SpeechIndexEntry => {
    const rm = text(kid(r, "ráðherra")), fo = text(kid(r, "forsetiAlþingis")), fr = text(kid(r, "framsögumaðurNefndarálits"));
    const hasRole = (n: string) => kid(r, n) !== undefined;
    const roleKind = hasRole("ráðherra") ? "ráðherra" : hasRole("forsetiAlþingis") ? "forseti" : hasRole("framsögumaðurNefndarálits") ? "framsögumaður" : null;
    const urls = kid(r, "slóðir");
    const u = (n: string) => text(kid(urls, n)) || null;
    const xmlUrl = u("xml");
    const started = text(kid(r, "ræðahófst"));
    const id = xmlUrl?.match(ID_FROM_URL)?.[1] ?? null;
    const type = text(kid(r, "tegundræðu"));
    return {
      id, era: "xml", sourceUrl: null,
      memberId: int(attr(r, "þingmaður")) ?? int(attr(kid(r, "nafn"), "id")) ?? -1, memberName: text(kid(r, "nafn")),
      roleKind, roleTitle: rm || fo || fr || null,
      date: /^\d{4}-\d{2}-\d{2}/.test(started) ? started.slice(0, 10) : null,
      lthing: int(attr(r, "þingnúmer")) ?? matter.lthing, fundur: int(attr(r, "fundarnúmer")),
      started, ended: text(kid(r, "ræðulauk")) || null, type, debate: text(kid(r, "umræða")),
      isSpeech: type !== "útbýting þingskjala",
      matter: { nr: matter.nr, cls: matter.cls, title: matter.title },
      xmlUrl, htmlUrl: u("html"), sgmlUrl: null, audioUrl: u("hljóð"), vodUrl: u("vod"),
    };
  });
}

export function parseMatterDetail(xml: string): MatterDetail {
  const root = parseXml(xml);
  const m = kid(root, "mál");
  const type = kid(m, "málstegund");
  const urls = kid(m, "slóð");
  void urls;

  const links: MatterDetail["links"] = [];
  for (const rel of kids(kid(root, "tengdMál"))) {
    for (const rm of kids(rel, "mál")) {
      links.push({
        kind: rel.name, lthing: int(attr(rm, "þingnúmer")) ?? -1, cls: attr(rm, "málsflokkur") ?? "A",
        nr: int(attr(rm, "málsnúmer")) ?? -1, title: text(kid(rm, "málsheiti")),
      });
    }
  }

  const topics: MatterDetail["topics"] = [];
  for (const y of descendants(kid(root, "efnisflokkar"), "yfirflokkur")) {
    for (const e of kids(y, "efnisflokkur")) {
      topics.push({
        parentId: int(attr(y, "id")), parentName: text(kid(y, "heiti")) || null,
        id: int(attr(e, "id")) ?? -1, name: text(kid(e, "heiti")), description: text(kid(e, "lýsing")) || null,
      });
    }
  }

  const documents = kids(kid(root, "þingskjöl"), "þingskjal").map((d) => {
    const u = kid(d, "slóð");
    return {
      nr: int(attr(d, "skjalsnúmer")) ?? -1, issued: text(kid(d, "útbýting")) || null, type: text(kid(d, "skjalategund")),
      htmlUrl: text(kid(u, "html")) || null, pdfUrl: text(kid(u, "pdf")) || null, xmlUrl: text(kid(u, "xml")) || null,
    };
  });

  const votes = kids(kid(root, "atkvæðagreiðslur"), "atkvæðagreiðsla").map((v) => {
    const sum = kid(v, "samantekt");
    const kind = kid(v, "tegund");
    const cnt = (n: string) => int(text(kid(kid(sum, n), "fjöldi")));
    return {
      id: int(attr(v, "atkvæðagreiðslunúmer")) ?? -1, votedAt: text(kid(v, "tími")) || null,
      kindCode: attr(kind, "tegund") ?? null, kindLabel: text(kind),
      docNr: int(attr(kid(v, "þingskjal"), "skjalsnúmer")),
      method: text(kid(sum, "aðferð")) || null, result: text(kid(sum, "afgreiðsla")) || null,
      yes: cnt("já"), no: cnt("nei"), abstain: cnt("sátuhjá"),
    };
  });

  const consultations = descendants(kid(root, "umsagnabeiðnir"), "umsagnabeiðni").map((u) => ({
    roundId: int(attr(u, "umsagnabeiðnanúmer")) ?? -1, requested: text(kid(u, "dagsetning")) || null, due: text(kid(u, "fresturtil")) || null,
    recipient: text(kid(u, "viðtakandi")), committeeId: int(attr(kid(u, "nefnd"), "id")), committee: text(kid(u, "nefnd")) || null,
  }));

  const submissions = kids(kid(root, "erindaskrá"), "erindi").map((e) => ({
    id: int(attr(e, "dagbókarnúmer")) ?? -1, sender: text(kid(e, "sendandi")),
    committeeId: int(attr(kid(kid(e, "viðtakandi"), "nefnd"), "id")),
    kindCode: attr(kid(e, "tegunderindis"), "tegund") ?? null, kind: text(kid(e, "tegunderindis")) || null,
    received: text(kid(e, "komudagur")) || null, sent: text(kid(e, "sendingadagur")) || null,
    pdfUrl: text(kid(kid(e, "slóð"), "pdf")) || null,
  }));

  const rapporteurs = kids(kid(root, "framsögumenn"), "framsögumaður").map((f) => ({
    memberId: int(attr(f, "id")) ?? -1, name: text(kid(f, "nafn")),
  }));

  const head = { lthing: int(attr(m, "þingnúmer")) ?? -1, cls: attr(m, "málsflokkur") ?? "A", nr: int(attr(m, "málsnúmer")) ?? -1, title: text(kid(m, "málsheiti")) };
  return {
    lthing: head.lthing, cls: head.cls, nr: head.nr,
    title: head.title, subtitle: text(kid(m, "efnisgreining")) || null,
    typeCode: attr(type, "málstegund") ?? null, typeLabel: text(kid(type, "heiti")) || null,
    statusText: text(kid(m, "staðamáls")) || null, questionTo: text(kid(m, "fyrirspurntil")) || null,
    laws: descendants(kid(root, "breytingaráLögum"), "lögTilBreytinga").map((l) => ({ year: int(attr(l, "ár")) ?? -1, nr: int(attr(l, "númer")) ?? -1 })),
    links, topics, documents, votes, consultations, submissions, rapporteurs,
    speeches: parseDetailSpeeches(root, head),
  };
}

export interface CommitteeRow { id: number; name: string; abbr: string | null; abbrLong: string | null; firstLthing: number | null }

export function parseCommittees(xml: string): CommitteeRow[] {
  return kids(parseXml(xml), "nefnd").map((n) => ({
    id: int(attr(n, "id")) ?? -1, name: text(kid(n, "heiti")),
    abbr: text(kid(kid(n, "skammstafanir"), "stuttskammstöfun")) || null,
    abbrLong: text(kid(kid(n, "skammstafanir"), "löngskammstöfun")) || null,
    firstLthing: int(text(kid(kid(n, "tímabil"), "fyrstaþing"))),
  }));
}

// ---------------------------------------------------------------- session lists: documents and votes (one request each)

export interface DocumentRow { lthing: number; nr: number; issued: string | null; type: string; htmlUrl: string | null; pdfUrl: string | null; xmlUrl: string | null }

/** thingskjol/?lthing=N: every document id + type + links of a session (no matter link: that comes from matter detail). */
export function parseDocumentList(xml: string): DocumentRow[] {
  return kids(parseXml(xml), "þingskjal").map((d) => {
    const u = kid(d, "slóð");
    return {
      lthing: int(attr(d, "þingnúmer")) ?? -1, nr: int(attr(d, "skjalsnúmer")) ?? -1, issued: text(kid(d, "útbýting")) || null,
      type: text(kid(d, "skjalategund")), htmlUrl: text(kid(u, "html")) || null, pdfUrl: text(kid(u, "pdf")) || null, xmlUrl: text(kid(u, "xml")) || null,
    };
  }).filter((d) => d.nr >= 0 && d.lthing >= 0);
}

export interface VoteRow extends Omit<MatterDetail["votes"][number], never> { lthing: number; cls: string; nr: number; fundur: number | null; htmlUrl: string | null }

/** atkvaedagreidslur/?lthing=N | ?dagur=YYYYMMDD: vote summaries (superset of the dump's: includes "kom ekki til atkvæðagreiðslu"). */
export function parseVoteList(xml: string): VoteRow[] {
  return kids(parseXml(xml), "atkvæðagreiðsla").map((v) => {
    const sum = kid(v, "samantekt");
    const kind = kid(v, "tegund");
    const cnt = (n: string) => int(text(kid(kid(sum, n), "fjöldi")));
    return {
      id: int(attr(v, "atkvæðagreiðslunúmer")) ?? -1, lthing: int(attr(v, "þingnúmer")) ?? -1, cls: attr(v, "málsflokkur") ?? "A",
      nr: int(attr(v, "málsnúmer")) ?? -1, fundur: int(text(kid(v, "fundur"))),
      votedAt: text(kid(v, "tími")) || null, kindCode: attr(kind, "tegund") ?? null, kindLabel: text(kind),
      docNr: int(attr(kid(v, "þingskjal"), "skjalsnúmer")),
      method: text(kid(sum, "aðferð")) || null, result: text(kid(sum, "afgreiðsla")) || null,
      yes: cnt("já"), no: cnt("nei"), abstain: cnt("greiðirekkiatkvæði") ?? cnt("sátuhjá"),
      htmlUrl: text(kid(kid(v, "nánar"), "html")) || null,
    };
  }).filter((v) => v.id >= 0 && v.lthing >= 0 && v.nr >= 0);
}

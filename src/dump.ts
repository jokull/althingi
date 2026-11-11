// Parsers for Alþingi's bulk export (xmlfiles.zip, docs/INGEST.md §1). Pure: string in, typed rows out.
// Every lookup goes through xml.ts local names, so `ns:`-prefixed files parse like plain ones. Abbreviations are NFC.
import { parseSpeechText, type SpeechText } from "./parse.ts";
import { type El, attr, descendants, int, kid, kids, parseXml, text } from "./xml.ts";

const nfc = (s: string | undefined | null): string | null => (s ? s.normalize("NFC").trim() || null : null);
const ts = (s: string | undefined): string | null => (s && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s.trim()) ? s.trim() : null);

/** `tegr` → the service's `tegundræðu` label (DECISIONS §3; B checked against 157 service rows). */
export const SPEECH_TYPE: Record<string, string> = {
  R: "ræða", A: "andsvar", F: "flutningsræða", S: "svar", G: "grein fyrir atkvæði", K: "um atkvæðagreiðslu",
  U: "um fundarstjórn", B: "ber af sér sakir",
};
export const speechType = (tegr: string | null): string => (tegr ? SPEECH_TYPE[tegr] ?? `óþekkt (${tegr})` : "");

/** lidaskjol/fundir `umr` → service debate code: trailing `f` (framhald) dropped. */
export const debateCode = (umr: string | null | undefined): string => (umr ?? "").trim().replace(/f$/, "");

/** Ballot value as stored (service wording, ballots.choice). */
export const ballotChoice = (gildi: string): string =>
  ({ já: "já", nei: "nei", fjarverandi: "fjarverandi", greiðir_ekki_atkv: "greiðir ekki atkvæði" } as Record<string, string>)[gildi] ?? gildi.replace(/_/g, " ");

/** Vote method code → the service's aðferð label where the mapping is evident; null otherwise (code kept raw). */
export const METHOD: Record<string, string> = { S: "atkvæðagreiðslukerfi", N: "nafnakall", G: "yfirlýsing forseta/mál gengur" };

// ---------------------------------------------------------------- speeches (raedur/, raedur_bradabirgda/)

const STEM = /(\d{8}T\d{6})/;

/**
 * Speech id for a dump file: the timestamp in the file NAME (canonical, same as the service's stem), tolerating
 * ` rad…` and missing `rad` prefixes; only a name without any timestamp falls back to the file's `tími`.
 */
export function dumpSpeechId(fileName: string, parsed: Pick<SpeechText, "id">): string {
  const m = STEM.exec(fileName.trim());
  return m ? `rad${m[1]}` : parsed.id;
}

export interface DumpSpeech extends SpeechText {
  /** id per dumpSpeechId */
  fileId: string;
  type: string;
}

export function parseDumpSpeech(fileName: string, xml: string): DumpSpeech {
  const s = parseSpeechText(xml);
  return { ...s, speakerAbbr: nfc(s.speakerAbbr), fileId: dumpSpeechId(fileName, s), type: speechType(s.tegr) };
}

/** `rad20250911T103151` → its start timestamp and date. */
export function idTime(id: string): { started: string; date: string } {
  const m = /^rad(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(id);
  if (!m) throw new Error(`not a speech id: ${id}`);
  return { started: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`, date: `${m[1]}-${m[2]}-${m[3]}` };
}

export const speechXmlUrl = (lthing: number, id: string) => `https://www.althingi.is/xml/${lthing}/raedur/${id}.xml`;

// ---------------------------------------------------------------- shared <mál> block

export interface DumpMatter {
  nr: number; cls: string; kind: string | null; debate: string | null; title: string;
  sponsors: { abbr: string; office: string | null }[];
  docs: { nr: number; type: string | null }[];
}

function matterOf(m: El | undefined): DumpMatter | null {
  const nr = int(attr(m, "nr"));
  if (!m || nr === null) return null;
  return {
    nr, cls: attr(m, "málsflokkur") ?? "A", kind: attr(m, "málstegund") ?? null, debate: attr(m, "umr") ?? null,
    title: text(kid(m, "málsheiti")) || text(kid(m, "titill")),
    sponsors: kids(m, "flm").map((f) => ({ abbr: nfc(attr(f, "skst"))!, office: nfc(attr(f, "embætti") ?? attr(f, "embaett")) })).filter((f) => f.abbr),
    docs: kids(m, "þskj").map((d) => ({ nr: int(attr(d, "nr")) ?? -1, type: attr(d, "tegund") ?? null })).filter((d) => d.nr >= 0),
  };
}

// ---------------------------------------------------------------- lidaskjol/lid<ts>.xml: one agenda item's record

export interface LidSpeech { abbr: string; started: string; tegr: string | null; tegflm: string | null; office: string | null; continued: boolean | null }
export interface LidBallot { abbr: string; choice: string }
export interface LidVote {
  id: number; docNr: number | null; docType: string | null; at: string | null; showBallots: boolean | null;
  methodCode: string | null; committee: string | null; kindCode2: string | null; label: string;
  yes: number | null; no: number | null; absent: number | null; abstain: number | null; unanimous: boolean | null;
  ballots: LidBallot[];
}
export interface Lidaskjal {
  lthing: number; fundur: number; matter: DumpMatter | null;
  parts: { at: string | null; voteFlag: boolean | null; speeches: LidSpeech[]; votes: LidVote[] }[];
}

export function parseLidaskjal(xml: string): Lidaskjal {
  const root = parseXml(xml);
  const adm = kid(root, "umsýsla");
  return {
    lthing: int(attr(adm, "lgþ")) ?? -1, fundur: int(attr(adm, "fundur")) ?? -1, matter: matterOf(kid(adm, "mál")),
    parts: kids(root, "liðaskjal").map((l) => ({
      at: ts(attr(l, "tími")),
      voteFlag: attr(l, "atkvæðagreiðsla") === undefined ? null : attr(l, "atkvæðagreiðsla") === "true",
      speeches: kids(l, "þingræða").map((r) => ({
        abbr: nfc(attr(r, "skst")) ?? "", started: ts(attr(r, "tími")) ?? "", tegr: attr(r, "tegr") ?? null,
        tegflm: attr(r, "tegflm") ?? null, office: nfc(attr(r, "embætti")),
        continued: attr(r, "frhr") === undefined ? null : attr(r, "frhr") !== "0",
      })).filter((r) => r.started),
      votes: kids(l, "atkvæðagreiðsla").map((v): LidVote => {
        const res = kid(v, "niðurstaða");
        const um = kid(v, "um");
        const u = attr(res, "samhljóða");
        return {
          id: int(attr(v, "nr")) ?? -1, docNr: int(attr(v, "þskj")), docType: attr(v, "tegskjals") ?? null, at: ts(attr(v, "tími")),
          showBallots: attr(v, "birtaatkvæði") === undefined ? null : attr(v, "birtaatkvæði") === "já",
          methodCode: attr(v, "aðferð") ?? null, committee: attr(v, "nefnd") ?? null, kindCode2: attr(um, "tegatkvgr") ?? null,
          label: text(um),
          yes: int(attr(res, "já")), no: int(attr(res, "nei")), absent: int(attr(res, "fjarverandi")), abstain: int(attr(res, "greiðaekkiatkvæði")),
          unanimous: u === undefined ? null : u === "Já",
          ballots: kids(v, "atkv").map((b) => ({ abbr: nfc(attr(b, "skst")) ?? "", choice: ballotChoice(attr(b, "gildi") ?? "") })).filter((b) => b.abbr && b.choice),
        };
      }).filter((v) => v.id >= 0),
    })),
  };
}

// ---------------------------------------------------------------- fundir/fun<nnn>.xml: the sitting record

export interface Fundur {
  lthing: number; fundur: number; starts: string | null; ends: string | null;
  items: { lidId: string | null; at: string | null; matter: DumpMatter | null; summary: string }[];
  events: { at: string; kind: string; cls: string; nr: number; docNr: number | null }[];
}

const ITEM_EVENTS = ["umræðuLokið", "frvAfgreittSemLög", "umræðuOgAtkvæðagreiðsluFrestað"];

export function parseFundur(xml: string): Fundur {
  const root = parseXml(xml);
  const adm = kid(root, "umsýsla");
  const doc = kid(root, "fundarskjal");
  const starts = ts(attr(kid(doc, "fundurhefst"), "tími"));
  const ends = ts(attr(kid(doc, "fundiSlitið"), "tími"));
  const events: Fundur["events"] = [];
  if (starts) events.push({ at: starts, kind: "fundurhefst", cls: "", nr: 0, docNr: null });
  if (ends) events.push({ at: ends, kind: "fundiSlitið", cls: "", nr: 0, docNr: null });
  const items = kids(doc, "þingmál").map((t) => {
    const matter = matterOf(kid(t, "mál"));
    for (const k of ITEM_EVENTS) {
      for (const e of kids(t, k)) {
        const at = ts(attr(e, "tími"));
        if (at) events.push({ at, kind: k, cls: matter?.cls ?? "", nr: matter?.nr ?? 0, docNr: int(attr(e, "þskj")) });
      }
    }
    return { lidId: attr(t, "id") ?? null, at: ts(attr(t, "tími")), matter, summary: text(kid(t, "samantekt")) };
  });
  return { lthing: int(attr(adm, "lgþ")) ?? -1, fundur: int(attr(adm, "fundur")) ?? -1, starts, ends, items, events };
}

// ---------------------------------------------------------------- dagskra/dag<nnn>.xml: the agenda

export interface AgendaItem { seq: number; parentSeq: number | null; matter: DumpMatter | null; title: string; docNr: number | null; offAgenda: boolean }

export function parseDagskra(xml: string): { lthing: number; fundur: number; starts: string | null; items: AgendaItem[] } {
  const root = parseXml(xml);
  const adm = kid(root, "umsýsla");
  const d = kid(root, "dagskrá");
  const items: AgendaItem[] = [];
  const add = (el: El, offAgenda: boolean, parentSeq: number | null) => {
    const matter = matterOf(kid(el, "mál"));
    const seq = items.length;
    items.push({ seq, parentSeq, matter, title: text(kid(el, "titill")), docNr: matter?.docs[0]?.nr ?? null, offAgenda });
    for (const u of kids(el, "undirliður")) add(u, offAgenda, seq);
  };
  for (const el of kids(d)) {
    const n = el.name.slice(el.name.indexOf(":") + 1);
    if (n === "dagskrárliður") add(el, false, null);
    else if (n === "utanDagskrár") add(el, true, null);
  }
  return { lthing: int(attr(adm, "lgþ")) ?? -1, fundur: int(attr(adm, "fundur")) ?? -1, starts: ts(attr(kid(d, "fundurhefst"), "tími") ?? attr(adm, "tími")), items };
}

// ---------------------------------------------------------------- utbyting/utb<ts>.xml: documents distributed

export interface UtbDoc { nr: number; type: string; office: string | null; date: string | null; matterNr: number | null; title: string; sponsors: { abbr: string; office: string | null }[] }

export function parseUtbyting(xml: string): { lthing: number; fundur: number | null; at: string | null; docs: UtbDoc[] } {
  const root = parseXml(xml);
  const adm = kid(root, "umsýsla");
  return {
    lthing: int(attr(adm, "lgþ")) ?? -1, fundur: int(attr(adm, "fundur")), at: ts(attr(adm, "tími")),
    docs: descendants(kid(root, "útbýting"), "skjal").map((s) => ({
      nr: int(attr(s, "nr")) ?? -1, type: attr(s, "tegund") ?? "", office: nfc(attr(s, "embætti")), date: attr(s, "dags") ?? null,
      matterNr: int(attr(kid(s, "mál"), "nr")), title: text(kid(s, "titill")),
      sponsors: kids(s, "flm").map((f) => ({ abbr: nfc(attr(f, "skst"))!, office: nfc(attr(f, "embætti")) })).filter((f) => f.abbr),
    })).filter((d) => d.nr >= 0),
  };
}

/** Document types that originate a matter: their flm are the matter's sponsors (an answer's flm is the minister). */
export const ORIGINATING_DOC = /^(stj)?(frv|þáltill|till|tillaga)\b|^fsp\.|^beiðni|^stjtill\./;

// ---------------------------------------------------------------- fjarvist(ir)/ and inn/: absences and seat returns

export interface PersonList { lthing: number; fundur: number; date: string | null; people: { abbr: string; office: string | null }[] }

function personList(xml: string): PersonList {
  const root = parseXml(xml);
  const adm = kid(root, "umsýsla");
  return {
    lthing: int(attr(adm, "lgþ")) ?? -1, fundur: int(attr(adm, "fundur")) ?? -1,
    date: attr(adm, "dags") ?? ts(attr(adm, "tími"))?.slice(0, 10) ?? null,
    people: descendants(root, "þm").map((p) => ({ abbr: nfc(attr(p, "skst")) ?? "", office: nfc(attr(p, "embætti")) })).filter((p) => p.abbr),
  };
}
export const parseFjarvist = personList;
export const parseInn = personList;

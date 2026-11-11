// Speech text for the SGML era (sessions 115–130) from the Icelandic Gigaword Corpus parliament subcorpus
// (IGC-Parla 2026, CC BY 4.0, http://hdl.handle.net/20.500.12537/393). Design and measurements: docs/IGC.md.
//
// Join rule (deterministic, strongest key only): an IGC <u source="…/altext/<l>/<dir>/<stem>.sgml"> matches the one
// speeches row whose source_url is that URL. IGC splits a record where another speaker cuts in, so all <u> with one
// source form a group; the kept text is the <u> whose person (nfaerslunr in listPerson) is the row's member_id, in
// order; other speakers' <u> become interjections. No speaker agreement → the row stays unlinked. Nothing is guessed.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type ChildNode, isTag, isText } from "domhandler";
import { type Sql, saveSpeechText } from "./db.ts";
import { sha256 } from "./ingest.ts";
import { analyze, lemmaVersion } from "./lemma.ts";
import type { Paragraph } from "./parse.ts";
import { type El, attr, descendants, kid, localName, parseXml, squash, text } from "./xml.ts";

/** text_source value; bump when a new corpus version is loaded (the old value stays on rows it never touched). */
export const IGC_VERSION = "igc-parla-2026";

export interface IgcUtterance {
  uid: string;
  /** `who` without the `#` */
  who: string;
  chair: boolean;
  /** `#issue.<lthing>_<nr>_M` → "<lthing>_<nr>" */
  issue: string | null;
  source: string;
  paragraphs: Paragraph[];
}

export interface IgcDay { id: string; lthing: number | null; fundur: string | null; date: string | null; utterances: IgcUtterance[] }

/** `http://www.althingi.is/altext/123/03/r02133209.sgml` → `/altext/123/03/r02133209.sgml` (scheme/host vary). */
export const normUrl = (u: string): string => u.replace(/^https?:\/\/(www\.)?althingi\.is/, "");

/** Session number from the header, without a full parse (files are up to 1 MB). */
export function igcSession(xml: string): number | null {
  const m = /<meeting\b[^>]*\bn="(\d+)"[^>]*ana="#parla\.session"/.exec(xml) ?? /<meeting\b[^>]*ana="#parla\.session"[^>]*\bn="(\d+)"/.exec(xml);
  return m ? Number(m[1]) : null;
}

/** A <seg> → paragraph: the speaker's words; <vocal>/<kinesic>/<incident>/<note> descriptions become interjections. */
function segParagraph(seg: El, seq: number): Paragraph {
  let main = "";
  const interjections: string[] = [];
  const walk = (nodes: ChildNode[]) => {
    for (const n of nodes) {
      if (isText(n)) main += n.data;
      else if (isTag(n)) {
        const name = localName(n.name);
        if (["vocal", "kinesic", "incident", "note"].includes(name)) {
          const d = text(kid(n, "desc")) || text(n);
          if (d) interjections.push(d);
          main += " ";
        } else walk(n.children);
      }
    }
  };
  walk(seg.children);
  return { seq, text: squash(main), interjections };
}

export function parseIgcDay(xml: string): IgcDay {
  const root = parseXml(xml);
  let lthing: number | null = null, fundur: string | null = null;
  for (const m of descendants(root, "meeting")) {
    const ana = attr(m, "ana") ?? "";
    if (ana.includes("#parla.session")) lthing = Number(attr(m, "n"));
    else if (ana.includes("#parla.meeting")) fundur = attr(m, "n") ?? null;
  }
  // the sitting's date is the sourceDesc/bibl date (the publicationStmt date is the corpus release)
  const hdr = kid(root, "teiHeader");
  const date = [...descendants(kid(hdr, "fileDesc"), "sourceDesc").flatMap((s) => descendants(s, "date")), ...descendants(kid(hdr, "profileDesc"), "date")]
    .map((d) => attr(d, "when")).find(Boolean) ?? null;
  const utterances: IgcUtterance[] = [];
  for (const u of descendants(root, "u")) {
    const ana = attr(u, "ana") ?? "";
    const issue = /#issue\.(\d+_\d+)_/.exec(ana)?.[1] ?? null;
    const paragraphs = descendants(u, "seg").map((s, i) => segParagraph(s, i)).filter((p) => p.text);
    paragraphs.forEach((p, i) => { p.seq = i; });
    utterances.push({
      uid: attr(u, "id") ?? "", who: (attr(u, "who") ?? "").replace(/^#/, ""), chair: ana.includes("#chair"), issue,
      source: attr(u, "source") ?? "", paragraphs,
    });
  }
  return { id: attr(root, "id") ?? "", lthing, fundur, date, utterances };
}

export interface IgcPerson { memberId: number | null; name: string }

/** listPerson of the corpus root: xml:id → Alþingi member id (`idno type="URL"` …nfaerslunr=N); null when absent or ambiguous. */
export function parseIgcPersons(xml: string): Map<string, IgcPerson> {
  const out = new Map<string, IgcPerson>();
  for (const p of descendants(parseXml(xml), "person")) {
    const ids = new Set<number>();
    for (const i of descendants(p, "idno")) {
      const m = /nfaerslunr=(\d+)/.exec(text(i));
      if (m) ids.add(Number(m[1]));
    }
    const pn = kid(p, "persName");
    const name = [...descendants(pn, "forename"), ...descendants(pn, "surname")].map(text).filter(Boolean).join(" ");
    out.set(attr(p, "id") ?? "", { memberId: ids.size === 1 ? [...ids][0]! : null, name });
  }
  return out;
}

export interface Stitched { paragraphs: Paragraph[]; uids: string[]; otherUids: string[] }

/**
 * One record (all <u> sharing a source URL, in document order) → the row's text. Kept: utterances whose person is
 * `memberId`. Other speakers' words are attached as interjections ("Name: words") to the nearest kept paragraph.
 * Returns null when no utterance is by the member (the row stays unlinked).
 */
export function stitch(group: IgcUtterance[], memberId: number, persons: Map<string, IgcPerson>): Stitched | null {
  const mine = group.filter((u) => persons.get(u.who)?.memberId === memberId);
  if (!mine.length) return null;
  const paragraphs: Paragraph[] = [];
  const uids: string[] = [], otherUids: string[] = [];
  let pending: string[] = [];
  for (const u of group) {
    if (mine.includes(u)) {
      uids.push(u.uid);
      for (const p of u.paragraphs) {
        paragraphs.push({ seq: paragraphs.length, text: p.text, interjections: [...pending, ...p.interjections] });
        pending = [];
      }
    } else {
      otherUids.push(u.uid);
      const words = u.paragraphs.map((p) => p.text).join(" ");
      if (!words) continue;
      const line = `${persons.get(u.who)?.name || u.who}: ${words}`;
      if (paragraphs.length) paragraphs[paragraphs.length - 1]!.interjections.push(line);
      else pending.push(line);
    }
  }
  if (pending.length && paragraphs.length) paragraphs[paragraphs.length - 1]!.interjections.push(...pending);
  return paragraphs.length ? { paragraphs, uids, otherUids } : null;
}

export interface IgcResult { files: number; rows: number; skipped: number; errors: number; notes: Record<string, number> }

interface Row { id: string; member_id: number | null; text_state: string; text_source: string | null; raw_sha256: string | null }

/**
 * Load IGC texts into existing SGML-era rows only. Idempotent: same payload sha → no-op. Alþingi text always wins:
 * a row is written only while `text_state = 'unavailable'` or its text already came from IGC.
 */
export async function igcIngest(sql: Sql, path: string, f: { from?: number; to?: number } = {}, log: (s: string) => void = () => {}, opts: { limit?: number } = {}): Promise<IgcResult> {
  const r: IgcResult = { files: 0, rows: 0, skipped: 0, errors: 0, notes: {} };
  const bump = (k: string, n = 1) => { r.notes[k] = (r.notes[k] ?? 0) + n; };
  const from = f.from ?? 115, to = f.to ?? 130;
  const rootFile = readdirSync(path).find((n) => /^IGC-Parla.*\.xml$/.test(n));
  if (!rootFile) throw new Error(`no corpus root (IGC-Parla-*.xml with listPerson) under ${path}`);
  const persons = parseIgcPersons(readFileSync(join(path, rootFile), "utf8"));
  log(`igc: ${persons.size} persons, ${[...persons.values()].filter((p) => p.memberId).length} with a member id`);

  const rows = new Map<string, Row>();
  for (const x of await sql<(Row & { source_url: string })[]>`
    select id, member_id, text_state, text_source, raw_sha256, source_url from speeches
    where era = 'sgml' and source_url is not null and lthing between ${from} and ${to}`) rows.set(normUrl(x.source_url), x);
  log(`igc: ${rows.size} SGML-era rows in sessions ${from}–${to}`);

  const ver = lemmaVersion();
  const files: string[] = [];
  for (const y of readdirSync(path).filter((n) => /^\d{4}$/.test(n)).sort()) {
    if (Number(y) < 1991) continue; // earlier files use other URL schemes (docs/IGC.md §6)
    const dir = join(path, y);
    if (!statSync(dir).isDirectory()) continue;
    for (const n of readdirSync(dir).sort()) if (n.endsWith(".xml")) files.push(join(dir, n));
  }
  const t0 = Date.now();
  let written = 0;
  for (const file of files) {
    if (opts.limit !== undefined && r.rows >= opts.limit) break;
    let xml: string;
    try { xml = readFileSync(file, "utf8"); } catch { r.errors++; bump("unreadable"); continue; }
    const session = igcSession(xml);
    if (session === null || session < from || session > to) continue;
    r.files++;
    let day: IgcDay;
    try { day = parseIgcDay(xml); } catch (e) { r.errors++; bump("unparseable"); log(`igc: ${file}: ${(e as Error).message}`); continue; }
    const groups = new Map<string, IgcUtterance[]>();
    for (const u of day.utterances) {
      const k = normUrl(u.source);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(u);
    }
    for (const [url, group] of groups) {
      if (opts.limit !== undefined && r.rows >= opts.limit) break;
      const row = rows.get(url);
      if (!row) { bump("no row (IGC-only record)"); continue; }
      if (row.member_id === null) { r.skipped++; bump("row without member id"); continue; }
      const eligible = row.text_state === "unavailable" || (row.text_source ?? "").startsWith("igc-");
      if (!eligible) { r.skipped++; bump("Alþingi text present, kept"); continue; }
      const st = stitch(group, row.member_id, persons);
      if (!st) { r.skipped++; bump("speaker mismatch, unlinked"); continue; }
      const sha = sha256(JSON.stringify({ uids: st.uids, paragraphs: st.paragraphs }));
      if (row.text_state === "done" && row.raw_sha256 === sha && row.text_source === IGC_VERSION) { r.skipped++; bump("same sha"); continue; }
      await saveSpeechText(sql, {
        id: row.id, speakerAbbr: null, office: null, tegr: null, tegflm: null, nefnd: null, continued: null, speakerCapacity: null,
      }, st.paragraphs, {
        rawSha256: sha, lemmaVersion: ver, analyze, textSource: IGC_VERSION, provisional: false,
        sourceRef: `${day.id}:${st.uids.map((u) => u.replace(/^.*\./, "")).join(",")}`,
      });
      rows.set(url, { ...row, text_state: "done", text_source: IGC_VERSION, raw_sha256: sha });
      r.rows++;
      bump(group.length > 1 ? "stitched from a split record" : "single utterance");
      if (++written % 500 === 0) log(`igc: ${written} stored, ${(written / ((Date.now() - t0) / 1000)).toFixed(1)}/s`);
    }
  }
  return r;
}

// L0 of docs/INGEST.md: Alþingi's bulk export on disk → the database. Zero requests, never takes the crawl lock.
//   hashDrop       every file → dump_files (sha256); a changed or new file is queued (parsed_at null)
//   dumpSpeeches   raedur/ then raedur_bradabirgda/: index row + text in one pass; equal sha = no-op
//   dumpSittings   fundir/, dagskra/, lidaskjol/: sittings, items, events, agenda, speech order, votes, ballots, sponsors
//   dumpMisc       utbyting/, fjarvist(ir)/, inn/: documents, sponsors, absences, seat returns
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Queryable, type Sql, saveSpeechText } from "./db.ts";
import { AbbrResolver } from "./derive.ts";
import {
  type DumpMatter, METHOD, ORIGINATING_DOC, idTime, parseDagskra, parseDumpSpeech, parseFjarvist, parseFundur, parseInn,
  parseLidaskjal, parseUtbyting, speechXmlUrl,
} from "./dump.ts";
import { sha256 } from "./ingest.ts";
import { analyze, lemmaText, lemmaVersion } from "./lemma.ts";
import { decodeCapacity } from "./parse.ts";

/** Bump one entry to force a reparse of that directory type on the next run, without a new drop. */
export const PARSER_REV: Record<string, number> = {
  raedur: 1, raedur_bradabirgda: 1, fundir: 1, dagskra: 1, lidaskjol: 1, utbyting: 1, fjarvist: 1, fjarvistir: 1, inn: 1,
};

export interface StepResult { files: number; rows: number; skipped: number; errors: number; notes: Record<string, number> }
const result = (): StepResult => ({ files: 0, rows: 0, skipped: 0, errors: 0, notes: {} });
const bump = (r: StepResult, k: string, n = 1) => { r.notes[k] = (r.notes[k] ?? 0) + n; };

export interface Filter { from?: number; to?: number }
const inRange = (l: number, f: Filter) => (f.from === undefined || l >= f.from) && (f.to === undefined || l <= f.to);

// ---------------------------------------------------------------- hash

/**
 * Hash every file under `root/<lthing>/<dir>/` into dump_files. Only new or changed files are written (and queued);
 * an identical tree at the same path reuses its drop row, so re-hashing an unchanged drop writes nothing.
 */
export async function hashDrop(sql: Sql, root: string, f: Filter = {}, log: (s: string) => void = () => {}): Promise<{ dropId: number; files: number; changed: number; reused: boolean }> {
  const files: { lthing: number; dir: string; name: string; sha256: string; bytes: number; mtime: Date }[] = [];
  for (const l of readdirSync(root)) {
    if (!/^\d+$/.test(l) || !inRange(Number(l), f)) continue; // "Copy of 151" and friends are ignored
    for (const dir of readdirSync(join(root, l))) {
      const dpath = join(root, l, dir);
      if (!statSync(dpath).isDirectory()) continue;
      for (const name of readdirSync(dpath)) {
        if (!name.endsWith(".xml")) continue;
        const p = join(dpath, name);
        const buf = readFileSync(p);
        files.push({ lthing: Number(l), dir, name, sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length, mtime: statSync(p).mtime });
      }
    }
  }
  files.sort((a, b) => a.lthing - b.lthing || a.dir.localeCompare(b.dir) || a.name.localeCompare(b.name));
  const tree = createHash("sha256");
  for (const x of files) tree.update(`${x.lthing}/${x.dir}/${x.name}\t${x.sha256}\n`);
  const treeSha = tree.digest("hex");
  log(`dump hash: ${files.length} files under ${root}, tree ${treeSha.slice(0, 12)}`);

  const [same] = await sql<{ id: number }[]>`select id from dump_drops where path = ${root} and tree_sha256 = ${treeSha} order by id desc limit 1`;
  const known = new Map<string, string>();
  for (const r of await sql<{ k: string; sha256: string }[]>`
    select lthing || '/' || dir || '/' || name as k, sha256 from dump_files
    where lthing between ${f.from ?? 0} and ${f.to ?? 9999}`) known.set(r.k, r.sha256);
  const changed = files.filter((x) => known.get(`${x.lthing}/${x.dir}/${x.name}`) !== x.sha256);
  if (same && !changed.length) return { dropId: same.id, files: files.length, changed: 0, reused: true };

  const maxTs = files.filter((x) => x.dir === "raedur").map((x) => /(\d{8}T\d{6})/.exec(x.name)?.[1]).filter(Boolean).sort().pop();
  const dropId = same?.id ?? (await sql<{ id: number }[]>`
    insert into dump_drops (path, tree_sha256, files, max_speech_ts)
    values (${root}, ${treeSha}, ${files.length}, ${maxTs ? idTime(`rad${maxTs}`).started : null}) returning id`)[0]!.id;
  for (let i = 0; i < changed.length; i += 1000) {
    const c = changed.slice(i, i + 1000).map((x) => ({ ...x, drop_id: dropId, parsed_at: null, parser_rev: null }));
    await sql`
      insert into dump_files ${sql(c)}
      on conflict (lthing, dir, name) do update set drop_id = excluded.drop_id, sha256 = excluded.sha256, bytes = excluded.bytes,
        mtime = excluded.mtime, parsed_at = null, parser_rev = null`;
  }
  log(`dump hash: drop ${dropId}, ${changed.length} new/changed files queued`);
  return { dropId, files: files.length, changed: changed.length, reused: false };
}

interface QueuedFile { lthing: number; dir: string; name: string; sha256: string; path: string }

/** Files of `dirs` that are new/changed or were parsed by an older parser revision, in time (= name) order. */
async function queue(sql: Sql, dirs: string[], f: Filter): Promise<QueuedFile[]> {
  const out: QueuedFile[] = [];
  for (const dir of dirs) {
    const rows = await sql<{ lthing: number; dir: string; name: string; sha256: string; root: string }[]>`
      select df.lthing, df.dir, df.name, df.sha256, d.path as root from dump_files df join dump_drops d on d.id = df.drop_id
      where df.dir = ${dir} and (df.parsed_at is null or coalesce(df.parser_rev, 0) < ${PARSER_REV[dir] ?? 1})
        and df.lthing between ${f.from ?? 0} and ${f.to ?? 9999}
      order by df.lthing, df.name`;
    out.push(...rows.map((r) => ({ lthing: r.lthing, dir: r.dir, name: r.name, sha256: r.sha256, path: join(r.root, String(r.lthing), r.dir, r.name) })));
  }
  return out;
}

async function markParsed(sql: Queryable, q: QueuedFile): Promise<void> {
  await sql`update dump_files set parsed_at = now(), parser_rev = ${PARSER_REV[q.dir] ?? 1} where lthing = ${q.lthing} and dir = ${q.dir} and name = ${q.name}`;
}

const REGULAR = /^rad\d{8}T\d{6}\.xml$/;
const ref = (q: QueuedFile) => `${q.lthing}/${q.dir}/${q.name.trim()}`;

// ---------------------------------------------------------------- speeches

/**
 * Precedence (docs/INGEST.md §2): final (service = dump, same bytes) > provisional. Equal sha on a final = no-op.
 * A different final sha rewrites the text, keeps the old sha in speech_revisions and sets revised_at.
 * A provisional text never replaces a final, and is replaced by any final.
 */
export async function dumpSpeeches(sql: Sql, f: Filter = {}, log: (s: string) => void = () => {}, opts: { limit?: number } = {}): Promise<StepResult> {
  const r = result();
  const ver = lemmaVersion();
  const files = await queue(sql, ["raedur", "raedur_bradabirgda"], f);
  // ids that have a properly named final file (`radYYYYMMDDTHHMMSS.xml`): such a file beats both an irregularly named
  // twin (` rad….xml` exists next to `rad….xml` with different bytes in 157) and any provisional text
  const regular = new Set<string>();
  for (const x of await sql<{ lthing: number; name: string }[]>`select lthing, name from dump_files where dir = 'raedur'`) {
    if (REGULAR.test(x.name)) regular.add(x.name.slice(0, -4));
  }
  const t0 = Date.now();
  let lemmatized = 0;
  for (const q of files.slice(0, opts.limit ?? files.length)) {
    r.files++;
    const provisional = q.dir === "raedur_bradabirgda";
    const stem = /(\d{8}T\d{6})/.exec(q.name)?.[1];
    if (!provisional && !REGULAR.test(q.name) && stem && regular.has(`rad${stem}`)) {
      r.skipped++; bump(r, "irregular name, regular twin exists"); await markParsed(sql, q); continue;
    }
    let xml: string;
    try { xml = readFileSync(q.path, "utf8"); } catch { r.errors++; bump(r, "unreadable"); continue; }
    if (!/<(?:\w+:)?ræða[\s>]/.test(xml)) { r.errors++; bump(r, "not a speech"); await markParsed(sql, q); continue; }
    let s;
    try { s = parseDumpSpeech(q.name, xml); } catch { r.errors++; bump(r, "unparseable"); await markParsed(sql, q); continue; }
    const id = s.fileId;
    const lthing = s.lthing ?? q.lthing;
    const sha = sha256(xml);
    const [cur] = await sql<{ text_state: string; raw_sha256: string | null; provisional: boolean }[]>`
      select text_state, raw_sha256, provisional from speeches where id = ${id}`;
    const isFinal = cur?.text_state === "done" && !cur.provisional;
    if (provisional && (isFinal || regular.has(id))) { r.skipped++; bump(r, "provisional: final exists"); await markParsed(sql, q); continue; }
    if (cur?.text_state === "done" && cur.raw_sha256 === sha && cur.provisional === provisional) { r.skipped++; bump(r, "same sha"); await markParsed(sql, q); continue; }
    if (s.paragraphs.length === 0) { r.errors++; bump(r, "no paragraphs"); await markParsed(sql, q); continue; }

    if (!cur) {
      const { started, date } = idTime(id);
      const cls = s.matter?.cls ?? null;
      await sql.begin(async (tx) => {
        if (s.matter && cls) {
          await tx`insert into matters (lthing, cls, nr, title, stub, title_lemmas) values (${lthing}, ${cls}, ${s.matter.nr}, ${s.matter.title}, true, ${lemmaText(s.matter.title)})
                   on conflict (lthing, cls, nr) do nothing`;
        }
        await tx`
          insert into speeches (id, lthing, fundur, member_id, member_name, speaker_abbr, office, tegr, tegflm, speech_date, started,
            type, debate, matter_cls, matter_nr, xml_url, era, text_state, index_source, source_ref)
          values (${id}, ${lthing}, ${s.fundur}, null, ${s.speakerAbbr}, ${s.speakerAbbr}, ${s.office}, ${s.tegr}, ${s.tegflm}, ${date}, ${started},
            ${s.type}, '', ${cls}, ${cls ? s.matter!.nr : null}, ${speechXmlUrl(lthing, id)}, 'xml', 'pending', 'dump', ${ref(q)})`;
      });
      bump(r, provisional ? "new provisional speech" : "new speech");
    } else if (isFinal && !provisional) {
      await sql`insert into speech_revisions (speech_id, raw_sha256, source) values (${id}, ${cur.raw_sha256 ?? ""}, 'replaced') on conflict do nothing`;
      await sql`update speeches set revised_at = now() where id = ${id}`;
      bump(r, "revised (different final sha)");
    } else {
      bump(r, cur.provisional && !provisional ? "provisional → final" : `text for ${cur.text_state} row`);
    }
    await saveSpeechText(sql, {
      id, speakerAbbr: s.speakerAbbr, office: s.office, tegr: s.tegr, tegflm: s.tegflm, nefnd: s.nefnd,
      continued: s.continued, speakerCapacity: decodeCapacity(s.tegflm),
    }, s.paragraphs, {
      rawSha256: sha, lemmaVersion: ver, analyze,
      textSource: provisional ? "dump-provisional" : "dump", provisional, sourceRef: ref(q),
    });
    await markParsed(sql, q);
    r.rows++;
    if (++lemmatized % 200 === 0) log(`dump speeches: ${lemmatized} stored, ${(lemmatized / ((Date.now() - t0) / 1000)).toFixed(1)}/s`);
  }
  return r;
}

// ---------------------------------------------------------------- sponsors (several files describe the same list)

const SPONSOR_PRIORITY: Record<string, number> = { lidaskjol: 1, utbyting: 2, dagskra: 3, fundir: 4 };

/** First source by priority wins, then the first file (time order) of that source; the list order is kept. */
async function setSponsors(tx: Queryable, res: AbbrResolver, lthing: number, cls: string, nr: number, list: { abbr: string; office: string | null }[], source: string): Promise<number> {
  if (!list.length) return 0;
  const [cur] = await tx<{ source: string }[]>`select source from matter_sponsors where lthing = ${lthing} and cls = ${cls} and nr = ${nr} limit 1`;
  if (cur && (SPONSOR_PRIORITY[cur.source] ?? 9) <= (SPONSOR_PRIORITY[source] ?? 9)) return 0;
  await tx`delete from matter_sponsors where lthing = ${lthing} and cls = ${cls} and nr = ${nr}`;
  const rows = list.map((s, i) => ({ lthing, cls, nr, seq: i + 1, abbr: s.abbr, member_id: res.resolve(lthing, s.abbr), office: s.office, source }));
  return (await tx`insert into matter_sponsors ${tx(rows)} on conflict do nothing`).count;
}

async function stubMatter(tx: Queryable, lthing: number, m: DumpMatter | null): Promise<void> {
  if (!m || !m.title) return;
  await tx`insert into matters (lthing, cls, nr, title, stub, title_lemmas) values (${lthing}, ${m.cls}, ${m.nr}, ${m.title}, true, ${lemmaText(m.title)})
           on conflict (lthing, cls, nr) do nothing`;
}

// ---------------------------------------------------------------- sittings

export async function dumpSittings(sql: Sql, f: Filter = {}, log: (s: string) => void = () => {}): Promise<StepResult> {
  const r = result();
  const res = await AbbrResolver.load(sql);
  for (const q of await queue(sql, ["fundir", "dagskra", "lidaskjol"], f)) {
    r.files++;
    let xml: string;
    try { xml = readFileSync(q.path, "utf8"); } catch { r.errors++; continue; }
    try {
      await sql.begin(async (tx) => {
        if (q.dir === "fundir") r.rows += await fundir(tx, res, q, xml);
        else if (q.dir === "dagskra") r.rows += await dagskra(tx, res, q, xml);
        else r.rows += await lidaskjol(tx, res, q, xml, r);
        await markParsed(tx, q);
      });
    } catch (e) {
      r.errors++;
      bump(r, `error ${q.dir}`);
      log(`dump sittings: ${ref(q)} failed: ${(e as Error).message}`);
    }
    if (r.files % 500 === 0) log(`dump sittings: ${r.files} files, ${r.rows} rows`);
  }
  return r;
}

async function fundir(tx: Queryable, res: AbbrResolver, q: QueuedFile, xml: string): Promise<number> {
  const d = parseFundur(xml);
  if (d.lthing < 0 || d.fundur < 0) return 0;
  let n = (await tx`
    insert into sittings (lthing, fundur, starts, ends, source_ref) values (${d.lthing}, ${d.fundur}, ${d.starts}, ${d.ends}, ${ref(q)})
    on conflict (lthing, fundur) do update set starts = excluded.starts, ends = excluded.ends, source_ref = excluded.source_ref
    where (sittings.starts, sittings.ends) is distinct from (excluded.starts, excluded.ends)`).count;
  const keep = new Map((await tx<{ lid_id: string; vote_flag: boolean | null }[]>`
    select lid_id, vote_flag from sitting_items where lthing = ${d.lthing} and fundur = ${d.fundur} and lid_id is not null`).map((x) => [x.lid_id, x.vote_flag]));
  await tx`delete from sitting_items where lthing = ${d.lthing} and fundur = ${d.fundur}`;
  await tx`delete from sitting_events where lthing = ${d.lthing} and fundur = ${d.fundur}`;
  const items = d.items.map((it, seq) => ({
    lthing: d.lthing, fundur: d.fundur, seq, lid_id: it.lidId, cls: it.matter?.cls ?? null, nr: it.matter?.nr ?? null,
    started: it.at, debate: it.matter?.debate ?? null, vote_flag: (it.lidId && keep.get(it.lidId)) ?? null,
  }));
  if (items.length) n += (await tx`insert into sitting_items ${tx(items)}`).count;
  const ev = [...new Map(d.events.map((e) => [`${e.at}|${e.kind}|${e.cls}|${e.nr}`, e])).values()]
    .map((e) => ({ lthing: d.lthing, fundur: d.fundur, at: e.at, kind: e.kind, cls: e.cls, nr: e.nr, doc_nr: e.docNr }));
  if (ev.length) n += (await tx`insert into sitting_events ${tx(ev)}`).count;
  for (const it of d.items) {
    await stubMatter(tx, d.lthing, it.matter);
    if (it.matter) n += await setSponsors(tx, res, d.lthing, it.matter.cls, it.matter.nr, it.matter.sponsors, "fundir");
  }
  return n;
}

async function dagskra(tx: Queryable, res: AbbrResolver, q: QueuedFile, xml: string): Promise<number> {
  const d = parseDagskra(xml);
  if (d.lthing < 0 || d.fundur < 0) return 0;
  await tx`delete from agenda_items where lthing = ${d.lthing} and fundur = ${d.fundur}`;
  const rows = d.items.map((it) => ({
    lthing: d.lthing, fundur: d.fundur, seq: it.seq, cls: it.matter?.cls ?? null, nr: it.matter?.nr ?? null, title: it.title,
    doc_nr: it.docNr, off_agenda: it.offAgenda, parent_seq: it.parentSeq,
  }));
  let n = rows.length ? (await tx`insert into agenda_items ${tx(rows)}`).count : 0;
  for (const it of d.items) if (it.matter) n += await setSponsors(tx, res, d.lthing, it.matter.cls, it.matter.nr, it.matter.sponsors, "dagskra");
  return n;
}

async function lidaskjol(tx: Queryable, res: AbbrResolver, q: QueuedFile, xml: string, r: StepResult): Promise<number> {
  const d = parseLidaskjal(xml);
  if (d.lthing < 0) return 0;
  const lid = q.name.trim().replace(/\.xml$/, "");
  const m = d.matter;
  let n = 0;
  await stubMatter(tx, d.lthing, m);
  if (m) n += await setSponsors(tx, res, d.lthing, m.cls, m.nr, m.sponsors, "lidaskjol");

  // speech order: replace this item's rows; speech ids are linked by derive
  const speeches = d.parts.flatMap((p) => p.speeches).map((s, seq) => ({
    lid_id: lid, seq, lthing: d.lthing, fundur: d.fundur, cls: m?.cls ?? null, nr: m?.nr ?? null, debate: m?.debate ?? null,
    abbr: s.abbr, started: s.started, tegr: s.tegr, tegflm: s.tegflm, office: s.office, continued: s.continued,
  }));
  await tx`delete from sitting_speeches where lid_id = ${lid}`;
  if (speeches.length) n += (await tx`insert into sitting_speeches ${tx(speeches)}`).count;
  const flag = d.parts.some((p) => p.voteFlag);
  n += (await tx`update sitting_items set vote_flag = ${flag} where lid_id = ${lid} and vote_flag is distinct from ${flag}`).count;

  for (const v of d.parts.flatMap((p) => p.votes)) {
    // a few items carry a vote but no <mál> (157: one, "þskj. í 1. dagskrármáli"): the voted document names the matter
    let vm: { cls: string; nr: number } | null = m;
    if (!vm && v.docNr !== null) {
      const [doc] = await tx<{ cls: string; nr: number }[]>`
        select matter_cls as cls, matter_nr as nr from documents where lthing = ${d.lthing} and nr = ${v.docNr} and matter_nr is not null
        union all select cls, nr from votes where id = ${v.id} limit 1`;
      vm = doc ?? null;
    }
    if (!vm) { bump(r, "vote without matter"); continue; }
    const row = {
      id: v.id, lthing: d.lthing, cls: vm.cls, nr: vm.nr, voted_at: v.at, kind_label: v.label || v.docType || v.kindCode2 || "",
      doc_nr: v.docNr, method: v.methodCode ? METHOD[v.methodCode] ?? null : null, yes: v.yes, no: v.no, abstain: v.abstain,
      source: "dump", method_code: v.methodCode, kind_code2: v.kindCode2, unanimous: v.unanimous,
    };
    n += (await tx`
      insert into votes ${tx(row)}
      on conflict (id) do update set method_code = excluded.method_code, kind_code2 = excluded.kind_code2, unanimous = excluded.unanimous,
        yes = excluded.yes, no = excluded.no, abstain = excluded.abstain,
        doc_nr = coalesce(votes.doc_nr, excluded.doc_nr), voted_at = coalesce(votes.voted_at, excluded.voted_at),
        method = coalesce(votes.method, excluded.method)
      where (votes.method_code, votes.kind_code2, votes.unanimous, votes.yes, votes.no, votes.abstain)
              is distinct from (excluded.method_code, excluded.kind_code2, excluded.unanimous, excluded.yes, excluded.no, excluded.abstain)
         or (votes.doc_nr is null and excluded.doc_nr is not null) or (votes.voted_at is null and excluded.voted_at is not null)
         or (votes.method is null and excluded.method is not null)`).count;
    if (!v.ballots.length) continue;
    const seen = new Map(v.ballots.map((b) => [b.abbr, b.choice]));
    const resolved: { vote_id: number; member_id: number; choice: string; source: string }[] = [];
    const parked: { vote_id: number; abbr: string; choice: string; lthing: number }[] = [];
    for (const [abbr, choice] of seen) {
      const id = res.resolve(d.lthing, abbr);
      if (id) resolved.push({ vote_id: v.id, member_id: id, choice, source: "dump" });
      else parked.push({ vote_id: v.id, abbr, choice, lthing: d.lthing });
    }
    // the service's ballots (if any) carry 'boðaði fjarvist', which the dump folds into fjarverandi: they are kept
    const uniq = [...new Map(resolved.map((b) => [b.member_id, b])).values()];
    if (uniq.length) n += (await tx`insert into ballots ${tx(uniq)} on conflict (vote_id, member_id) do nothing`).count;
    if (parked.length) {
      n += (await tx`insert into ballots_unresolved ${tx(parked)} on conflict (vote_id, abbr) do update set choice = excluded.choice
                     where ballots_unresolved.choice <> excluded.choice`).count;
    }
  }
  return n;
}

// ---------------------------------------------------------------- misc

export async function dumpMisc(sql: Sql, f: Filter = {}, log: (s: string) => void = () => {}): Promise<StepResult> {
  const r = result();
  const res = await AbbrResolver.load(sql);
  for (const q of await queue(sql, ["utbyting", "fjarvist", "fjarvistir", "inn"], f)) {
    r.files++;
    let xml: string;
    try { xml = readFileSync(q.path, "utf8"); } catch { r.errors++; continue; }
    try {
      await sql.begin(async (tx) => {
        if (q.dir === "utbyting") r.rows += await utbyting(tx, res, q, xml);
        else if (q.dir === "inn") r.rows += await people(tx, res, xml, "seat_returns");
        else r.rows += await people(tx, res, xml, "absences");
        await markParsed(tx, q);
      });
    } catch (e) {
      r.errors++;
      log(`dump misc: ${ref(q)} failed: ${(e as Error).message}`);
    }
  }
  return r;
}

async function utbyting(tx: Queryable, res: AbbrResolver, q: QueuedFile, xml: string): Promise<number> {
  const d = parseUtbyting(xml);
  if (d.lthing < 0) return 0;
  let n = 0;
  const docs = [...new Map(d.docs.map((x) => [x.nr, x])).values()];
  if (docs.length) {
    const rows = docs.map((x) => ({
      lthing: d.lthing, nr: x.nr, matter_cls: x.matterNr !== null ? "A" : null, matter_nr: x.matterNr, type: x.type,
      distributed_at: d.at, title: x.title || null, source: "dump",
    }));
    n += (await tx`
      insert into documents ${tx(rows)}
      on conflict (lthing, nr) do update set distributed_at = coalesce(documents.distributed_at, excluded.distributed_at),
        title = coalesce(documents.title, excluded.title), matter_cls = coalesce(documents.matter_cls, excluded.matter_cls),
        matter_nr = coalesce(documents.matter_nr, excluded.matter_nr)
      where (documents.distributed_at is null and excluded.distributed_at is not null) or (documents.title is null and excluded.title is not null)
         or (documents.matter_nr is null and excluded.matter_nr is not null)`).count;
  }
  for (const x of docs.sort((a, b) => a.nr - b.nr)) {
    if (x.matterNr === null || !ORIGINATING_DOC.test(x.type)) continue;
    n += await setSponsors(tx, res, d.lthing, "A", x.matterNr, x.sponsors, "utbyting");
  }
  return n;
}

async function people(tx: Queryable, res: AbbrResolver, xml: string, table: "absences" | "seat_returns"): Promise<number> {
  const d = table === "absences" ? parseFjarvist(xml) : parseInn(xml);
  if (d.lthing < 0 || d.fundur < 0 || !d.people.length) return 0;
  const rows = [...new Map(d.people.map((p) => [p.abbr, p])).values()].map((p) => ({
    lthing: d.lthing, fundur: d.fundur, date: d.date, abbr: p.abbr, member_id: res.resolve(d.lthing, p.abbr), office: p.office,
  }));
  if (table === "absences") {
    return (await tx`insert into absences ${tx(rows.map((x) => ({ ...x, source: "dump" })))} on conflict (lthing, fundur, abbr) do update
      set office = excluded.office, date = excluded.date where (absences.office, absences.date) is distinct from (excluded.office, excluded.date)`).count;
  }
  return (await tx`insert into seat_returns ${tx(rows)} on conflict (lthing, fundur, abbr) do update
    set office = excluded.office, date = excluded.date where (seat_returns.office, seat_returns.date) is distinct from (excluded.office, excluded.date)`).count;
}


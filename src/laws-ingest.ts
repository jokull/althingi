// laws step (docs/INGEST.md §3 Laws, owner decision §8.4): the law collection zip → laws, law_articles, law_amendments.
// Metadata + amendment graph; article text is stored, not lemmatized or searchable yet. Zero requests with --zip;
// otherwise ONE conditional GET of https://www.althingi.is/lagasafn/zip/nuna/allt.zip (the fetcher's only binary path).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Sql, getState, recordFetch, recordedFetch, setState } from "./db.ts";
import { Fetcher } from "./fetcher.ts";
import { CHAPTER_FILE, LAW_FILE, latin1, parseChapterIndex, parseLaw } from "./laws.ts";

export const LAW_ZIP_URL = "https://www.althingi.is/lagasafn/zip/nuna/allt.zip";

export interface LawsOpts { zip?: string; log: (s: string) => void; dataDir?: string; fetcher?: Fetcher; force?: boolean }

/** Parse an unpacked collection directory into the three tables. Returns rows written. */
export async function ingestLawDir(sql: Sql, dir: string, log: (s: string) => void = () => {}): Promise<{ laws: number; skipped: number; edition: string | null }> {
  const names = readdirSync(dir);
  const chapters = new Map<string, string>();
  let edition: string | null = null;
  for (const n of names.filter((x) => CHAPTER_FILE.test(x)).sort()) {
    const c = parseChapterIndex(latin1(readFileSync(join(dir, n))));
    edition ??= c.edition;
    for (const l of c.laws) if (!chapters.has(l.file)) chapters.set(l.file, l.chapter);
  }
  const files = names.filter((x) => x.endsWith(".html") && /^\d/.test(x) && !CHAPTER_FILE.test(x));
  const lawFiles = files.filter((x) => LAW_FILE.test(x));
  let laws = 0;
  for (let i = 0; i < lawFiles.length; i += 100) {
    await sql.begin(async (tx) => {
      for (const n of lawFiles.slice(i, i + 100)) {
        const html = latin1(readFileSync(join(dir, n)));
        const l = parseLaw(n, html);
        const ed = l.edition ?? edition ?? "nuna";
        await tx`
          insert into laws (year, nr, edition, title, chapter, in_force, matter_lthing, matter_nr, html, text, source_ref)
          values (${l.year}, ${l.nr}, ${ed}, ${l.title}, ${chapters.get(n.slice(0, 7)) ?? null}, ${l.inForce}, ${l.matter?.lthing ?? null},
                  ${l.matter?.nr ?? null}, ${html}, ${l.text}, ${`${ed}/${n}`})
          on conflict (year, nr, edition) do update set title = excluded.title, chapter = excluded.chapter, in_force = excluded.in_force,
            matter_lthing = excluded.matter_lthing, matter_nr = excluded.matter_nr, html = excluded.html, text = excluded.text,
            source_ref = excluded.source_ref
          where (laws.html, laws.title, laws.chapter, laws.in_force, laws.matter_lthing, laws.matter_nr, laws.text)
            is distinct from (excluded.html, excluded.title, excluded.chapter, excluded.in_force, excluded.matter_lthing, excluded.matter_nr, excluded.text)`;
        await tx`delete from law_articles where year = ${l.year} and nr = ${l.nr} and edition = ${ed}`;
        if (l.articles.length) {
          await tx`insert into law_articles ${tx(l.articles.map((a) => ({ year: l.year, nr: l.nr, edition: ed, article_id: a.id, heading: a.heading, text: a.text })))}`;
        }
        await tx`delete from law_amendments where year = ${l.year} and nr = ${l.nr}`;
        if (l.amendments.length) {
          await tx`insert into law_amendments ${tx(l.amendments.map((a) => ({ year: l.year, nr: l.nr, by_year: a.year, by_nr: a.nr, effective_text: a.effective })))}`;
        }
        laws++;
      }
    });
  }
  log(`laws: ${laws} laws (edition ${edition ?? "?"}), ${files.length - lawFiles.length} sub-part files skipped`);
  return { laws, skipped: files.length - lawFiles.length, edition };
}

export async function runLaws(sql: Sql, o: LawsOpts): Promise<{ requests: number; files: number; rows: number }> {
  const dataDir = o.dataDir ?? process.env.DATA_DIR ?? join(homedir(), "althingi", "data");
  let zipPath = o.zip;
  let requests = 0;
  if (!zipPath) {
    const f = o.fetcher ?? new Fetcher({ log: o.log });
    const rec = await recordedFetch(sql, LAW_ZIP_URL);
    const have = rec?.status === 200 && rec.path && existsSync(rec.path);
    const r = await f.getBinary(LAW_ZIP_URL, have ? { etag: rec!.etag, lastModified: rec!.last_modified } : {});
    requests = f.requests;
    const val = { etag: r.headers.etag ?? null, last_modified: r.headers["last-modified"] ?? null, headers: r.headers };
    if (r.status === 304 && have) {
      await recordFetch(sql, { url: LAW_ZIP_URL, status: 304, bytes: 0, sha256: null, path: null, ...val });
      o.log("laws: 304 not modified");
      return { requests, files: 0, rows: 0 };
    }
    if (r.status !== 200) throw new Error(`unexpected ${r.status} for ${LAW_ZIP_URL}`);
    mkdirSync(join(dataDir, "lagasafn"), { recursive: true });
    zipPath = join(dataDir, "lagasafn", "nuna-allt.zip");
    writeFileSync(zipPath, r.data);
    await recordFetch(sql, { url: LAW_ZIP_URL, status: 200, bytes: r.bytes, sha256: createHash("sha256").update(r.data).digest("hex"), path: zipPath, ...val });
  }
  const bytes = readFileSync(zipPath);
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (!o.force && (await getState<string>(sql, "lagasafn_zip_sha256")) === sha) {
    o.log(`laws: zip ${sha.slice(0, 12)} already ingested`);
    return { requests, files: 0, rows: 0 };
  }
  // unpack into its own new directory keyed by the zip's sha (untrusted archive: never executed, only read)
  const dir = join(dataDir, "lagasafn", `unz-${sha.slice(0, 12)}`);
  mkdirSync(dir, { recursive: true });
  const p = Bun.spawnSync(["unzip", "-q", "-o", "-j", zipPath, "*.html", "-d", dir], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`unzip failed: ${p.stderr.toString()}`);
  const r = await ingestLawDir(sql, dir, o.log);
  await setState(sql, "lagasafn_zip_sha256", sha);
  await setState(sql, "lagasafn_edition", r.edition);
  return { requests, files: r.laws, rows: r.laws };
}

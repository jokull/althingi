// A throwaway database seeded from the service fixtures (same as web.test.ts) plus a few hand-written rows for the
// dump-only tables (ballots, sponsors, sittings, laws), so agent-facing surfaces can be tested end to end.
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { type Sql, connect, migrate, upsertCommittees, upsertMatterDetail, upsertMatters, upsertMembers, upsertSeats, upsertSessions, upsertSpeechIndex } from "../src/db.ts";
import { ingestSpeechXml } from "../src/ingest.ts";
import { lemmaText } from "../src/lemma.ts";
import { parseCommittees, parseMatterDetail, parseMatterList, parseMembers, parseSeats, parseSessions, parseSpeechList } from "../src/parse.ts";

const ADMIN = process.env.TEST_PG ?? "postgres://postgres:dev@localhost:5433/postgres";
const fx = (p: string) => readFileSync(new URL(`../fixtures/${p}`, import.meta.url), "utf8");

export interface Seeded { sql: Sql; speechId: string; word: string; voteId: number; drop: () => Promise<void> }

export async function seed(name: string): Promise<Seeded | null> {
  const admin = postgres(ADMIN, { max: 1, onnotice: () => {} });
  try { await admin`select 1`; } catch (e) { console.warn("skipping (no Postgres):", (e as Error).message); await admin.end(); return null; }
  await admin.unsafe(`create database ${name}`);
  const sql = connect(ADMIN.replace(/\/[^/]*$/, `/${name}`));
  await migrate(sql);
  await upsertSessions(sql, parseSessions(fx("lthing.xml")));
  await upsertMembers(sql, parseMembers(fx("sample/thingmenn_157.xml")));
  await upsertMatters(sql, parseMatterList(fx("sample/thingmalalisti_157.xml")), lemmaText);
  await upsertSeats(sql, parseSeats(fx("sample/thingseta_633.xml")));
  await upsertCommittees(sql, parseCommittees(fx("sample/nefndir_157.xml")));
  await upsertMatterDetail(sql, parseMatterDetail(fx("sample/thingmal_157_300.xml")), lemmaText);
  await upsertSpeechIndex(sql, parseSpeechList(fx("days/d20180306.xml")), lemmaText);
  const speechId = "rad20180306T163325";
  await ingestSpeechXml(sql, speechId, fx("sample/speech_d20180306_rad20180306T163325_xml.xml"));
  const [p] = await sql<{ text: string }[]>`select text from paragraphs where speech_id = ${speechId} order by length(text) desc limit 1`;
  const word = p!.text.split(" ").map((w) => w.replace(/[^\p{L}]/gu, "")).find((w) => w.length > 7)!;
  // dump-only rows: one ballot per choice on the first vote of 157/A/300, a sponsor, a sitting with an agenda, a law
  const [v] = await sql<{ id: number }[]>`select id from votes where lthing = 157 and cls = 'A' and nr = 300 order by voted_at, id limit 1`;
  const ms = await sql<{ id: number }[]>`select id from members where id <> 633 order by id limit 2`;
  await sql`insert into ballots (vote_id, member_id, choice) values (${v!.id}, 633, 'já'), (${v!.id}, ${ms[0]!.id}, 'nei'), (${v!.id}, ${ms[1]!.id}, 'greiðir ekki atkvæði')`;
  await sql`insert into matter_sponsors (lthing, cls, nr, seq, abbr, member_id, office, source) values (157, 'A', 300, 1, 'ÞSv', 633, 'utanrrh.', 'lidaskjol')`;
  await sql`insert into sittings (lthing, fundur, name, starts, ends) values (157, 40, '40. fundur', '2025-12-01 13:30', '2025-12-01 19:00')`;
  await sql`insert into agenda_items (lthing, fundur, seq, cls, nr, title, doc_nr, off_agenda) values (157, 40, 0, 'A', 300, 'Tollalög', null, false)`;
  await sql`insert into sitting_events (lthing, fundur, at, kind, cls, nr) values (157, 40, '2025-12-01 13:30', 'fundurhefst', '', 0), (157, 40, '2025-12-01 15:00', 'umræðuLokið', 'A', 300)`;
  await sql`insert into laws (year, nr, edition, title, chapter, in_force, text) values (1991, 34, '157a', 'Lög um fjárfestingu erlendra aðila í atvinnurekstri', '7. Atvinnuvegir', 'Tóku gildi 1. júní 1991', '1. gr. Erlendum aðilum er heimilt...')`;
  await sql`insert into law_articles (year, nr, edition, article_id, heading, text) values (1991, 34, '157a', '1', '1. gr.', 'Erlendum aðilum er heimilt að fjárfesta í atvinnurekstri hér á landi.'), (1991, 34, '157a', '2', '2. gr.', 'Önnur grein.')`;
  return {
    sql, speechId, word, voteId: v!.id,
    drop: async () => { await sql.end(); await admin.unsafe(`drop database ${name} with (force)`); await admin.end(); },
  };
}

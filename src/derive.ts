// Derive step (docs/INGEST.md §3, §5): everything computed from rows already in the DB, zero requests.
//   sittings ↔ speeches links, speaker aliases (learned from service sightings), member ids on speeches / ballots /
//   sponsors / absences, debate codes for dump-only speeches, reply_to_id.
// Every update is guarded by "is distinct from", so a rerun over unchanged data writes nothing.
import type { Sql } from "./db.ts";

interface Evidence { lthing: number; abbr: string; member_id: number; n: number }

/**
 * abbr → member id. Order of trust: what the service said about speeches in the SAME session (learned evidence),
 * the session's seats (thingseta skammstöfun), the member list's current abbreviation, learned aliases from any session.
 * Ambiguous at a level (two ids) falls through to the next level; nothing resolves to a guess.
 */
export class AbbrResolver {
  private bySession = new Map<string, number>();
  private seats = new Map<string, number>();
  private members = new Map<string, number>();
  private global = new Map<string, number>();
  names = new Map<number, string>();

  static async load(sql: Sql): Promise<AbbrResolver> {
    const r = new AbbrResolver();
    await evidenceView(sql);
    const ev = await sql<Evidence[]>`
      select s.lthing, s.speaker_abbr as abbr, x.member_id, count(*)::int as n
      from speaker_evidence x join speeches s on s.id = x.speech_id
      where s.speaker_abbr is not null group by 1, 2, 3`;
    r.bySession = pickUnique(ev.map((e) => [`${e.lthing}|${e.abbr}`, e.member_id, e.n]));
    const seats = await sql<{ lthing: number; abbr: string; member_id: number }[]>`
      select distinct lthing, normalize(trim(abbr), NFC) as abbr, member_id from seats where abbr is not null and abbr <> ''`;
    r.seats = pickUnique(seats.map((s) => [`${s.lthing}|${s.abbr}`, s.member_id, 1]), true);
    const mem = await sql<{ id: number; abbr: string; name: string }[]>`select id, normalize(trim(coalesce(abbr, '')), NFC) as abbr, name from members`;
    r.members = pickUnique(mem.filter((m) => m.abbr).map((m) => [m.abbr, m.id, 1]), true);
    for (const m of mem) r.names.set(m.id, m.name);
    const al = await sql<{ abbr: string; member_id: number; n: number }[]>`select abbr, member_id, n from speaker_aliases`;
    r.global = pickUnique(al.map((a) => [a.abbr, a.member_id, a.n]));
    return r;
  }

  resolve(lthing: number, abbr: string | null | undefined): number | null {
    if (!abbr) return null;
    const a = abbr.normalize("NFC").trim();
    return this.bySession.get(`${lthing}|${a}`) ?? this.seats.get(`${lthing}|${a}`) ?? this.members.get(a) ?? this.global.get(a) ?? null;
  }
}

/** key → id; with `strict` a key claimed by two ids is dropped, otherwise the id with clearly most evidence (≥ 80 %) wins. */
function pickUnique(rows: [string, number, number][], strict = false): Map<string, number> {
  const by = new Map<string, Map<number, number>>();
  for (const [k, id, n] of rows) {
    const m = by.get(k) ?? new Map<number, number>();
    m.set(id, (m.get(id) ?? 0) + n);
    by.set(k, m);
  }
  const out = new Map<string, number>();
  for (const [k, m] of by) {
    if (m.size === 1) { out.set(k, [...m.keys()][0]!); continue; }
    if (strict) continue;
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const [best, n] = [...m].sort((a, b) => b[1] - a[1])[0]!;
    if (n / total >= 0.8) out.set(k, best);
  }
  return out;
}

export interface DeriveCounts { [k: string]: number }

/** speaker_evidence: one row per speech that the service attributed to a member id (sightings, legacy service rows). */
export async function evidenceView(sql: Sql): Promise<void> {
  await sql`
    create or replace view speaker_evidence as
      select distinct on (speech_id) speech_id, member_id from (
        select speech_id, member_id, 0 as pri from speaker_sightings
        union all
        select id, member_id, 1 from speeches where index_source is null and member_id > 0
      ) e order by speech_id, pri`;
}

export async function derive(sql: Sql, log: (s: string) => void = () => {}): Promise<DeriveCounts> {
  const c: DeriveCounts = {};
  const note = (k: string, n: number) => { c[k] = (c[k] ?? 0) + n; };
  await evidenceView(sql);

  // 1. lidaskjol rows ↔ speeches: exact stem first, then the same speaker within 120 s
  note("sitting_speeches.exact", (await sql`
    update sitting_speeches ss set speech_id = s.id from speeches s
    where ss.speech_id is null and s.id = 'rad' || to_char(ss.started, 'YYYYMMDD"T"HH24MISS')`).count);
  note("sitting_speeches.near", (await sql`
    update sitting_speeches ss set speech_id = m.id from (
      select distinct on (ss2.lid_id, ss2.seq) ss2.lid_id, ss2.seq, s.id
      from sitting_speeches ss2 join speeches s on s.lthing = ss2.lthing and s.speaker_abbr = ss2.abbr
        and s.started between ss2.started - interval '120 seconds' and ss2.started + interval '120 seconds'
      where ss2.speech_id is null
      order by ss2.lid_id, ss2.seq, abs(extract(epoch from s.started - ss2.started))) m
    where ss.lid_id = m.lid_id and ss.seq = m.seq`).count);

  // 2. aliases, rebuilt from evidence; only changed rows are written
  const fresh = await sql<{ abbr: string; member_id: number; n: number; first_seen: string; last_seen: string }[]>`
    select s.speaker_abbr as abbr, e.member_id, count(*)::int n, min(s.speech_date)::text first_seen, max(s.speech_date)::text last_seen
    from speaker_evidence e join speeches s on s.id = e.speech_id where s.speaker_abbr is not null group by 1, 2`;
  if (fresh.length) {
    note("speaker_aliases", (await sql`
      insert into speaker_aliases ${sql(fresh)}
      on conflict (abbr, member_id) do update set n = excluded.n, first_seen = excluded.first_seen, last_seen = excluded.last_seen
      where (speaker_aliases.n, speaker_aliases.first_seen, speaker_aliases.last_seen) is distinct from (excluded.n, excluded.first_seen, excluded.last_seen)`).count);
  }
  note("speaker_aliases.gone", (await sql`
    delete from speaker_aliases a where not exists (
      select 1 from speaker_evidence e join speeches s on s.id = e.speech_id where s.speaker_abbr = a.abbr and e.member_id = a.member_id)`).count);

  // 3. speeches: the service's own attribution first, then the resolver
  note("speeches.sighted", (await sql`
    update speeches s set member_id = x.member_id, member_name = coalesce(m.name, x.member_name, s.member_name)
    from speaker_sightings x left join members m on m.id = x.member_id
    where x.speech_id = s.id and s.member_id is null`).count);
  const res = await AbbrResolver.load(sql);
  const open = await sql<{ id: string; lthing: number; speaker_abbr: string }[]>`
    select id, lthing, speaker_abbr from speeches where member_id is null and speaker_abbr is not null`;
  const upd = open.flatMap((o) => {
    const id = res.resolve(o.lthing, o.speaker_abbr);
    return id ? [{ id: o.id, member_id: id, member_name: res.names.get(id) ?? o.speaker_abbr }] : [];
  });
  if (upd.length) {
    note("speeches.resolved", (await sql`
      update speeches s set member_id = u.member_id, member_name = u.member_name
      from (select * from unnest(${upd.map((u) => u.id)}::text[], ${upd.map((u) => u.member_id)}::int[], ${upd.map((u) => u.member_name)}::text[]) as t(id, member_id, member_name)) u
      where s.id = u.id and s.member_id is null`).count);
  }
  // names of rows resolved before their members row existed (placeholder = abbr)
  note("speeches.named", (await sql`
    update speeches s set member_name = m.name from members m
    where m.id = s.member_id and s.index_source = 'dump' and s.member_name is distinct from m.name`).count);

  // 4. ballots parked under an unresolved abbreviation
  const parked = await sql<{ vote_id: number; abbr: string; choice: string; lthing: number }[]>`select vote_id, abbr, choice, lthing from ballots_unresolved`;
  const prom = parked.flatMap((b) => {
    const id = res.resolve(b.lthing, b.abbr);
    return id ? [{ vote_id: b.vote_id, abbr: b.abbr, member_id: id, choice: b.choice }] : [];
  });
  if (prom.length) {
    await sql.begin(async (tx) => {
      note("ballots.promoted", (await tx`
        insert into ballots (vote_id, member_id, choice, source)
        select * , 'dump' from unnest(${prom.map((p) => p.vote_id)}::int[], ${prom.map((p) => p.member_id)}::int[], ${prom.map((p) => p.choice)}::text[])
        on conflict (vote_id, member_id) do nothing`).count);
      await tx`delete from ballots_unresolved b using unnest(${prom.map((p) => p.vote_id)}::int[], ${prom.map((p) => p.abbr)}::text[]) as t(v, a)
               where b.vote_id = t.v and b.abbr = t.a`;
    });
  }

  // 5. sponsors, absences, seat returns
  for (const t of ["matter_sponsors", "absences", "seat_returns"] as const) {
    const rows = await sql<{ k: string; lthing: number; abbr: string }[]>`
      select ctid::text as k, lthing, abbr from ${sql(t)} where member_id is null`;
    const u = rows.flatMap((r) => { const id = res.resolve(r.lthing, r.abbr); return id ? [{ k: r.k, id }] : []; });
    if (u.length) {
      note(`${t}.resolved`, (await sql`
        update ${sql(t)} x set member_id = v.id from unnest(${u.map((r) => r.k)}::tid[], ${u.map((r) => r.id)}::int[]) as v(k, id)
        where x.ctid = v.k`).count);
    }
  }

  // 6. debate code for dump-only speeches, from the item they were spoken in
  note("speeches.debate", (await sql`
    update speeches s set debate = regexp_replace(ss.debate, 'f$', '') from sitting_speeches ss
    where ss.speech_id = s.id and s.index_source = 'dump' and s.debate = '' and coalesce(ss.debate, '') not in ('', 'f')`).count);

  // 7. reply_to_id: andsvar → nearest preceding non-andsvar in the same agenda item (lidaskjol order = not inferred);
  //    else the old rule (same sitting + matter, ≤ 15 min before), inferred
  note("speeches.reply_lid", (await sql`
    with o as (
      select ss.speech_id, (select p.speech_id from sitting_speeches p
                            where p.lid_id = ss.lid_id and p.seq < ss.seq and p.tegr is distinct from 'A' and p.speech_id is not null
                            order by p.seq desc limit 1) as parent
      from sitting_speeches ss where ss.tegr = 'A' and ss.speech_id is not null)
    update speeches s set reply_to_id = o.parent, reply_to_inferred = false from o
    where s.id = o.speech_id and o.parent is not null and (s.reply_to_id is distinct from o.parent or s.reply_to_inferred)`).count);
  note("speeches.reply_inferred", (await sql`
    update speeches s set reply_to_id = p.id, reply_to_inferred = true
    from speeches a cross join lateral (
      select b.id from speeches b where b.lthing = a.lthing and b.fundur is not distinct from a.fundur and b.matter_cls is not distinct from a.matter_cls
        and b.matter_nr is not distinct from a.matter_nr and b.type <> 'andsvar' and b.started < a.started and b.started >= a.started - interval '15 minutes'
      order by b.started desc limit 1) p
    where s.id = a.id and a.type = 'andsvar' and a.reply_to_id is null and a.text_state = 'done'
      and not exists (select 1 from sitting_speeches ss where ss.speech_id = a.id)`).count);

  for (const [k, n] of Object.entries(c)) if (n) log(`derive: ${k} ${n}`);
  return c;
}

/** Counted on /healthz and by the CLI: speeches whose speaker has no member id yet. */
export async function unresolvedSpeakers(sql: Sql): Promise<number> {
  const [r] = await sql<{ n: number }[]>`select count(*)::int n from speeches where member_id is null`;
  return r?.n ?? 0;
}

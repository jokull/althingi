// Directory index pages: every plural URL directory (/thingmenn, /flokkar, /mal, …) is also a page listing what is
// under it. Lists that scan the corpus are memoised for 10 minutes; the rest are small tables.
import type { Sql } from "./db.ts";
import type { ListedMatter } from "./queries.ts";

const memo = new Map<string, { at: number; v: Promise<unknown> }>();
function cached<T>(key: string, fn: () => Promise<T>, ttl = 600_000): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.v as Promise<T>;
  const v = fn();
  memo.set(key, { at: Date.now(), v });
  v.catch(() => memo.delete(key));
  return v;
}

/** The end-of-session seat rule from composition(): sitting members and members on leave, not their stand-ins. */
const sitting = (sql: Sql, lthing: number) => sql`
  st.lthing = ${lthing} and st.kind in ('þingmaður', 'með varamann')
  and coalesce(st.to_date, date '9999-12-31') >= coalesce((select max(to_date) from seats where lthing = ${lthing}), date '0001-01-01')`;

export interface PartyRow { id: number; name: string; first: number | null; last: number | null; members: number; seats: number; speeches: number }
export const partiesIndex = (sql: Sql, lthing: number) => cached(`parties:${lthing}`, async () => {
  const [rows, seats, speeches] = await Promise.all([
    sql<{ id: number; name: string; first: number | null; last: number | null; members: number }[]>`
      select p.id, p.name, min(st.lthing) as first, max(st.lthing) as last, count(distinct st.member_id)::int as members
      from parties p left join seats st on st.party_id = p.id group by p.id, p.name`,
    sql<{ id: number; n: number }[]>`select st.party_id as id, count(distinct st.member_id)::int as n from seats st where ${sitting(sql, lthing)} group by 1`,
    sql<{ id: number; n: number }[]>`select party_id as id, count(*)::int as n from speech_index where party_id is not null group by 1`,
  ]);
  const s = new Map(seats.map((r) => [r.id, r.n])), sp = new Map(speeches.map((r) => [r.id, r.n]));
  return rows.map((r) => ({ ...r, seats: s.get(r.id) ?? 0, speeches: sp.get(r.id) ?? 0 }))
    .sort((a, b) => b.seats - a.seats || (b.last ?? 0) - (a.last ?? 0) || a.name.localeCompare(b.name, "is")) as PartyRow[];
});

export interface MemberRow { id: number; name: string; first: number; last: number; party: string | null; sitting: boolean; constituency: string | null }
export const membersIndex = (sql: Sql, lthing: number) => cached(`members:${lthing}`, async () => {
  const [rows, now] = await Promise.all([
    sql<{ id: number; name: string; first: number; last: number; party: string | null }[]>`
      select m.id, m.name, min(st.lthing) as first, max(st.lthing) as last,
        (array_agg(p.name order by st.lthing desc, st.from_date desc nulls last) filter (where p.name is not null))[1] as party
      from members m join seats st on st.member_id = m.id left join parties p on p.id = st.party_id
      group by m.id, m.name`,
    sql<{ id: number; party: string | null; constituency: string | null }[]>`
      select distinct on (st.member_id) st.member_id as id, p.name as party, st.constituency
      from seats st left join parties p on p.id = st.party_id where ${sitting(sql, lthing)}
      order by st.member_id, st.from_date desc nulls last`,
  ]);
  const cur = new Map(now.map((r) => [r.id, r]));
  return rows.map((r) => {
    const c = cur.get(r.id);
    return { ...r, sitting: !!c, party: c ? c.party : r.party, constituency: c?.constituency ?? null };
  }).sort((a, b) => a.name.localeCompare(b.name, "is")) as MemberRow[];
});

export interface SessionRow { lthing: number; period: string; starts: string | null; ends: string | null; n: number }
/** sessions with at least one matter (or document), newest first */
export const sessionsWith = (sql: Sql, what: "matters" | "documents") => cached(`sessions:${what}`, () =>
  sql<SessionRow[]>`
    select s.lthing, s.period, s.starts::text, s.ends::text, x.n from sessions s
    join (select lthing, count(*)::int as n from ${sql(what)} group by 1) x on x.lthing = s.lthing
    order by s.lthing desc`);

export async function sessionMatters(sql: Sql, lthing: number): Promise<{ session: SessionRow; matters: ListedMatter[] } | null> {
  const [s] = await sql<SessionRow[]>`select lthing, period, starts::text, ends::text, 0 as n from sessions where lthing = ${lthing}`;
  if (!s) return null;
  const rows = await sql<{ lthing: number; cls: string; nr: number; title: string; type_label: string | null; status_text: string | null }[]>`
    select lthing, cls, nr, title, type_label, status_text from matters where lthing = ${lthing} order by cls, nr`;
  return { session: { ...s, n: rows.length }, matters: rows.map((m) => ({ lthing: m.lthing, cls: m.cls, nr: m.nr, title: m.title, type: m.type_label, status: m.status_text })) };
}

export interface DocRow { nr: number; type: string; title: string | null; issued: string | null; cls: string | null; matterNr: number | null; matterTitle: string | null }
export async function sessionDocs(sql: Sql, lthing: number): Promise<{ session: SessionRow; docs: DocRow[] } | null> {
  const [s] = await sql<SessionRow[]>`select lthing, period, starts::text, ends::text, 0 as n from sessions where lthing = ${lthing}`;
  if (!s) return null;
  const rows = await sql<{ nr: number; type: string; title: string | null; issued: string | null; matter_cls: string | null; matter_nr: number | null; matter_title: string | null }[]>`
    select d.nr, d.type, d.title, coalesce(d.issued, d.distributed_at)::text as issued, d.matter_cls, d.matter_nr, m.title as matter_title
    from documents d left join matters m on m.lthing = d.lthing and m.cls = d.matter_cls and m.nr = d.matter_nr
    where d.lthing = ${lthing} order by d.nr`;
  return { session: { ...s, n: rows.length }, docs: rows.map((r) => ({ nr: r.nr, type: r.type, title: r.title, issued: r.issued, cls: r.matter_cls, matterNr: r.matter_nr, matterTitle: r.matter_title })) };
}

export const lawYears = (sql: Sql) => cached("law-years", () =>
  sql<{ year: number; n: number }[]>`select year, count(distinct nr)::int as n from laws group by year order by year desc`);

export interface LawRow { year: number; nr: number; title: string | null; chapter: string | null }
export const lawsOfYear = (sql: Sql, year: number) =>
  sql<LawRow[]>`select distinct on (nr) year, nr, title, chapter from laws where year = ${year} order by nr, edition desc`;

export const committeesIndex = (sql: Sql) => cached("committees", () =>
  sql<{ id: number; name: string; first_lthing: number | null; matters: number }[]>`
    select c.id, c.name, c.first_lthing, coalesce(x.n, 0)::int as matters from committees c
    left join (select committee_id, count(distinct (lthing, cls, nr))::int as n from consultation_requests group by 1) x on x.committee_id = c.id
    order by (coalesce(x.n, 0) > 0) desc, c.name`);

export const topicsIndex = (sql: Sql) => cached("topics", () =>
  sql<{ id: number; name: string; parent: string | null; matters: number }[]>`
    select e.id, e.name, e.parent_name as parent, coalesce(x.n, 0)::int as matters from efnisflokkar e
    left join (select efnisflokkur_id, count(*)::int as n from matter_efnisflokkar group by 1) x on x.efnisflokkur_id = e.id
    order by e.parent_name nulls first, e.name`);

/** sitting days per year (a day = a date with at least one speech in the corpus) */
export const dayYears = (sql: Sql) => cached("day-years", () =>
  sql<{ year: number; days: number; speeches: number }[]>`
    select year, count(distinct speech_date)::int as days, count(*)::int as speeches from speech_index group by year order by year desc`);

export const daysOfYear = (sql: Sql, year: number) => cached(`days:${year}`, () =>
  sql<{ date: string; speeches: number; lthing: number }[]>`
    select speech_date::text as date, count(*)::int as speeches, max(lthing) as lthing from speech_index
    where speech_date >= make_date(${year}, 1, 1) and speech_date < make_date(${year + 1}, 1, 1)
    group by speech_date order by speech_date desc`);

export const latestSpeeches = (sql: Sql, limit = 60) =>
  sql<{ id: string; started: string; type: string; member_id: number | null; member_name: string; lthing: number; matter_cls: string | null; matter_nr: number | null; title: string | null }[]>`
    select sp.id, sp.started::text, sp.type, sp.member_id, sp.member_name, sp.lthing, sp.matter_cls, sp.matter_nr, m.title
    from (select * from speech_index order by started desc limit ${limit}) sp
    left join matters m on m.lthing = sp.lthing and m.cls = sp.matter_cls and m.nr = sp.matter_nr
    order by sp.started desc`;

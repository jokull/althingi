// Federated search over everything except speech text: matters, members, committees, topics, votes, senders, laws.
// Each kind is one small indexed query; the web layer shows a few of each on "Allt" and a full list on its own tab.
import type { Sql } from "./db.ts";
import { parseQuery } from "./explain.ts";
import { recallTsQuery } from "./search.ts";

export type Kind = "mal" | "thingmenn" | "flokkar" | "nefndir" | "efni" | "atkvaedi" | "umsagnir" | "log";
export const KINDS: { id: Kind; label: string }[] = [
  { id: "thingmenn", label: "Þingmenn" },
  { id: "flokkar", label: "Flokkar" },
  { id: "mal", label: "Mál" },
  { id: "atkvaedi", label: "Atkvæðagreiðslur" },
  { id: "umsagnir", label: "Umsagnir" },
  { id: "nefndir", label: "Nefndir" },
  { id: "efni", label: "Efnisflokkar" },
  { id: "log", label: "Lög" },
];

export interface MemberInfo { id: number; party: string | null; constituency: string | null; first: number | null; last: number | null; speeches: number; lastSpeech: { id: string; started: string } | null }
export interface PartyInfo { id: number; seats: number; lthing: number | null; speeches: number }

export interface EntityHit {
  kind: Kind; href: string; title: string; meta: string; stats?: string[]; badge?: string;
  /** members: every query word starts a word of the name (vs. a trigram near-miss) */
  strong?: boolean;
  member?: MemberInfo;
  party?: PartyInfo;
  /** matters: status text */
  status?: string | null;
}
export type EntityResult = Record<Kind, EntityHit[]>;

const esc = (s: string) => s.replace(/[%_\\]/g, "\\$&");
const words = (s: string) => s.toLocaleLowerCase("is").split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Every query word is the start of some word in the name: "katrín jak" ~ "Katrín Jakobsdóttir", not "Katrín Sif Árnadóttir". */
export function nameMatches(name: string, q: string): boolean {
  const n = words(name), qs = words(q);
  return qs.length > 0 && qs.every((w) => n.some((x) => x.startsWith(w)));
}

/** A query that looks like a person's name: two or more words, or a patronymic. */
export function personLike(q: string): boolean {
  const qs = words(q);
  return (qs.length >= 2 && qs.length <= 4 && qs.every((w) => /^\p{L}+$/u.test(w))) || /(son|dóttir|bur)$/u.test(qs[qs.length - 1] ?? "");
}

/** The one entity that IS the answer, if there is one. Never a near-miss. */
export function topResult(e: EntityResult, q: string): EntityHit | null {
  const qs = words(q).join(" ");
  const strongMembers = e.thingmenn.filter((m) => m.strong);
  const exact = strongMembers.find((m) => words(m.title).join(" ") === qs);
  if (exact) return exact;
  if (strongMembers.length === 1 && words(q).length >= 2) return strongMembers[0]!;
  const party = e.flokkar.find((p) => words(p.title).join(" ").startsWith(qs) || qs.startsWith(words(p.title).join(" ")));
  if (party) return party;
  if (e.nefndir.length === 1 && words(e.nefndir[0]!.title).join(" ").startsWith(qs)) return e.nefndir[0]!;
  if (e.log.length === 1 && /\d/.test(q)) return e.log[0]!;
  if (e.mal.length === 1) return e.mal[0]!;
  return null;
}

export async function searchEntities(sql: Sql, q: string, current: number, limit = 8): Promise<EntityResult> {
  const raw = q.trim().slice(0, 200);
  const parsed = parseQuery(raw.replace(/"/g, " "));
  const tq = recallTsQuery(parsed);
  const like = `%${esc(raw.replace(/"/g, ""))}%`;
  const nums = parsed.numbers;
  const out: EntityResult = { mal: [], thingmenn: [], flokkar: [], nefndir: [], efni: [], atkvaedi: [], umsagnir: [], log: [] };
  if (!raw) return out;

  const [mal, thingmenn, flokkar, nefndir, efni, atkvaedi, umsagnir, log] = await Promise.all([
    tq
      ? sql<{ lthing: number; cls: string; nr: number; title: string; type_label: string | null; status_text: string | null }[]>`
          select lthing, cls, nr, title, type_label, status_text from matters m
          where m.title_vector @@ to_tsquery('simple', ${tq})
          order by (lthing = ${current}) desc, lthing desc, nr limit ${limit}`
      : [],
    raw.length >= 2
      ? sql<{ id: number; name: string; last: number | null; first: number | null; party: string | null; constituency: string | null; speeches: number; ls_id: string | null; ls_started: string | null }[]>`
          select m.id, m.name, x.last, x.first, x.party, x.constituency,
                 (select count(*)::int from speech_index si where si.member_id = m.id) as speeches,
                 ls.id as ls_id, ls.started::text as ls_started
          from members m
          left join lateral (
            select max(s.lthing) as last, min(s.lthing) as first,
                   (array_agg(p.name order by s.from_date desc nulls last))[1] as party,
                   (array_agg(s.constituency order by s.from_date desc nulls last))[1] as constituency
            from seats s left join parties p on p.id = s.party_id where s.member_id = m.id) x on true
          left join lateral (
            select si.id, si.started from speech_index si where si.member_id = m.id order by si.started desc limit 1) ls on true
          where m.name ilike ${like} or m.name % ${raw}
          order by (lower(m.name) = lower(${raw})) desc, (m.name ilike ${like}) desc, x.last desc nulls last, speeches desc, similarity(m.name, ${raw}) desc, m.id
          limit ${limit}`
      : [],
    raw.length >= 2
      ? sql<{ id: number; name: string; lthing: number | null; seats: number; speeches: number }[]>`
          select p.id, p.name, l.lthing,
            (select count(distinct s.member_id)::int from seats s where s.party_id = p.id and s.lthing = l.lthing and s.kind in ('þingmaður', 'með varamann')
               and coalesce(s.to_date, date '9999-12-31') >= coalesce((select max(to_date) from seats where lthing = l.lthing), date '0001-01-01')) as seats,
            (select count(*)::int from speech_index si where si.party_id = p.id) as speeches
          from parties p cross join lateral (select max(lthing) as lthing from seats where party_id = p.id) l
          where p.name ilike ${like} order by l.lthing desc nulls last, speeches desc limit ${limit}`
      : [],
    sql<{ id: number; name: string; first_lthing: number | null; n: number }[]>`select c.id, c.name, c.first_lthing, (select count(distinct (r.lthing, r.cls, r.nr))::int from consultation_requests r where r.committee_id = c.id) as n from committees c where c.name ilike ${like} or c.abbr_long ilike ${like} limit ${limit}`,
    sql<{ id: number; name: string; parent_name: string | null; n: number }[]>`
      select e.id, e.name, e.parent_name, (select count(*)::int from matter_efnisflokkar x where x.efnisflokkur_id = e.id) as n
      from efnisflokkar e where e.name ilike ${like} or e.parent_name ilike ${like} order by n desc limit ${limit}`,
    tq
      ? sql<{ id: number; lthing: number; cls: string; nr: number; voted_at: string; kind_label: string; result: string | null; yes: number | null; no: number | null; title: string }[]>`
          select v.id, v.lthing, v.cls, v.nr, v.voted_at::text, v.kind_label, v.result, v.yes, v.no, m.title
          from matters m join votes v on (v.lthing, v.cls, v.nr) = (m.lthing, m.cls, m.nr)
          where m.title_vector @@ to_tsquery('simple', ${tq})
          order by v.voted_at desc nulls last limit ${limit}`
      : [],
    // one row per sender + matter: a sender often both receives a request and sends several documents
    sql<{ lthing: number; cls: string; nr: number; who: string; whats: string[]; n: number; at: string | null; title: string | null }[]>`
      select u.lthing, u.cls, u.nr, min(u.who) as who, array_agg(distinct u.what) as whats, count(*)::int as n, max(u.at) as at, min(m.title) as title
      from (
        select c.lthing, c.cls, c.nr, c.recipient as who, 'umsagnarbeiðni' as what, c.requested::text as at
        from consultation_requests c where c.recipient ilike ${like}
        union all
        select s.lthing, s.cls, s.nr, s.sender, coalesce(s.kind, 'erindi'), s.received::text
        from submissions s where s.sender ilike ${like}
      ) u left join matters m on (m.lthing, m.cls, m.nr) = (u.lthing, u.cls, u.nr)
      group by u.lthing, u.cls, u.nr, lower(u.who)
      order by max(u.at) desc nulls last limit ${limit}`,
    nums.length >= 1
      ? sql<{ law_year: number; law_nr: number; n: number; title: string | null }[]>`
          select x.law_year, x.law_nr, x.n, c.title from (
            select law_year, law_nr, count(*)::int n from matter_laws
            where law_nr = ${Number(nums[0])} or law_year = ${Number(nums[0])} group by 1, 2) x
          left join laws_current c on c.year = x.law_year and c.nr = x.law_nr
          order by x.law_year desc limit ${limit}`
      : raw.length >= 3
        // laws by title (current collection): every query word is in the title, or a close trigram match
        ? sql<{ law_year: number; law_nr: number; n: number; title: string | null }[]>`
            select c.year as law_year, c.nr as law_nr, c.title,
                   (select count(*)::int from matter_laws l where l.law_year = c.year and l.law_nr = c.nr) as n
            from laws_current c
            where c.title ilike ${like} or c.title % ${raw}
            order by (c.title ilike ${like}) desc, (c.in_force like 'Felld%') nulls first, similarity(c.title, ${raw}) desc, c.year desc
            limit ${limit}`
        : [],
  ]);

  const span = (a: number | null, b: number | null) => (a && b ? (a === b ? `${a}. þing` : `${a}.–${b}. þing`) : null);
  out.mal = mal.map((r) => ({
    kind: "mal", href: `/mal/${r.lthing}/${r.cls.toLowerCase()}/${r.nr}`, title: r.title, badge: r.type_label ?? undefined, status: r.status_text,
    meta: `${r.nr}. mál á ${r.lthing}. þingi${r.type_label ? ` · ${r.type_label}` : ""}`,
  }));
  out.thingmenn = thingmenn.map((r) => ({
    kind: "thingmenn", href: `/thingmadur/${r.id}`, title: r.name, badge: r.party ?? undefined, strong: nameMatches(r.name, raw),
    meta: [r.constituency, span(r.first, r.last)].filter(Boolean).join(" · "),
    stats: [`${r.speeches.toLocaleString("is-IS")} ${r.speeches === 1 ? "ræða" : "ræður"} í safni`],
    member: { id: r.id, party: r.party, constituency: r.constituency, first: r.first, last: r.last, speeches: r.speeches, lastSpeech: r.ls_id && r.ls_started ? { id: r.ls_id, started: r.ls_started } : null },
  }));
  out.flokkar = flokkar.map((r) => ({
    kind: "flokkar", href: `/flokkur/${r.id}`, title: r.name, badge: "flokkur",
    meta: r.lthing ? `${r.seats} ${r.seats === 1 ? "þingmaður" : "þingmenn"} á ${r.lthing}. þingi` : "",
    stats: [`${r.speeches.toLocaleString("is-IS")} ræður í safni`],
    party: { id: r.id, seats: r.seats, lthing: r.lthing, speeches: r.speeches },
  }));
  out.nefndir = nefndir.map((r) => ({ kind: "nefndir", href: `/nefnd/${r.id}`, title: r.name, badge: "nefnd", meta: [r.first_lthing ? `frá ${r.first_lthing}. þingi` : "", `${r.n} mál með umsagnarbeiðnum`].filter(Boolean).join(" · ") }));
  out.efni = efni.map((r) => ({
    kind: "efni", href: `/efni/${r.id}`, title: r.name, meta: `${r.parent_name ? r.parent_name + " · " : ""}${r.n} mál`,
  }));
  out.atkvaedi = atkvaedi.map((r) => ({
    kind: "atkvaedi", href: `/mal/${r.lthing}/${r.cls.toLowerCase()}/${r.nr}#atkvaedi`, title: r.title, badge: r.kind_label,
    meta: `${r.voted_at?.slice(0, 10) ?? ""}${r.result ? ` · ${r.result}` : ""}${r.yes != null ? ` · já ${r.yes}, nei ${r.no ?? 0}` : ""}`,
  }));
  out.umsagnir = umsagnir.map((r) => ({
    kind: "umsagnir", href: `/mal/${r.lthing}/${r.cls.toLowerCase()}/${r.nr}#umsagnir`, title: r.who, badge: r.n > 1 ? `${r.n} skjöl` : undefined,
    meta: `${r.whats.join(", ")}${r.at ? ` · ${r.at.slice(0, 10)}` : ""}${r.title ? ` · ${r.title}` : ""}`,
  }));
  out.log = log.map((r) => ({
    kind: "log", href: `/log/${r.law_year}/${r.law_nr}`, title: r.title ?? `Lög nr. ${r.law_nr}/${r.law_year}`, badge: "lög",
    meta: [r.title ? `nr. ${r.law_nr}/${r.law_year}` : "", r.n ? `${r.n} ${r.n === 1 ? "mál breytti" : "mál breyttu"} þeim` : ""].filter(Boolean).join(" · "),
  }));
  return out;
}

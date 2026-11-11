// What happened to a matter and its votes, filled in where Alþingi's own field is empty. Rules (docs/AGENTS.md §2,
// "Derived fields"); every derived value is flagged so an agent can tell it from a source fact.
//
// Vote result: the source `result` wins. Else, for a counted vote (method S/N/H or the matching method label, with
// yes + no > 0): yes > no -> "samþykkt", otherwise "Fellt" (a tie fails). Method K -> "kallað aftur", E -> "kom ekki til
// atkvæðagreiðslu". Procedural G/Y votes ("mál gengur", the presiding officer's declaration) and 0/0/0 rows stay null.
// Checked on the mini 2026-11-11: of 2,719 counted votes with a source result, yes > no matched "samþykkt" 2,380 of 2,387
// times (the 7 others have no counts) and "Fellt" never had yes > no.
//
// Final vote: the last vote (by time, then id) on the whole bill or resolution: vote type code (dump `tegatkvgr`, else
// the service code) `lg` (frumvarpið í heild) or `þa` (þingsályktunartillagan í heild). Article and amendment votes
// (gr, bt, …) and referrals (v2, n2, v3, …) are never final. A matter with no such vote has no final vote.
//
// Matter status: the source `status_text` wins. Else a `frvAfgreittSemLög` sitting event -> "Samþykkt sem lög frá
// Alþingi." (the source wording); else a final vote that passed -> the same for `lg`, "Samþykkt sem ályktun Alþingis."
// for `þa`. Nothing negative is derived (a matter without these may still be pending, lapsed or withdrawn).
import type { Sql } from "./db.ts";

export interface VoteFacts {
  method: string | null; method_code: string | null; result: string | null;
  yes: number | null; no: number | null; abstain: number | null;
}

const COUNTED_CODES = new Set(["S", "N", "H"]);
const COUNTED_METHODS = new Set(["atkvæðagreiðslukerfi", "nafnakall", "handaupprétting"]);
export const FINAL_CODES = new Set(["lg", "þa"]);

export function voteResult(v: VoteFacts): { result: string | null; result_derived: boolean } {
  if (v.result) return { result: v.result, result_derived: false };
  if (v.method_code === "K") return { result: "kallað aftur", result_derived: true };
  if (v.method_code === "E") return { result: "kom ekki til atkvæðagreiðslu", result_derived: true };
  const counted = (v.method_code !== null && COUNTED_CODES.has(v.method_code)) || (v.method !== null && COUNTED_METHODS.has(v.method));
  const yes = v.yes ?? 0, no = v.no ?? 0;
  if (counted && yes + no > 0) return { result: yes > no ? "samþykkt" : "Fellt", result_derived: true };
  return { result: null, result_derived: false };
}

export const RESULT_EN: Record<string, string> = {
  "samþykkt": "passed", Fellt: "rejected", "kallað aftur": "withdrawn", "kom ekki til atkvæðagreiðslu": "not put to a vote",
};

/** Index of the final vote in a list ordered by (voted_at, id), or -1. */
export function finalVoteIndex(votes: { code: string | null }[]): number {
  for (let i = votes.length - 1; i >= 0; i--) if (votes[i]!.code && FINAL_CODES.has(votes[i]!.code!)) return i;
  return -1;
}

export const PASSED_AS_LAW = "Samþykkt sem lög frá Alþingi.";
export const PASSED_AS_RESOLUTION = "Samþykkt sem ályktun Alþingis.";

export function matterStatus(statusText: string | null, passedEvent: boolean, final: { code: string | null; result: string | null } | null):
  { status: string | null; status_source: "althingi" | "sitting_event" | "final_vote" | null } {
  if (statusText && statusText.trim()) return { status: statusText, status_source: "althingi" };
  if (passedEvent) return { status: PASSED_AS_LAW, status_source: "sitting_event" };
  if (final?.result === "samþykkt") return { status: final.code === "þa" ? PASSED_AS_RESOLUTION : PASSED_AS_LAW, status_source: "final_vote" };
  return { status: null, status_source: null };
}

export type PartyTally = { party: string; counts: Record<string, number> }[];

/** Per-party tally (party on the vote date) for many votes in one query. */
export async function partyTallies(sql: Sql, voteIds: number[]): Promise<Map<number, PartyTally>> {
  const out = new Map<number, PartyTally>();
  if (!voteIds.length) return out;
  const rows = await sql<{ vote_id: number; party: string | null; choice: string; n: number }[]>`
    select b.vote_id, pt.name as party, b.choice, count(*)::int n
    from ballots b join votes v on v.id = b.vote_id
    left join lateral (
      select p.name from seats st join parties p on p.id = st.party_id
      where st.member_id = b.member_id and st.kind in ('þingmaður', 'varamaður')
        and coalesce(v.voted_at::date, current_date) between coalesce(st.from_date, date '0001-01-01') and coalesce(st.to_date, date '9999-12-31')
      order by st.from_date desc nulls last limit 1) pt on true
    where b.vote_id = any(${voteIds}::int[])
    group by 1, 2, 3 order by 1, 2 nulls last, 3`;
  for (const r of rows) {
    const t = out.get(r.vote_id) ?? [];
    const k = r.party ?? "(óþekktur flokkur)";
    let e = t.find((x) => x.party === k);
    if (!e) { e = { party: k, counts: {} }; t.push(e); }
    e.counts[r.choice] = r.n;
    out.set(r.vote_id, t);
  }
  return out;
}

export interface FinalVote {
  id: number; at: string | null; about: string; result: string | null; result_derived: boolean;
  yes: number | null; no: number | null; abstain: number | null; by_party: PartyTally;
}
export interface Outcome { status: string | null; status_source: string | null; final_vote: FinalVote | null }

/** Status and final vote (with per-party tally) for many matters at once: three queries whatever the count. */
export async function matterOutcomes(sql: Sql, keys: { lthing: number; cls: string; nr: number }[]): Promise<Map<string, Outcome>> {
  const out = new Map<string, Outcome>();
  if (!keys.length) return out;
  const L = keys.map((k) => k.lthing), C = keys.map((k) => k.cls), N = keys.map((k) => k.nr);
  const [matters, events, finals] = await Promise.all([
    sql<{ lthing: number; cls: string; nr: number; status_text: string | null }[]>`
      select m.lthing, m.cls, m.nr, m.status_text from matters m
      join unnest(${L}::int[], ${C}::text[], ${N}::int[]) k(l, c, n) on (m.lthing, m.cls, m.nr) = (k.l, k.c, k.n)`,
    sql<{ lthing: number; cls: string; nr: number }[]>`
      select distinct e.lthing, e.cls, e.nr from sitting_events e
      join unnest(${L}::int[], ${C}::text[], ${N}::int[]) k(l, c, n) on (e.lthing, e.cls, e.nr) = (k.l, k.c, k.n)
      where e.kind = 'frvAfgreittSemLög'`,
    sql<{ lthing: number; cls: string; nr: number; id: number; at: string | null; kind_label: string; code: string | null; method: string | null; method_code: string | null; result: string | null; yes: number | null; no: number | null; abstain: number | null }[]>`
      select distinct on (v.lthing, v.cls, v.nr) v.lthing, v.cls, v.nr, v.id, v.voted_at::text as at, v.kind_label,
             coalesce(v.kind_code2, v.kind_code) as code, v.method, v.method_code, v.result, v.yes, v.no, v.abstain
      from votes v join unnest(${L}::int[], ${C}::text[], ${N}::int[]) k(l, c, n) on (v.lthing, v.cls, v.nr) = (k.l, k.c, k.n)
      where coalesce(v.kind_code2, v.kind_code) in ('lg', 'þa')
      order by v.lthing, v.cls, v.nr, v.voted_at desc nulls last, v.id desc`,
  ]);
  const key = (l: number, c: string, n: number) => `${l}/${c}/${n}`;
  const passed = new Set(events.map((e) => key(e.lthing, e.cls, e.nr)));
  const tallies = await partyTallies(sql, finals.map((f) => f.id));
  const fin = new Map(finals.map((f) => {
    const r = voteResult(f);
    return [key(f.lthing, f.cls, f.nr), { code: f.code, vote: { id: f.id, at: f.at, about: f.kind_label, ...r, yes: f.yes, no: f.no, abstain: f.abstain, by_party: tallies.get(f.id) ?? [] } }];
  }));
  for (const m of matters) {
    const k = key(m.lthing, m.cls, m.nr);
    const f = fin.get(k) ?? null;
    out.set(k, { ...matterStatus(m.status_text, passed.has(k), f ? { code: f.code, result: f.vote.result } : null), final_vote: f?.vote ?? null });
  }
  return out;
}

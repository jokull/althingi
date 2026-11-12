// Party name → id, so any party name rendered anywhere can deeplink to /flokkar/:id. Names are unique in `parties`
// (19 rows). Most queries return the party name at a date rather than its id, so the lookup is cheaper than threading
// ids through every query. web.tsx refreshes the map; an unknown name renders unlinked.
import type { Sql } from "./db.ts";

let ids = new Map<string, number>();
let at = 0;

export const partyId = (name: string | null | undefined): number | undefined => (name ? ids.get(name) : undefined);
export const partyHref = (name: string | null | undefined): string | undefined => {
  const id = partyId(name);
  return id === undefined ? undefined : `/flokkar/${id}`;
};

/** Reload at most every 10 minutes; never throws (a failed refresh keeps the last map). */
export async function refreshPartyIds(sql: Sql, maxAgeMs = 600_000): Promise<void> {
  if (Date.now() - at < maxAgeMs) return;
  at = Date.now();
  try {
    const rows = await sql<{ id: number; name: string }[]>`select id, name from parties`;
    ids = new Map(rows.map((r) => [r.name, r.id]));
  } catch { at = 0; }
}

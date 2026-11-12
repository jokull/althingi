// One dispatcher from a site path to its Markdown: used by the `.md` routes, the MCP resource templates and the
// ChatGPT-style `fetch` tool, so the three never disagree.
import type { Sql } from "./db.ts";
import * as T from "./mcp-tools.ts";
import { dayPage, docPage, isSpeechId, partyPage, speechPage } from "./queries.ts";
import { dayMd, docMd, lawMd, matterMd, memberMd, partyMd, speechMd } from "./markdown.ts";
import { SITE } from "./pages.tsx";

export interface MdDoc { path: string; title: string; markdown: string; althingi_url?: string | null }

/** Singular path prefixes used until 2026-11-12; old links 301 to the plural directory (which is also its index page). */
const LEGACY: Record<string, string> = { raeda: "raedur", thingmadur: "thingmenn", flokkur: "flokkar", dagur: "dagar", thingskjal: "thingskjol", nefnd: "nefndir" };
const LEGACY_RE = new RegExp(`^/(${Object.keys(LEGACY).join("|")})(?=/|\\.md$|$)`);
/** `/raeda/rad…` -> `/raedur/rad…`; null when the path is already current. */
export const legacyPath = (path: string): string | null => {
  const m = path.match(LEGACY_RE);
  return m ? `/${LEGACY[m[1]!]}${path.slice(m[0].length)}` : null;
};

/** `/raedur/rad…`, `https://althingi.solberg.is/mal/157/a/300.md`, `mal/157/a/300` … -> canonical path without `.md` */
export function canonicalPath(input: string): string {
  let p = input.trim();
  if (p.startsWith(SITE)) p = p.slice(SITE.length);
  p = p.replace(/^https?:\/\/[^/]+/, "").replace(/[?#].*$/, "").replace(/\.md$/, "").replace(/\/+$/, "");
  if (isSpeechId(p)) p = `/raedur/${p}`;
  p = p.startsWith("/") ? p : `/${p}`;
  return legacyPath(p) ?? p;
}

export async function renderMd(sql: Sql, rawPath: string, currentLthing: number): Promise<MdDoc | null> {
  const path = canonicalPath(rawPath);
  const ctx = { sql, currentLthing };
  let m: RegExpMatchArray | null;
  if ((m = path.match(/^\/raedur\/([^/]+)$/)) && isSpeechId(m[1]!)) {
    const s = await speechPage(sql, m[1]!);
    if (!s) return null;
    const [r] = await sql<{ reply_to_id: string | null; reply_to_inferred: boolean }[]>`select reply_to_id, reply_to_inferred from speeches where id = ${s.id}`;
    return { path, title: `${s.memberName} – ${s.type} ${s.date}`, althingi_url: s.althingiUrl,
      markdown: speechMd(s, { reply_to: r?.reply_to_id ? { speech_id: r.reply_to_id, inferred: r.reply_to_inferred } : null }) };
  }
  if ((m = path.match(/^\/mal\/(\d{1,4})\/([ab])\/(\d{1,5})$/i))) {
    const r = await T.getMatter(ctx, { lthing: Number(m[1]), class: m[2]!, nr: Number(m[3]) });
    if ("error" in r) return null;
    return { path: path.toLowerCase(), title: r.matter.title, althingi_url: r.matter.althingi_url, markdown: matterMd(r) };
  }
  if ((m = path.match(/^\/thingmenn\/(\d{1,9})$/))) {
    const r = await T.getMember(ctx, { member_id: Number(m[1]) });
    if (!("member" in r) || !r.member) return null;
    return { path, title: r.member.name, althingi_url: r.member.althingi_url, markdown: memberMd(r as never) };
  }
  if ((m = path.match(/^\/log\/(\d{4})\/(\d{1,4})$/))) {
    const r = await T.getLaw(ctx, { year: Number(m[1]), nr: Number(m[2]) });
    if (!("law" in r) || !r.law) return null;
    const arts = r.law.edition ? await sql<{ heading: string | null; text: string }[]>`
      select heading, text from law_articles where year = ${r.law.year} and nr = ${r.law.nr} and edition = ${r.law.edition}
      order by nullif(regexp_replace(article_id, '\\D', '', 'g'), '')::int nulls last, article_id` : [];
    return { path, title: r.law.title ?? `Lög nr. ${r.law.id}`, althingi_url: r.law.althingi_url, markdown: lawMd(r as never, arts) };
  }
  if ((m = path.match(/^\/dagar\/(\d{4}-\d{2}-\d{2})$/))) {
    const d = await dayPage(sql, m[1]!);
    if (!d || d.total === 0) return null;
    return { path, title: `Þingdagur ${d.date}`, markdown: dayMd(d) };
  }
  if ((m = path.match(/^\/flokkar\/(\d{1,9})$/))) {
    const p = await partyPage(sql, Number(m[1]));
    return p ? { path, title: p.name, markdown: partyMd(p) } : null;
  }
  if ((m = path.match(/^\/thingskjol\/(\d{1,4})\/(\d{1,6})$/))) {
    const d = await docPage(sql, Number(m[1]), Number(m[2]));
    return d ? { path, title: `Þingskjal ${d.nr} (${d.lthing}. þing)`, althingi_url: d.althingiUrl, markdown: docMd(d) } : null;
  }
  return null;
}

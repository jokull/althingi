// Markdown variants of the entity pages (`<url>.md`, or `Accept: text/markdown` -> 302 to it). Same facts as the HTML,
// built from the same queries / MCP tool payloads, with a small front matter so an agent can cite without parsing.
import type { DayPage, DocPage, PartyPage, SpeechPage } from "./queries.ts";
import { citation, debateLabel, fmtDate, fmtDateTime, fmtTime, GLOSSARY, SITE } from "./pages.tsx";
import type * as T from "./mcp-tools.ts";

type R<F extends (...a: any[]) => any> = Exclude<Awaited<ReturnType<F>>, { error: string } | { candidates: unknown }>;

const esc = (s: string | null | undefined) => (s ?? "").replace(/([\\`*_[\]<>|])/g, "\\$1");
const front = (o: Record<string, string | number | boolean | null | undefined>) =>
  `---\n${Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`).join("\n")}\n---\n\n`;
export const FOOTER = `\n---\nHeimild / source: Alþingi (https://www.althingi.is). Ræðutexti frá 2005. Vefur og MCP: ${SITE} · ${SITE}/mcp · ${SITE}/llms.txt\n`;
const matterHref = (l: number, c: string, n: number) => `${SITE}/mal/${l}/${c.toLowerCase()}/${n}`;

export function speechMd(s: SpeechPage, reply?: { reply_to: { speech_id: string; inferred: boolean } | null }): string {
  const deb = debateLabel(s.debate);
  const head = `# ${esc(s.memberName)}: ${s.type}${deb ? `, ${deb}` : ""}, ${fmtDateTime(s.started)}\n\n`;
  const meta = [
    s.party && `Flokkur á ræðudegi: ${s.party}`,
    s.office && `Embætti: ${s.office}`,
    s.matter && `Mál: [${esc(s.matter.title ?? `${s.matter.nr}. mál`)}](${matterHref(s.matter.lthing, s.matter.cls, s.matter.nr)}.md) (${s.matter.nr}. mál á ${s.matter.lthing}. þingi)`,
    reply?.reply_to && `Svar við: [${reply.reply_to.speech_id}](${SITE}/raeda/${reply.reply_to.speech_id}.md)${reply.reply_to.inferred ? " (áætlað)" : ""}`,
    s.provisional && "Bráðabirgðatexti: lokatexti Alþingis hefur ekki borist.",
    s.memberId !== null && `Ræðumaður: [${esc(s.memberName)}](${SITE}/thingmadur/${s.memberId}.md)`,
    s.althingiUrl && `Á vef Alþingis: ${s.althingiUrl}`,
    s.vodUrl && `Upptaka: ${s.vodUrl}`,
  ].filter(Boolean).map((x) => `- ${x}`).join("\n");
  const body = s.paragraphs.map((p) =>
    `<a id="mgr-${p.seq + 1}"></a>**[${p.seq + 1}]** ${esc(p.text)}${p.interjections.map((i) => `\n\n> Framíkall: ${esc(i)}`).join("")}`).join("\n\n");
  return front({ title: `${s.memberName} – ${s.type} ${fmtDate(s.date)}`, url: `${SITE}/raeda/${s.id}`, speech_id: s.id, date: s.date, started: s.started, member_id: s.memberId, party_at_date: s.party, lthing: s.lthing, provisional: s.provisional, citation: citation(s) })
    + head + meta + "\n\n## Ræðutexti\n\nMálsgreinar eru númeraðar; vísaðu í þær með `" + `${SITE}/raeda/${s.id}#mgr-N` + "`.\n\n"
    + (body || "_Texti ræðunnar hefur ekki verið sóttur enn._") + "\n\n## Tilvitnun\n\n" + citation(s) + "\n" + FOOTER;
}

export function matterMd(r: R<typeof T.getMatter>): string {
  const m = r.matter;
  const lines: string[] = [];
  lines.push(`# ${esc(m.title)}\n`, `${m.nr}. mál á ${m.lthing}. löggjafarþingi${m.class === "B" ? " (B-mál)" : ""}${m.type ? ` · ${m.type}` : ""}\n`);
  if (m.status) lines.push(`**Staða:** ${esc(m.status)}\n`);
  if (m.subtitle) lines.push(`${esc(m.subtitle)}\n`);
  lines.push(`Á vef Alþingis: ${m.althingi_url}\n`);
  if (r.sponsors.length) lines.push("## Flutningsmenn\n", r.sponsors.map((s) => `- ${s.member ? `[${esc(s.member.name)}](${s.member.url}.md)` : esc(s.abbr)}${s.office ? ` (${s.office})` : ""}`).join("\n") + "\n");
  if (r.laws_amended.length) lines.push("## Lög sem málið breytir\n", r.laws_amended.map((l) => `- [Lög nr. ${l.nr}/${l.year}](${l.url}.md)`).join("\n") + "\n");
  if (r.related_matters.length) lines.push("## Tengd mál\n", r.related_matters.map((l) => `- ${l.relation}: [${esc(l.title ?? `${l.nr}. mál`)}](${matterHref(l.lthing, l.class, l.nr)}.md) (${l.lthing}. þing)`).join("\n") + "\n");
  if (r.documents.length) lines.push("## Þingskjöl\n", r.documents.map((d) => `- Þskj. ${d.nr}: ${esc(d.type)}${d.issued ? `, ${fmtDate(d.issued)}` : ""} — ${d.althingi_url}`).join("\n") + "\n");
  if (r.votes.length) {
    lines.push("## Atkvæðagreiðslur\n", "| Tími | Um | Niðurstaða | Já | Nei | Sátu hjá | vote_id |", "|---|---|---|---|---|---|---|");
    for (const v of r.votes) lines.push(`| ${v.at ? fmtDateTime(v.at) : ""} | ${esc(v.about)} | ${esc(v.result)} | ${v.yes ?? ""} | ${v.no ?? ""} | ${v.abstain ?? ""} | ${v.id} |`);
    lines.push("\nAtkvæði einstakra þingmanna: MCP-tólið `get_vote` með vote_id.\n");
  }
  lines.push(`## Umsagnir\n\nBeiðnir um umsögn: ${r.consultations.requests}; umsagnir og erindi: ${r.consultations.submissions_received}.\n`);
  lines.push(`## Ræður (${r.speeches.total})\n`);
  lines.push(r.speeches.index.map((s) => `- ${fmtDateTime(s.started)} · ${esc(s.member.name)} · ${s.speech_type}${debateLabel(s.debate) ? ` (${debateLabel(s.debate)})` : ""} — ${SITE}/raeda/${s.id}.md`).join("\n") || "_Engar ræður með texta._");
  return front({ title: m.title, url: m.url, lthing: m.lthing, class: m.class, nr: m.nr, status: m.status, althingi_url: m.althingi_url }) + lines.join("\n") + "\n" + FOOTER;
}

export function memberMd(r: R<typeof T.getMember>): string {
  const m = r.member;
  const seats = r.seats.map((s) => `| ${s.lthing} | ${s.kind} | ${esc(s.party)} | ${esc(s.constituency)} | ${s.from ?? ""} | ${s.to ?? ""} |`).join("\n");
  const recent = r.recent_speeches.map((s) => `- ${fmtDateTime(s.started)} · ${s.speech_type}${s.matter_title ? ` · ${esc(s.matter_title)}` : ""} — ${SITE}/raeda/${s.id}.md`).join("\n");
  return front({ title: m.name, url: m.url, member_id: m.id, born: m.born, althingi_url: m.althingi_url })
    + `# ${esc(m.name)}\n\nRæður í safninu: ${m.speeches_in_corpus}. Á vef Alþingis: ${m.althingi_url}\n\n`
    + `## Þingseta\n\n„með varamann“ = í leyfi, varamaður situr. Flokkur á tilteknum degi ræðst af þingsetu þann dag.\n\n| Þing | Seta | Flokkur | Kjördæmi | Frá | Til |\n|---|---|---|---|---|---|\n${seats}\n\n`
    + `## Nýlegar ræður\n\n${recent || "_Engar._"}\n\nAtkvæði þingmannsins: MCP-tólið \`member_votes\` með member_id ${m.id}.\n` + FOOTER;
}

export function lawMd(r: R<typeof T.getLaw>, articles: { heading: string | null; text: string }[]): string {
  const l = r.law;
  const parts = [
    `# ${esc(l.title ?? `Lög nr. ${l.nr}/${l.year}`)}\n`, `Lög nr. ${l.nr}/${l.year}${l.chapter ? ` · ${esc(l.chapter)}` : ""}${l.in_force ? ` · ${esc(l.in_force)}` : ""}${l.edition ? ` · lagasafn ${l.edition}` : ""}\n`,
    `Á vef Alþingis: ${l.althingi_url}\n`,
  ];
  if (l.enacted_by_matter) parts.push(`Sett með: [${esc(l.enacted_by_matter.title ?? `${l.enacted_by_matter.nr}. mál`)}](${l.enacted_by_matter.url}.md)\n`);
  if (r.matters_amending.length) parts.push("## Mál sem breyta lögunum\n", r.matters_amending.map((m) => `- [${esc(m.title)}](${m.url}.md) (${m.nr}. mál á ${m.lthing}. þingi)${m.status ? ` — ${esc(m.status)}` : ""}`).join("\n") + "\n");
  if (r.amended_by.length) parts.push("## Breytt með\n", r.amended_by.map((a) => `- [Lög nr. ${a.nr}/${a.year}](${a.url}.md)${a.title ? ` ${esc(a.title)}` : ""}${a.effective ? ` (${esc(a.effective)})` : ""}`).join("\n") + "\n");
  if (articles.length) parts.push("## Texti\n", articles.map((a) => `### ${esc(a.heading ?? "")}\n\n${esc(a.text)}`).join("\n\n") + "\n");
  parts.push(`_${r.note}_\n`);
  return front({ title: l.title ?? `Lög nr. ${l.nr}/${l.year}`, url: l.url, law: l.id, althingi_url: l.althingi_url, edition: l.edition }) + parts.join("\n") + FOOTER;
}

export function dayMd(d: DayPage): string {
  const g = d.groups.map((x) => `## ${x.cls && x.nr !== null ? `[${esc(x.title ?? `${x.nr}. mál`)}](${matterHref(x.lthing, x.cls, x.nr)}.md)` : esc(x.title ?? "Annað")}\n\n`
    + x.speeches.map((s) => `- ${fmtTime(s.started)} · ${esc(s.memberName)} · ${s.type} — ${SITE}/raeda/${s.id}.md`).join("\n")).join("\n\n");
  return front({ title: `Þingdagur ${fmtDate(d.date)}`, url: `${SITE}/dagur/${d.date}`, date: d.date, speeches: d.total, prev: d.prev, next: d.next })
    + `# Þingdagur ${fmtDate(d.date)}\n\n${d.total} ræður.${d.prev ? ` Fyrri: ${SITE}/dagur/${d.prev}.md` : ""}${d.next ? ` Næsti: ${SITE}/dagur/${d.next}.md` : ""}\n\n${g}\n` + FOOTER;
}

export function partyMd(p: PartyPage): string {
  const mem = p.members.map((m) => `- [${esc(m.name)}](${SITE}/thingmadur/${m.id}.md)${m.constituency ? ` · ${esc(m.constituency)}` : ""}${m.sitting ? "" : " (ekki sitjandi í lok þings)"} · ${m.speeches} ræður`).join("\n");
  return front({ title: p.name, url: `${SITE}/flokkur/${p.id}`, party_id: p.id, lthing: p.lthing })
    + `# ${esc(p.name)}\n\nRæður í safninu (flokkur á ræðudegi): ${p.speechCount}.\n\n## Þingmenn${p.lthing ? ` á ${p.lthing}. þingi` : ""}\n\n${mem || "_Engir._"}\n` + FOOTER;
}

export function docMd(d: DocPage): string {
  return front({ title: `Þingskjal ${d.nr} á ${d.lthing}. þingi`, url: `${SITE}/thingskjal/${d.lthing}/${d.nr}`, althingi_url: d.althingiUrl })
    + `# Þingskjal ${d.nr}: ${esc(d.type)}\n\n${d.lthing}. þing${d.issued ? ` · ${fmtDate(d.issued)}` : ""}\n\n`
    + (d.matter ? `Mál: [${esc(d.matter.title ?? `${d.matter.nr}. mál`)}](${matterHref(d.lthing, d.matter.cls, d.matter.nr)}.md)\n\n` : "")
    + `Texti skjalsins: ${d.althingiUrl}${d.pdfUrl ? ` · PDF: ${d.pdfUrl}` : ""}\n`
    + (d.votes.length ? `\n## Atkvæðagreiðslur um skjalið\n\n${d.votes.map((v) => `- ${v.at ? fmtDateTime(v.at) : ""} · ${esc(v.kind)} · ${esc(v.result)} (${v.yes ?? 0}–${v.no ?? 0}, ${v.abstain ?? 0} sátu hjá) · vote_id ${v.id}`).join("\n")}\n` : "") + FOOTER;
}

export const glossaryMd = () => GLOSSARY.map(([is, en, d]) => `- **${is}** (${en}): ${d}`).join("\n");

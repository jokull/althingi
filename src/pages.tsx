// Server-rendered pages (Hono JSX). No client framework: htmx plus one small inline script (typeahead keys, copy). Icelandic UI.
import { KINDS, personLike, topResult, type EntityHit, type EntityResult, type Kind } from "./entities.ts";
import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CommitteeMatter, DayPage, DocPage, LawPage, ListedMatter, MatterExtras, MatterPage, MemberPage, PartyPage, SpeechPage, TranscriptSpeech } from "./queries.ts";
import { lawUrl } from "./laws.ts";
import type { SearchResult, SpeechHit } from "./search.ts";
import type { Suggestion } from "./suggest.ts";

/** cache-busting version for the stylesheet (it is served with a day-long max-age) */
const CSS_V = createHash("sha1").update(readFileSync(new URL("../public/app.css", import.meta.url))).digest("hex").slice(0, 10);

export const SITE = process.env.SITE_URL ?? "https://althingi.solberg.is";
const MONTHS = ["janúar", "febrúar", "mars", "apríl", "maí", "júní", "júlí", "ágúst", "september", "október", "nóvember", "desember"];

/** "2026-06-12" -> "12. júní 2026" */
export const fmtDate = (iso: string): string => {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])}. ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso;
};
/** "2026-06-12 14:19:33" | "2026-06-12T14:19:33" -> "14:19" */
export const fmtTime = (ts: string): string => ts.match(/[T ](\d{2}:\d{2})/)?.[1] ?? "";
export const fmtDateTime = (ts: string): string => `${fmtDate(ts)} kl. ${fmtTime(ts)}`;
/** "2026-06-12" -> "12.6.2026" (citation style) */
const shortDate = (iso: string): string => { const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${Number(m[3])}.${Number(m[2])}.${m[1]}` : iso; };
const n = (x: number) => x.toLocaleString("is-IS");

export const debateLabel = (d: string): string | null => (d === "1" || d === "2" || d === "3" ? `${d}. umræða` : null);
export const matterUrl = (lthing: number, cls: string, nr: number): string => `/mal/${lthing}/${cls.toLowerCase()}/${nr}`;
export const speechUrl = (id: string, seq?: number): string => `/raeda/${id}${seq !== undefined ? `#mgr-${seq + 1}` : ""}`;

export function citation(p: SpeechPage, seq?: number): string {
  const who = `${p.memberName}${p.party ? ` (${p.party})` : ""}`;
  const m = p.matter ? `, ${p.matter.nr}. mál${p.matter.cls === "B" ? " (B)" : ""} á ${p.matter.lthing}. lþ.` : "";
  const para = seq !== undefined ? `, mgr. ${seq + 1}` : "";
  return `${who}, ${p.type} ${shortDate(p.date)} kl. ${fmtTime(p.started)}${m}${para} — ${SITE}/raeda/${p.id}${seq !== undefined ? `#mgr-${seq + 1}` : ""}`;
}

/** What the speech corpus covers, said plainly. */
export function coverageText(first: number, last: number): string {
  if (!last) return "Safnið er enn tómt; ræður bætast við.";
  const span = first === last ? `nær nú aðeins til ${last}. löggjafarþings` : `nær nú frá ${first}. til ${last}. löggjafarþings`;
  return `Safnið ${span}${first > 131 ? "; eldri þing bætast við" : ""}.`;
}

// ---------------------------------------------------------------- parties: colour + list letter (listabókstafur)

const PARTY: Record<string, { c: string; l: string }> = {
  "Sjálfstæðisflokkur": { c: "#1f5fae", l: "D" },
  "Samfylkingin": { c: "#d7263d", l: "S" },
  "Viðreisn": { c: "#f08a24", l: "C" },
  "Flokkur fólksins": { c: "#e8b62c", l: "F" },
  "Miðflokkurinn": { c: "#24375f", l: "M" },
  "Framsóknarflokkur": { c: "#2e8b48", l: "B" },
  "Vinstrihreyfingin - grænt framboð": { c: "#4f7d3a", l: "V" },
  "Píratar": { c: "#6b3fa0", l: "P" },
  "Björt framtíð": { c: "#8e5bb5", l: "A" },
  "Sósíalistaflokkur Íslands": { c: "#b3122e", l: "J" },
  "Frjálslyndi flokkurinn": { c: "#2f7fb8", l: "F" },
  "Alþýðubandalag": { c: "#a8322d", l: "G" },
  "Alþýðuflokkur": { c: "#c8423a", l: "A" },
  "Samtök um kvennalista": { c: "#c2508a", l: "V" },
  "Borgarahreyfingin": { c: "#d06a2a", l: "O" },
  "Hreyfingin": { c: "#d06a2a", l: "H" },
  "Dögun": { c: "#8a6d1f", l: "T" },
  "utan þingflokka": { c: "#8a877d", l: "–" },
};
const hash = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
export const partyColor = (name: string | null | undefined): string =>
  !name ? "#8a877d" : PARTY[name]?.c ?? `hsl(${hash(name) % 360} 45% 45%)`;
const partyLetter = (name: string) => PARTY[name]?.l ?? name.replace(/^[^\p{L}]+/u, "")[0]?.toUpperCase() ?? "?";
/** dark ink on light party colours (Flokkur fólksins yellow, Viðreisn orange) */
const lightParty = (name: string) => ["Flokkur fólksins", "Viðreisn"].includes(name);
const pc = (party: string | null | undefined) => `--pc:${partyColor(party)}`;
const initials = (name: string) => name.replace(/[^\p{L} ]/gu, "").split(" ").filter(Boolean).filter((w, i, a) => i === 0 || i === a.length - 1).map((w) => w[0]).join("").toUpperCase();

const Avatar = ({ name, party, size }: { name: string; party?: string | null; size?: "s" | "l" }) => (
  <span class={`ava${size ? ` ava-${size}` : ""}`} style={pc(party)} aria-hidden="true">{initials(name)}</span>
);
const PartyMark = ({ name, size }: { name: string; size?: "s" | "l" }) => (
  <span class={`pmark${size ? ` pmark-${size}` : ""}${lightParty(name) ? " on-light" : ""}`} style={pc(name)} aria-hidden="true">{partyLetter(name)}</span>
);
const Party = ({ name }: { name: string | null | undefined }) => (name ? <span class="party" style={pc(name)}>{name}</span> : null);

// ---------------------------------------------------------------- layout

interface LayoutProps { title: string; desc?: string; canonical?: string; q?: string; jsonld?: object; wide?: boolean; children?: Child }

/** Typeahead keys (↑ ↓ Enter Esc), "/" to focus search, copy buttons. Delegated, so it survives hx-boost swaps. */
const UI_JS = `(()=>{if(window.__ui)return;window.__ui=1;var D=document;
var box=function(){return D.getElementById('sug')},inp=function(){return D.getElementById('q')};
var opts=function(){var b=box();return b?[].slice.call(b.querySelectorAll('[role=option]')):[]};
var cur=function(){return opts().findIndex(function(x){return x.getAttribute('aria-selected')==='true'})};
function sel(i){var o=opts(),q=inp();o.forEach(function(x,j){x.setAttribute('aria-selected',j===i?'true':'false')});
 if(o[i]){q.setAttribute('aria-activedescendant',o[i].id);o[i].scrollIntoView({block:'nearest'})}else q.removeAttribute('aria-activedescendant')}
function close(){var b=box(),q=inp();if(b)b.innerHTML='';if(q){q.setAttribute('aria-expanded','false');q.removeAttribute('aria-activedescendant')}}
D.addEventListener('keydown',function(e){var t=e.target;
 if(t.id==='q'){var o=opts(),i=cur();
  if(e.key==='ArrowDown'&&o.length){e.preventDefault();sel((i+1)%o.length)}
  else if(e.key==='ArrowUp'&&o.length){e.preventDefault();sel(i<=0?o.length-1:i-1)}
  else if(e.key==='Enter'&&i>=0){e.preventDefault();var a=o[i];close();a.click()}
  else if(e.key==='Escape'){if(o.length){e.preventDefault();close()}else t.blur()}
  return}
 if(e.key==='/'&&!e.metaKey&&!e.ctrlKey&&!/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)&&!t.isContentEditable){var q=inp();if(q){e.preventDefault();q.focus();q.select()}}});
D.addEventListener('htmx:afterSwap',function(e){if(e.target.id==='sug'){var q=inp();if(q)q.setAttribute('aria-expanded',opts().length?'true':'false')}});
D.addEventListener('mousemove',function(e){var o=e.target.closest&&e.target.closest('#sug [role=option]');if(o)sel(opts().indexOf(o))});
D.addEventListener('focusout',function(e){if(e.target.id==='q')setTimeout(function(){var a=D.activeElement;if(!a||!a.closest||!a.closest('.omni'))close()},150)});
D.addEventListener('click',function(e){var c=e.target.closest&&e.target.closest('[data-copy]');if(!c)return;
 var src=D.getElementById(c.getAttribute('data-copy'));var txt=src?(src.value||src.textContent):c.getAttribute('data-copy');
 navigator.clipboard.writeText(txt).then(function(){var l=c.textContent;c.textContent='Afritað';c.setAttribute('data-done','');setTimeout(function(){c.textContent=l;c.removeAttribute('data-done')},1600)})});
})();`;

export const Layout = ({ title, desc, canonical, q, jsonld, wide, children }: LayoutProps) => (
  <html lang="is">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
      <meta name="color-scheme" content="light dark" />
      <meta name="theme-color" content="#f6f5f1" media="(prefers-color-scheme: light)" />
      <meta name="theme-color" content="#131312" media="(prefers-color-scheme: dark)" />
      <title>{title}</title>
      {desc && <meta name="description" content={desc} />}
      {canonical && <link rel="canonical" href={`${SITE}${canonical}`} />}
      <link rel="stylesheet" href={`/app.css?v=${CSS_V}`} />
      <script src="/htmx.min.js" defer></script>
      <script>{raw(UI_JS)}</script>
      <script type="speculationrules">{raw(JSON.stringify({ prefetch: [{ where: { href_matches: "/raeda/*" }, eagerness: "moderate" }, { where: { href_matches: "/mal/*" }, eagerness: "moderate" }, { where: { href_matches: "/thingmadur/*" }, eagerness: "moderate" }] }))}</script>
      {jsonld && <script type="application/ld+json">{raw(JSON.stringify(jsonld).replace(/</g, "\\u003c"))}</script>}
    </head>
    <body hx-boost="true">
      <a class="skip" href="#main">Beint í efni</a>
      <header class="top">
        <div class="bar">
          <a class="brand" href="/" aria-label="Alþingi · leit, forsíða"><span class="brand-mark" aria-hidden="true"></span>Alþingi<span class="brand-sub">leit</span></a>
          <form class="omni" action="/leit" method="get" role="search">
            <svg class="omni-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg>
            <input id="q" type="search" name="q" value={q ?? ""} placeholder="Þingmenn, mál, lög eða orð…" aria-label="Leita"
              autocomplete="off" autocapitalize="off" spellcheck={false} enterkeyhint="search"
              role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="sug"
              hx-get="/leit/forslag" hx-trigger="input changed delay:110ms, focus" hx-target="#sug" hx-swap="innerHTML" hx-sync="this:replace" hx-boost="false" />
            <kbd class="omni-kbd" aria-hidden="true">/</kbd>
            <div id="sug" class="sug" role="listbox" aria-label="Tillögur"></div>
          </form>
          <a class="toplink" href="/um">Um vefinn</a>
        </div>
      </header>
      <main id="main" class={wide ? "page wide" : "page"}>{children}</main>
      <footer class="foot">
        <div>
          <p>Ræður frá 2005 (XML-öld). Eldri ræður eru ekki í þessu safni. Gögn: <a href="https://www.althingi.is">Alþingi</a> · <a href="/um">Um vefinn</a> · <a href="/um#ordskyringar">Orðskýringar</a> · <a href="/nyjast/atom">Nýjustu ræður (Atom)</a></p>
          <p>Lemmun byggir á Beygingarlýsingu íslensks nútímamáls (BÍN), © Stofnun Árna Magnússonar í íslenskum fræðum, CC BY-SA 4.0, um lemma-is.</p>
        </div>
      </footer>
    </body>
  </html>
);

const Marked = ({ segs }: { segs: { text: string; highlight: boolean }[] }) => (
  <>{segs.map((s) => (s.highlight ? <mark>{s.text}</mark> : s.text))}</>
);

// ---------------------------------------------------------------- search

export interface SearchView {
  q: string;
  result: SearchResult;
  parties: Map<string, string | null>; // speechId -> party on that date
  suggestions: Suggestion[];
  baseQuery: string; // url-encoded filters (without cursor)
  corpusFrom: string | null;
  /** first and last session with speech text */
  coverage?: { first: number; last: number };
  /** parties sitting in the current session, for filter chips */
  partyList?: { id: number; name: string; seats: number }[];
  entities?: EntityResult;
  tab?: Kind | "raedur" | "allt";
  /** the question as typed, when parts of it were read as filters (see intent.ts) */
  asked?: string;
  interpreted?: string[];
  /** an offered (never applied) filter when the keywords contain a known member, party or matter */
  refine?: { href: string; label: string };
  /** last date with speech text, and the first */
  corpusTo?: string | null;
  /** display names for filter chips */
  memberName?: string;
}

const Hit = ({ h, party }: { h: SpeechHit; party: string | null | undefined }) => (
  <article class="hit">
    <header class="hit-h">
      {h.memberId === null ? <span class="who">{h.memberName}</span> : <a class="who" href={`/thingmadur/${h.memberId}`}>{h.memberName}</a>}
      {party && <Party name={party} />}
      <span class="hit-when">{h.speechType}{h.provisional ? " · bráðabirgðatexti" : ""} · <a href={speechUrl(h.speechId)}><time datetime={h.started.replace(" ", "T")}>{fmtDateTime(h.started)}</time></a>{h.althingiUrl && <> · <a href={h.althingiUrl} rel="noopener">Á vef Alþingis →</a></>}</span>
    </header>
    {h.matter && (
      <a class="hit-matter" href={matterUrl(h.matter.lthing, h.matter.cls, h.matter.nr)}>{h.matter.title ?? `${h.matter.nr}. mál`}</a>
    )}
    {h.paragraphs.map((p) => {
      const sn = p.snippets[0];
      return sn ? (
        <p class="snip"><a href={speechUrl(h.speechId, p.seq)}><span class="pn" aria-label={`málsgrein ${p.seq + 1}`}>{p.seq + 1}</span><Marked segs={sn.segments} /></a></p>
      ) : null;
    })}
    {h.matchingParagraphs > h.paragraphs.length && <a class="hit-more" href={speechUrl(h.speechId)}>+{h.matchingParagraphs - h.paragraphs.length} {h.matchingParagraphs - h.paragraphs.length === 1 ? "málsgrein í viðbót" : "málsgreinar í viðbót"} í ræðunni</a>}
  </article>
);

export const Rows = ({ v }: { v: SearchView }) => (
  <>
    {v.result.hits.map((h) => <Hit h={h} party={v.parties.get(h.speechId)} />)}
    {v.result.nextCursor && (
      <div id="more" class="more">
        <a class="btn-quiet" href={`/leit?${v.baseQuery}&c=${v.result.nextCursor}`} hx-get={`/leit/rows?${v.baseQuery}&c=${v.result.nextCursor}`} hx-target="#more" hx-swap="outerHTML" hx-boost="false" hx-indicator="#more">Sýna fleiri ræður</a>
      </div>
    )}
  </>
);

const kindLabel = (k: Kind) => KINDS.find((x) => x.id === k)!.label;
const KIND_ONE: Record<Kind, string> = { thingmenn: "Þingmaður", flokkar: "Flokkur", mal: "Mál", atkvaedi: "Atkvæðagreiðsla", umsagnir: "Umsögn", nefndir: "Nefnd", efni: "Efnisflokkur", log: "Lög" };

const ICON: Record<string, string> = {
  mal: '<path d="M5 2.75h6.5L15 6.25v11H5z"/><path d="M11.5 2.75v3.5H15M7.5 10h5M7.5 13h5"/>',
  atkvaedi: '<rect x="3" y="3" width="14" height="14" rx="3"/><path d="m6.5 10.5 2.5 2.5 4.5-5.5"/>',
  umsagnir: '<rect x="2.75" y="4.75" width="14.5" height="10.5" rx="2"/><path d="m3.5 6 6.5 5 6.5-5"/>',
  nefndir: '<circle cx="7" cy="7.5" r="2.5"/><circle cx="13.5" cy="8" r="2"/><path d="M2.75 16c.5-2.6 2.2-4 4.25-4s3.75 1.4 4.25 4M12 12.4c.5-.25 1-.4 1.5-.4 1.7 0 3 1.2 3.5 3.5"/>',
  efni: '<path d="M3 3.75h6.5l7.5 7.5-5.75 5.75-7.5-7.5z"/><circle cx="6.75" cy="7.25" r="1.25"/>',
  log: '<path d="M4 3.5h9.5a2 2 0 0 1 2 2v11H6a2 2 0 0 1-2-2z"/><path d="M4 14.5a2 2 0 0 1 2-2h9.5"/>',
  raedur: '<path d="M3.5 4.5h13v9H10l-4 3v-3H3.5z"/>',
};
const KindMark = ({ k }: { k: string }) => (
  <span class={`kmark k-${k}`} aria-hidden="true"><svg viewBox="0 0 20 20">{raw(ICON[k] ?? ICON.mal!)}</svg></span>
);
const Lead = ({ e }: { e: EntityHit }) =>
  e.kind === "thingmenn" ? <Avatar name={e.title} party={e.member?.party} /> : e.kind === "flokkar" ? <PartyMark name={e.title} /> : <KindMark k={e.kind} />;

/** a compact typed result row (rail groups, kind tabs) */
export const EntityRow = ({ e, weak }: { e: EntityHit; weak?: boolean }) => (
  <a class={`erow k-${e.kind}`} href={e.href}>
    <Lead e={e} />
    <span class="erow-b">
      <span class="erow-t">{e.title}</span>
      <span class="erow-m">
        {e.kind === "thingmenn" && e.member?.party && <><Party name={e.member.party} />{e.meta && " · "}</>}
        {e.kind !== "thingmenn" && e.badge && e.kind !== "flokkar" && e.kind !== "nefndir" && e.kind !== "log" && <>{e.badge} · </>}
        {e.meta}
        {e.status && <> · {e.status}</>}
        {weak && <> · <em>líkt nafn, ekki nákvæm samsvörun</em></>}
      </span>
    </span>
    {e.stats && <span class="erow-s">{e.stats[0]}</span>}
  </a>
);
/** kept for callers that render a single card */
export const EntityCard = EntityRow;

const statusTone = (s: string | null | undefined) =>
  !s ? "" : /samþykkt|afgreidd|svarað(?!.*ekki)|svar barst/i.test(s) && !/ekki/i.test(s) ? "ok" : /fellt|ekki|dregin/i.test(s) ? "no" : "mid";

const TopCard = ({ e }: { e: EntityHit }) => {
  if (e.kind === "thingmenn" && e.member) {
    const m = e.member;
    return (
      <section class="top-card" style={pc(m.party)} aria-label="Besta samsvörun">
        <Avatar name={e.title} party={m.party} size="l" />
        <div class="tc-b">
          <h2 class="tc-t"><a href={e.href}>{e.title}</a></h2>
          <p class="tc-m">{m.party && <Party name={m.party} />}{m.constituency && <> · {m.constituency}</>}</p>
          <dl class="facts">
            {m.first && m.last && <div><dt>Þingseta</dt><dd>{m.first === m.last ? `${m.last}. þing` : `${m.first}.–${m.last}. þing`}</dd></div>}
            <div><dt>Ræður í safni</dt><dd>{n(m.speeches)}</dd></div>
            {m.lastSpeech && <div><dt>Síðasta ræða</dt><dd><a href={speechUrl(m.lastSpeech.id)}>{fmtDate(m.lastSpeech.started)}</a></dd></div>}
          </dl>
          <p class="tc-act"><a href={e.href}>Prófíll og ræður →</a></p>
        </div>
      </section>
    );
  }
  if (e.kind === "flokkar" && e.party) {
    const p = e.party;
    return (
      <section class="top-card" style={pc(e.title)} aria-label="Besta samsvörun">
        <PartyMark name={e.title} size="l" />
        <div class="tc-b">
          <h2 class="tc-t"><a href={e.href}>{e.title}</a></h2>
          <dl class="facts">
            {p.lthing && <div><dt>Þingmenn á {p.lthing}. þingi</dt><dd>{p.seats}</dd></div>}
            <div><dt>Ræður í safni</dt><dd>{n(p.speeches)}</dd></div>
          </dl>
          <p class="tc-act"><a href={e.href}>Þingmenn og ræður flokksins →</a></p>
        </div>
      </section>
    );
  }
  return (
    <section class="top-card" aria-label="Besta samsvörun">
      <div class="tc-b">
        <h2 class="tc-t"><a href={e.href}>{e.title}</a></h2>
        <p class="tc-m">{e.meta}{e.status && <> · <span class={`status ${statusTone(e.status)}`}>{e.status}</span></>}</p>
      </div>
    </section>
  );
};

/** One option row in the typeahead. */
const SugRow = ({ e, i }: { e: EntityHit; i: number }) => (
  <a id={`sug-${i}`} href={e.href} role="option" aria-selected="false" class="so">
    <Lead e={e} />
    <span class="so-b"><span class="so-t">{e.title}</span><span class="so-m">{e.kind === "thingmenn" ? [e.member?.party, e.meta].filter(Boolean).join(" · ") : e.meta}</span></span>
    <span class="so-k">{KIND_ONE[e.kind]}</span>
  </a>
);

export const Suggest = ({ ents, q }: { ents: EntityResult; q: string }) => {
  const strong = ents.thingmenn.filter((m) => m.strong);
  const people = strong.length ? strong : ents.thingmenn.slice(0, 2);
  const groups = KINDS.map((k) => ({ k, items: (k.id === "thingmenn" ? people : ents[k.id]).slice(0, k.id === "thingmenn" || k.id === "mal" ? 3 : 2) }))
    .filter((g) => g.items.length > 0).slice(0, 5);
  let i = 0;
  return (
    <>
      {groups.map((g) => (
        <div class="sg" role="group" aria-label={g.k.label}>
          <div class="sgh" aria-hidden="true">{g.k.id === "thingmenn" && !strong.length ? "Svipuð nöfn" : g.k.label}</div>
          {g.items.map((e) => <SugRow e={e} i={i++} />)}
        </div>
      ))}
      <a id={`sug-${i}`} class="so so-all" href={`/leit?q=${encodeURIComponent(q)}`} role="option" aria-selected="false">
        <KindMark k="raedur" />
        <span class="so-b"><span class="so-t">Leita að „{q}“ í ræðum</span></span>
        <kbd aria-hidden="true">↵</kbd>
      </a>
    </>
  );
};

const qs = (base: string, set: Record<string, string | null>) => {
  const u = new URLSearchParams(base);
  for (const [k, v] of Object.entries(set)) v === null ? u.delete(k) : u.set(k, v);
  return `/leit?${u.toString()}`;
};

const Tabs = ({ v }: { v: SearchView }) => {
  const e = v.entities;
  if (!e) return null;
  const href = (t?: string) => `/leit?q=${encodeURIComponent(v.q)}${t ? `&t=${t}` : ""}`;
  const tab = v.tab ?? "allt";
  const count = (k: Kind) => (k === "thingmenn" ? e.thingmenn.filter((m) => m.strong).length || e.thingmenn.length : e[k].length);
  return (
    <nav class="tabs" aria-label="Tegund niðurstaðna">
      <div class="tabs-in">
        <a href={href()} aria-current={tab === "allt" ? "page" : undefined}>Allt</a>
        <a href={href("raedur")} aria-current={tab === "raedur" ? "page" : undefined}>Ræður</a>
        {KINDS.filter((k) => e[k.id].length > 0).map((k) => (
          <a href={href(k.id)} aria-current={tab === k.id ? "page" : undefined}>{k.label} <span class="n">{count(k.id)}</span></a>
        ))}
      </div>
    </nav>
  );
};

const Filters = ({ v }: { v: SearchView }) => {
  const u = new URLSearchParams(v.baseQuery);
  const on = (k: string, val: string) => u.get(k) === val;
  const types: [string, string][] = [["ræða", "Ræður"], ["andsvar", "Andsvör"], ["flutningsræða", "Flutningsræður"], ["svar", "Svör ráðherra"], ["um fundarstjórn", "Fundarstjórn"]];
  const active: { label: string; key: string }[] = [];
  if (u.get("thm")) active.push({ label: v.memberName ?? "Einn þingmaður", key: "thm" });
  if (u.get("tegund") && !types.some(([t]) => t === u.get("tegund"))) active.push({ label: u.get("tegund")!, key: "tegund" });
  if (u.get("hlutverk")) active.push({ label: u.get("hlutverk")!, key: "hlutverk" });
  if (u.get("mal")) active.push({ label: `Innan máls ${u.get("mal")}`, key: "mal" });
  if (u.get("thing")) active.push({ label: `${u.get("thing")}. þing`, key: "thing" });
  if (u.get("fra")) active.push({ label: `frá ${fmtDate(u.get("fra")!)}`, key: "fra" });
  if (u.get("til")) active.push({ label: `til ${fmtDate(u.get("til")!)}`, key: "til" });
  if (u.get("embaetti")) active.push({ label: u.get("embaetti")!, key: "embaetti" });
  if (u.get("umraeda")) active.push({ label: `Umræða ${u.get("umraeda")}`, key: "umraeda" });
  return (
    <div class="filters" role="group" aria-label="Síur">
      <span class="seg" role="group" aria-label="Röðun">
        {v.q.trim() && <a href={qs(v.baseQuery, { nyjast: null })} aria-current={!u.get("nyjast") ? "true" : undefined}>Mikilvægast</a>}
        <a href={qs(v.baseQuery, { nyjast: "1" })} aria-current={u.get("nyjast") && u.get("nyjast") !== "elst" ? "true" : undefined}>Nýjast</a>
        <a href={qs(v.baseQuery, { nyjast: "elst" })} aria-current={u.get("nyjast") === "elst" ? "true" : undefined}>Elst</a>
      </span>
      {types.map(([val, label]) => (
        <a class="chip" href={qs(v.baseQuery, { tegund: on("tegund", val) ? null : val })} aria-current={on("tegund", val) ? "true" : undefined}>{label}</a>
      ))}
      {(v.partyList ?? []).map((p) => (
        <a class="chip" href={qs(v.baseQuery, { flokkur: on("flokkur", String(p.id)) ? null : String(p.id) })} aria-current={on("flokkur", String(p.id)) ? "true" : undefined} title={p.name}>
          <span class="dot" style={pc(p.name)} aria-hidden="true"></span>{partyLetter(p.name) === "–" ? "Utan flokka" : p.name.replace(/flokkur(inn)?$/, "fl.")}
        </a>
      ))}
      {active.map((a) => (
        <a class="chip" aria-current="true" href={qs(v.baseQuery, { [a.key]: null })} aria-label={`Fjarlægja síu: ${a.label}`}>{a.label} <span aria-hidden="true">×</span></a>
      ))}
    </div>
  );
};

const Coverage = ({ v }: { v: SearchView }) => (v.coverage ? <>{coverageText(v.coverage.first, v.coverage.last)}</> : null);

export const SearchPage = ({ v }: { v: SearchView }) => {
  const { result: r } = v;
  const parsed = r.query.parsed;
  const e = v.entities;
  const tab = v.tab ?? "allt";
  const strong = e ? e.thingmenn.filter((m) => m.strong) : [];
  const weak = e ? e.thingmenn.filter((m) => !m.strong) : [];
  // a query that mixes a name with topic words is rewritten by intent.ts before it gets here, so this only fires for names
  const nameMiss = !!e && strong.length === 0 && personLike(v.q) && (weak.length > 0 || /(son|dóttir)$/iu.test(v.q.trim()));
  const years = r.query.parsed.numbers.filter((x) => /^(19|20)\d{2}$/.test(x) && v.corpusFrom && Number(x) < Number(v.corpusFrom.slice(0, 4)));
  const u = new URLSearchParams(v.baseQuery);
  const after = v.corpusTo && u.get("fra") && u.get("fra")! > v.corpusTo;
  const before = v.corpusFrom && u.get("til") && u.get("til")! < v.corpusFrom;
  const words = r.query.parsed.parts.filter((x) => x.kind === "word");
  const top = e && tab === "allt" ? topResult(e, v.q) : null;
  const showHits = tab === "allt" || tab === "raedur";
  const order: Kind[] = ["thingmenn", "flokkar", "mal", "nefndir", "log", "efni", "umsagnir", "atkvaedi"];
  const groups = e && tab === "allt"
    ? order.map((k) => ({ k, items: (k === "thingmenn" ? strong : e[k]).filter((x) => x !== top) })).filter((g) => g.items.length > 0).slice(0, 4)
    : [];
  const empty = r.hits.length === 0 && (!e || KINDS.every((k) => e[k.id].length === 0));
  return (
    <Layout title={`${v.asked ?? v.q} – leit í ræðum Alþingis`} q={v.asked ?? v.q} canonical={`/leit?q=${encodeURIComponent(v.asked ?? v.q)}`} wide>
      <div class="sr-head">
        <h1 class="sr-q">{v.asked ? <>„{v.asked}“</> : v.q ? <>„{v.q}“</> : "Leit"}</h1>
        {v.interpreted && v.interpreted.length > 0 && (
          <p class="sr-how">Lesið sem: {v.interpreted.join(" · ")}{v.q.trim() ? <> · orð: <span class="interp">{r.query.description || v.q}</span></> : null} · <a href={`/leit?q=${encodeURIComponent(v.asked ?? v.q)}&ordrett=1`}>Leita orðrétt í staðinn</a></p>
        )}
        {v.refine && <p class="sr-how">Sía: <a href={v.refine.href}>{v.refine.label}</a></p>}
        {!v.interpreted && r.query.description && (
          <p class="sr-how">
            Leitað að: <span class="interp">{r.query.description}</span>
            {parsed.dropped.length > 0 && <> · slepptum: {parsed.dropped.join(", ")}</>}
          </p>
        )}
      </div>
      <Tabs v={v} />
      {glossaryHit(v.asked ?? v.q) && (() => { const g = glossaryHit(v.asked ?? v.q)!; return <p class="notice notice-soft"><strong>{g[0]}</strong> ({g[1]}): {g[2]} <a href="/um#ordskyringar">Fleiri orðskýringar</a></p>; })()}

      {nameMiss && (
        <div class="notice" role="status">
          <p><strong>Enginn þingmaður í safninu heitir „{v.q}“.</strong> <Coverage v={v} /></p>
          {weak.length > 0 && <p class="notice-m">Svipuð nöfn sem eru ekki sama manneskjan: {weak.slice(0, 4).map((w, i) => <>{i > 0 && ", "}<a href={w.href}>{w.title}</a></>)}.</p>}
        </div>
      )}
      {!nameMiss && v.suggestions.filter((s) => s.suggestions.length > 0).map((s) => (
        <p class="notice notice-soft">Orðið „{s.word}“ finnst ekki í safninu. Áttirðu við {s.suggestions.map((w, i) => <>{i > 0 && (i === s.suggestions.length - 1 ? " eða " : ", ")}<a href={`/leit?q=${encodeURIComponent(w)}`}>{w}</a></>)}?</p>
      ))}

      {e && tab !== "allt" && tab !== "raedur" && (
        <section class="klist" aria-label={kindLabel(tab)}>
          {(tab === "thingmenn" ? [...strong, ...weak] : e[tab]).map((x) => <EntityRow e={x} weak={tab === "thingmenn" && !x.strong} />)}
          {e[tab].length === 0 && <p class="empty">Ekkert fannst í flokknum {kindLabel(tab)}.</p>}
        </section>
      )}

      {showHits && (
        <div class={top || groups.length ? "sr-grid" : "sr-grid one"}>
          {(top || groups.length > 0) && (
            <aside class="side" aria-label="Aðrar niðurstöður">
              {top && <TopCard e={top} />}
              {groups.map((g) => (
                <section class="group">
                  <h2 class="group-h"><span>{kindLabel(g.k)}</span>{g.items.length > 3 && <a href={`/leit?q=${encodeURIComponent(v.q)}&t=${g.k}`}>Sjá allt ({g.items.length})</a>}</h2>
                  {g.items.slice(0, 3).map((x) => <EntityRow e={x} />)}
                </section>
              ))}
            </aside>
          )}
          <section class="hits" aria-label="Ræður">
            <div class="hits-h">
              <h2>Ræður{r.total !== undefined && r.total > 0 && <span class="n"> {r.totalCapped ? `${n(r.total)}+` : n(r.total)}</span>}</h2>
              {r.hits.length > 0 && <span class="hits-x"><a href={`/leit/atom?${v.baseQuery}`} hx-boost="false">Fylgjast með (Atom)</a> · <a href={`/leit.csv?${v.baseQuery}`} hx-boost="false" download>Sækja CSV</a></span>}
            </div>
            {(r.hits.length > 0 || /(^|&)(tegund|flokkur|nyjast|thm|mal|thing|fra|til|embaetti|umraeda|hlutverk)=/.test(v.baseQuery)) && <Filters v={v} />}
            {r.matterCards.length > 0 && !e && (
              <div class="mcards">
                {r.matterCards.map((c) => (
                  <div class="erow k-mal"><KindMark k="mal" /><span class="erow-b"><a class="erow-t" href={matterUrl(c.lthing, c.cls, c.nr)}>{c.title}</a><span class="erow-m">{c.nr}. mál á {c.lthing}. þingi</span></span><a class="erow-s" href={c.althingiUrl} rel="noopener">Á vef Alþingis →</a></div>
                ))}
              </div>
            )}
            {years.length > 0 && r.hits.length > 0 && <p class="notice notice-soft">Ræður frá {years.join(", ")} eru ekki í safninu (það nær aftur til {fmtDate(v.corpusFrom!)}); hér er leitað að ártalinu í textanum.</p>}
            {r.hits.length === 0 ? (
              <div class="empty-state">
                <p class="es-t"><strong>Engar niðurstöður{empty ? "" : " í ræðum"}.</strong></p>
                {after && <p>Nýjustu ræður í safninu eru frá {fmtDate(v.corpusTo!)}; ræður eftir það hafa ekki verið sóttar enn. <a href={`/dagur/${v.corpusTo}`}>Síðasti þingdagur í safninu</a> · <a href={qs(v.baseQuery, { fra: null, til: null })}>sama leit án dagsetninga</a></p>}
                {before && <p>Ræður fyrir {fmtDate(v.corpusFrom!)} eru ekki komnar í safnið. <a href={qs(v.baseQuery, { fra: null, til: null })}>Sama leit án dagsetninga</a></p>}
                {!after && !before && years.length > 0 && <p>Ræður frá {years.join(", ")} eru ekki í safninu enn (það nær aftur til {fmtDate(v.corpusFrom!)}).</p>}
                {words.length > 1 && <p>Öll orðin þurfa að koma fyrir í sömu málsgrein. Prófaðu eitt í einu: {words.map((w, i) => <>{i > 0 && " · "}<a href={qs(v.baseQuery, { q: w.text })}>{w.text}</a></>)}</p>}
                {!nameMiss && <p><Coverage v={v} /></p>}
                <ul>
                  <li>Leitin nær til ræðna frá 2005{v.corpusFrom ? ` (safnið sem er sótt nú nær aftur til ${fmtDate(v.corpusFrom)})` : ""}.</li>
                  <li>Framíköll eru ekki leitarbær.</li>
                  {parsed.numbers.length > 0 && <li>Tölur ({parsed.numbers.join(", ")}) eru bornar saman við textann sjálfan, ekki beygingarmyndir.</li>}
                  <li>Prófaðu færri orð eða eina orðmynd; leitin finnur allar beygingarmyndir orðs.</li>
                </ul>
              </div>
            ) : (
              <div class="hit-list"><Rows v={v} /></div>
            )}
          </section>
        </div>
      )}
    </Layout>
  );
};

// ---------------------------------------------------------------- speech

export const SpeechPageView = ({ s }: { s: SpeechPage }) => {
  const deb = debateLabel(s.debate);
  const cite = citation(s);
  return (
    <Layout
      title={`${s.memberName} – ${s.type} ${fmtDate(s.date)}${s.matter?.title ? ` – ${s.matter.title}` : ""}`}
      desc={s.paragraphs[0]?.text.slice(0, 200)}
      canonical={`/raeda/${s.id}`}
      jsonld={{
        "@context": "https://schema.org", "@type": "CreativeWork", name: `${s.type} – ${s.memberName}, ${fmtDate(s.date)}`,
        author: { "@type": "Person", name: s.memberName }, datePublished: s.date, inLanguage: "is", url: `${SITE}/raeda/${s.id}`,
        isBasedOn: "https://www.althingi.is", license: "https://www.althingi.is",
      }}
    >
      <article class="speech">
        <header class="sp-head">
          {s.matter && (
            <p class="sp-matter"><a href={matterUrl(s.matter.lthing, s.matter.cls, s.matter.nr)}>{s.matter.title ?? `${s.matter.nr}. mál`}</a>
              <span> · {s.matter.nr}. mál{s.matter.cls === "B" ? " (B-mál: titill úr ræðuskrá, engin skjöl)" : ""} á {s.matter.lthing}. þingi</span></p>
          )}
          <div class="who-line">
            <Avatar name={s.memberName} party={s.party} size="l" />
            <div>
              <h1>{s.memberId === null ? s.memberName : <a href={`/thingmadur/${s.memberId}`}>{s.memberName}</a>}</h1>
              <p class="who-m">{s.memberId === null && <>skammstöfun í ræðuskrá; ekki enn tengd þingmanni</>}{s.party && <Party name={s.party} />}{s.office && <> · {s.office}</>}{s.capacity && s.capacity !== "þingmaður" && <> · {s.capacity}</>}</p>
            </div>
          </div>
          <p class="sp-meta">
            <span class="tag">{s.type}</span>
            {deb && <span class="tag">{deb}</span>}
            <time datetime={s.started.replace(" ", "T")}>{fmtDateTime(s.started)}{s.ended ? `–${fmtTime(s.ended)}` : ""}</time>
            {s.wordCount ? <span>{n(s.wordCount)} orð</span> : null}
            {s.provisional && <span>bráðabirgðatexti: lokatexti Alþingis hefur ekki borist</span>}
          </p>
          <p class="sp-links">
            <a href={`/dagur/${s.date}`}>Allur þingdagurinn</a>
            {s.vodUrl && <a href={s.vodUrl} rel="noopener">Horfa á upptöku</a>}
            {s.audioUrl && <a href={s.audioUrl} rel="noopener">Hljóð</a>}
            {s.althingiUrl && <a href={s.althingiUrl} rel="noopener">Á vef Alþingis →</a>}
          </p>
        </header>
        <section class="prose" aria-label="Ræðutexti">
          {s.paragraphs.map((p) => (
            <div class="para" id={`mgr-${p.seq + 1}`}>
              <a class="n" href={`#mgr-${p.seq + 1}`} title="Tengill á þessa málsgrein" aria-label={`Málsgrein ${p.seq + 1}`}>{p.seq + 1}</a>
              <p>{p.text}</p>
              {p.interjections.map((i) => <p class="interj"><span>Framíkall</span> {i}</p>)}
            </div>
          ))}
          {s.paragraphs.length === 0 && <p class="empty">Texti ræðunnar hefur ekki verið sóttur enn.</p>}
        </section>
        <section class="cite-box" aria-labelledby="tilv">
          <h2 id="tilv">Tilvitnun</h2>
          <div class="cite-row">
            <input id="cite" class="cite" type="text" readonly value={cite} onfocus="this.select()" aria-label="Tilvitnun" />
            <button type="button" class="btn" data-copy="cite">Afrita</button>
          </div>
          <p class="hint">Smelltu á málsgreinanúmer til að fá tengil á hana ({SITE}/raeda/{s.id}#mgr-N).</p>
        </section>
        <nav class="pager" aria-label="Ræður í sama máli">
          {s.prevId ? <a href={`/raeda/${s.prevId}`} rel="prev"><span>Fyrri ræða í málinu</span></a> : <span />}
          {s.nextId ? <a href={`/raeda/${s.nextId}`} rel="next" class="next"><span>Næsta ræða í málinu</span></a> : <span />}
        </nav>
      </article>
    </Layout>
  );
};

// ---------------------------------------------------------------- matter

const VoteBar = ({ yes, no, abstain }: { yes: number | null; no: number | null; abstain: number | null }) => {
  const t = (yes ?? 0) + (no ?? 0) + (abstain ?? 0);
  if (!t) return null;
  const w = (x: number | null) => `width:${(((x ?? 0) / t) * 100).toFixed(1)}%`;
  return (
    <span class="vbar" role="img" aria-label={`já ${yes ?? 0}, nei ${no ?? 0}, sátu hjá ${abstain ?? 0}`}>
      <span class="v-y" style={w(yes)}></span><span class="v-n" style={w(no)}></span><span class="v-a" style={w(abstain)}></span>
    </span>
  );
};

export const MatterPageView = ({ m, x }: { m: MatterPage; x?: MatterExtras }) => {
  const url = matterUrl(m.lthing, m.cls, m.nr);
  const byStage = new Map<string, MatterPage["speeches"]>();
  for (const s of m.speeches) {
    const k = debateLabel(s.debate) ?? "Aðrar ræður";
    byStage.set(k, [...(byStage.get(k) ?? []), s]);
  }
  return (
    <Layout title={`${m.title} – ${m.nr}. mál á ${m.lthing}. þingi`} desc={m.statusText ?? undefined} canonical={url}>
      <header class="page-head">
        <p class="crumbs">{m.nr}. mál á {m.lthing}. þingi {m.typeLabel && <span class="tag">{m.typeLabel}</span>} {m.cls === "B" && <span class="tag">B-mál</span>}</p>
        <h1>{m.title}</h1>
        {m.subtitle && <p class="lede">{m.subtitle}</p>}
        {m.statusText && <p><span class={`status ${statusTone(m.statusText)}`}><span class="sr">Staða: </span>{m.statusText}</span></p>}
        <p class="sp-links">
          {m.speechCount > 0 && <a href={`${url}/umraeda`}>Öll umræðan á einni síðu</a>}
          <a href={`${url}/atom`} hx-boost="false">Fylgjast með málinu (Atom)</a>
          <a href={m.althingiUrl} rel="noopener">Á vef Alþingis →</a>
        </p>
      </header>
      {m.cls === "B" && <p class="notice notice-soft">B-mál: titill úr ræðuskrá; engin þingskjöl eða atkvæðagreiðslur fylgja.</p>}
      {m.cls === "A" && !m.detailFetched && <p class="notice notice-soft">Upplýsingar um stöðu máls, skjöl og atkvæðagreiðslur hafa ekki verið sóttar enn.</p>}
      {(m.topics.length > 0 || m.laws.length > 0 || m.links.length > 0 || (x && (x.committees.length > 0 || x.rapporteurs.length > 0))) && (
        <dl class="kv">
          {m.topics.length > 0 && <div><dt>Efnisflokkar</dt><dd class="chips">{m.topics.map((t) => <a class="chip" href={`/efni/${t.id}`}>{t.name}</a>)}</dd></div>}
          {m.laws.length > 0 && <div><dt>Breytir lögum</dt><dd>{m.laws.map((l, i) => <>{i > 0 && ", "}<a href={`/log/${l.year}/${l.nr}`}>lög nr. {l.nr}/{l.year}</a></>)}</dd></div>}
          {x && x.committees.length > 0 && <div><dt>Nefnd</dt><dd>{x.committees.map((c, i) => <>{i > 0 && ", "}<a href={`/nefnd/${c.id}`}>{c.name}</a></>)}</dd></div>}
          {x && x.rapporteurs.length > 0 && <div><dt>Framsögumenn nefndar</dt><dd>{x.rapporteurs.map((r, i) => <>{i > 0 && ", "}<a href={`/thingmadur/${r.memberId}`}>{r.name}</a></>)}</dd></div>}
          {m.links.length > 0 && <div><dt>Tengd mál</dt><dd>{m.links.map((l, i) => <>{i > 0 && ", "}<a href={matterUrl(l.lthing, l.cls, l.nr)}>{l.title ?? `${l.nr}. mál`} ({l.lthing}. þing)</a></>)}</dd></div>}
        </dl>
      )}

      {x && x.timeline.length > 1 && (
        <section id="ferill">
          <h2>Ferill málsins</h2>
          <ol class="srows">
            {x.timeline.map((e) => (
              <li>{e.href
                ? <a class="srow srow-2" href={e.href}><time class="srow-t">{shortDate(e.at)}</time><span class="srow-w">{e.label}</span><span class="srow-k">{e.kind}</span></a>
                : <span class="srow srow-2"><time class="srow-t">{shortDate(e.at)}</time><span class="srow-w">{e.label}</span><span class="srow-k">{e.kind}</span></span>}</li>
            ))}
          </ol>
        </section>
      )}

      {m.documents.length > 0 && (
        <section id="skjol">
          <h2>Þingskjöl <span class="n">{m.documents.length}</span></h2>
          <div class="table-wrap"><table>
            <thead><tr><th class="num">Nr.</th><th>Tegund</th><th>Útbýtt</th><th><span class="sr">Tengill</span></th></tr></thead>
            <tbody>
              {m.documents.map((d) => (
                <tr><td class="num">{d.nr}</td><td>{d.type}</td><td class="mut">{d.issued ? fmtDate(d.issued) : ""}</td><td class="end"><a href={`/thingskjal/${m.lthing}/${d.nr}`}>Skjal</a>{d.htmlUrl && <> · <a href={d.htmlUrl} rel="noopener">althingi.is</a></>}</td></tr>
              ))}
            </tbody>
          </table></div>
        </section>
      )}

      {m.votes.length > 0 && (
        <section id="atkvaedi">
          <h2>Atkvæðagreiðslur <span class="n">{m.votes.length}</span></h2>
          <div class="table-wrap"><table class="votes">
            <thead><tr><th>Tími</th><th>Um hvað</th><th class="num">Já</th><th class="num">Nei</th><th class="num">Hjá</th><th>Niðurstaða</th></tr></thead>
            <tbody>
              {m.votes.map((v) => (
                <tr><td class="mut nowrap"><a href={v.althingiUrl} rel="noopener" title="Atkvæðagreiðslan á vef Alþingis">{v.at ? `${shortDate(v.at)} ${fmtTime(v.at)}` : `nr. ${v.id}`}</a></td><td>{v.kind}</td><td class="num">{v.yes ?? "–"}</td><td class="num">{v.no ?? "–"}</td><td class="num">{v.abstain ?? "–"}</td>
                  <td><span class="vres">{v.result ?? v.method ?? ""}</span><VoteBar yes={v.yes} no={v.no} abstain={v.abstain} /></td></tr>
              ))}
            </tbody>
          </table></div>
          <p class="hint">Tíminn vísar á atkvæðagreiðsluna á vef Alþingis.</p>
        </section>
      )}

      {(m.consultations.length > 0 || m.submissionCount > 0) && (
        <section id="umsagnir">
          <h2>Umsagnir</h2>
          <p class="mut">{m.consultations.length} umsagnabeiðnir{m.consultations[0]?.due ? ` (frestur til ${fmtDate(m.consultations[m.consultations.length - 1]!.due!)})` : ""} · {m.submissionCount} erindi bárust.</p>
          <details><summary>Sýna umsagnabeiðnir</summary>
            <div class="table-wrap"><table><tbody>{m.consultations.map((c) => <tr><td>{c.recipient}</td><td class="mut">{c.committee}</td></tr>)}</tbody></table></div>
          </details>
          {x && x.submissions.length > 0 && (
            <details open={x.submissions.length <= 25}><summary>Erindi sem bárust ({x.submissions.length})</summary>
              <div class="table-wrap"><table><tbody>{x.submissions.map((s) => <tr><td>{s.pdfUrl ? <a href={s.pdfUrl} rel="noopener">{s.sender}</a> : s.sender}</td><td class="mut">{s.kind ?? ""}</td><td class="mut nowrap">{s.received ? shortDate(s.received) : ""}</td></tr>)}</tbody></table></div>
            </details>
          )}
        </section>
      )}

      <section id="raedur">
        <h2>Ræður <span class="n">{m.speechCount}</span></h2>
        {m.speechCount === 0 && <p class="empty">Engar ræður eru í safninu fyrir þetta mál (enn).</p>}
        {[...byStage].map(([stage, list]) => (
          <>
            <h3>{stage}</h3>
            <ol class="srows">
              {list.map((s) => (
                <li><a class="srow" href={speechUrl(s.id)}><time class="srow-t">{shortDate(s.date)} <b>{fmtTime(s.started)}</b></time><span class="srow-w">{s.memberName}</span><span class="srow-k">{s.type}</span><span class="srow-n">{s.words ? `${n(s.words)} orð` : ""}</span></a></li>
              ))}
            </ol>
          </>
        ))}
        {m.speechCount > m.speeches.length && <p class="hint">Sýnir {m.speeches.length} af {m.speechCount} ræðum.</p>}
        {m.speechCount > 0 && (
          <form class="inline-search" action="/leit" method="get" role="search">
            <input type="hidden" name="thing" value={String(m.lthing)} /><input type="hidden" name="mal" value={`${m.cls.toLowerCase()}/${m.nr}`} />
            <input type="search" name="q" placeholder="Leita innan þessa máls…" aria-label="Leita innan málsins" required /><button class="btn" type="submit">Leita</button>
          </form>
        )}
      </section>
    </Layout>
  );
};

// ---------------------------------------------------------------- law, member, party, day, home, about

export const LawPageView = ({ l }: { l: LawPage }) => {
  const { year, nr, law, matters } = l;
  const label = `Lög nr. ${nr}/${year}`;
  return (
    <Layout title={law ? `${law.title} (${label})` : `${label} – mál sem breyttu þeim`} canonical={`/log/${year}/${nr}`}
      jsonld={law ? { "@context": "https://schema.org", "@type": "Legislation", name: law.title, legislationIdentifier: `${nr}/${year}`, url: `${SITE}/log/${year}/${nr}` } : undefined}>
      <header class="page-head">
        <p class="crumbs">Lög{law?.chapter ? ` · ${law.chapter}` : ""}</p>
        <h1>{law?.title ?? label}</h1>
        <dl class="facts">
          {law && <div><dt>Númer</dt><dd>{label}</dd></div>}
          {law?.inForce && <div><dt>Gildi</dt><dd>{law.inForce}</dd></div>}
          {law?.matter && <div><dt>Ferill</dt><dd>{law.matter.title
            ? <a href={matterUrl(law.matter.lthing, "A", law.matter.nr)}>{law.matter.nr}. mál á {law.matter.lthing}. þingi</a>
            : <>{law.matter.nr}. mál á {law.matter.lthing}. þingi</>}</dd></div>}
          {law && <div><dt>Útgáfa</dt><dd>{law.edition}</dd></div>}
          <div><dd><a href={lawUrl(year, nr)} rel="noopener">Á vef Alþingis →</a></dd></div>
        </dl>
      </header>
      <h2>Mál sem breyta lögunum ({matters.length})</h2>
      {matters.length === 0 && <p class="empty">Engin mál í safninu sem breyta þessum lögum (enn).</p>}
      <div class="klist">
        {matters.map((m) => (
          <a class="erow k-mal" href={matterUrl(m.lthing, m.cls, m.nr)}><KindMark k="mal" />
            <span class="erow-b"><span class="erow-t">{m.title}</span><span class="erow-m">{m.nr}. mál á {m.lthing}. þingi{m.status ? ` · ${m.status}` : ""}</span></span></a>
        ))}
      </div>
      {l.amendedBy.length > 0 && <>
        <h2>Breytt með ({l.amendedBy.length})</h2>
        <ul class="plain">
          {l.amendedBy.map((a) => <li><a href={`/log/${a.year}/${a.nr}`}>L. {a.nr}/{a.year}</a>{a.title ? ` · ${a.title}` : ""}{a.effective ? <span class="mut"> ({a.effective})</span> : null}</li>)}
        </ul>
      </>}
      {l.amends.length > 0 && <>
        <h2>Lög sem þessi lög breyttu ({l.amends.length})</h2>
        <ul class="plain">
          {l.amends.map((a) => <li><a href={`/log/${a.year}/${a.nr}`}>L. {a.nr}/{a.year}</a>{a.title ? ` · ${a.title}` : ""}</li>)}
        </ul>
      </>}
      {law && <p class="mut">Úr lagasafni Alþingis, útgáfu {law.edition}. Lagatextinn sjálfur er á vef Alþingis.</p>}
    </Layout>
  );
};

export const MemberPageView = ({ m }: { m: MemberPage }) => {
  const latest = [...m.seats].reverse().find((s) => s.party);
  const sessions = [...new Set(m.seats.map((s) => s.lthing))].sort((a, b) => a - b);
  return (
    <Layout title={`${m.name} – ræður á Alþingi`} canonical={`/thingmadur/${m.id}`}
      jsonld={{ "@context": "https://schema.org", "@type": "Person", name: m.name, ...(m.born ? { birthDate: m.born } : {}) }}>
      <header class="profile" style={pc(latest?.party)}>
        <Avatar name={m.name} party={latest?.party} size="l" />
        <div class="pr-b">
          <h1>{m.name}</h1>
          <p class="who-m">{latest?.party && <Party name={latest.party} />}{latest?.constituency && <> · {latest.constituency}</>}</p>
          <dl class="facts">
            {sessions.length > 0 && <div><dt>Þingseta</dt><dd>{sessions.length === 1 ? `${sessions[0]}. þing` : `${sessions[0]}.–${sessions[sessions.length - 1]}. þing`}</dd></div>}
            <div><dt>Ræður í safni</dt><dd>{n(m.speechCount)}</dd></div>
            {m.born && <div><dt>Fæðingardagur</dt><dd>{fmtDate(m.born)}</dd></div>}
            <div><dd><a href={m.althingiUrl} rel="noopener">Á vef Alþingis →</a></dd></div>
          </dl>
        </div>
      </header>
      <form class="inline-search" action="/leit" method="get" role="search">
        <input type="hidden" name="thm" value={String(m.id)} /><input type="hidden" name="beint" value="1" />
        <input type="search" name="q" placeholder={`Leita í ræðum ${m.name}…`} aria-label="Leita í ræðum þingmannsins" required /><button class="btn" type="submit">Leita</button>
      </form>
      <section id="raedur">
        <h2>Nýjustu ræður</h2>
        {m.recent.length === 0 && <p class="empty">Engar ræður með texta eru í safninu fyrir þennan þingmann (enn).</p>}
        <ol class="srows">
          {m.recent.map((r) => (
            <li><a class="srow srow-2" href={speechUrl(r.id)}>
              <time class="srow-t">{shortDate(r.started)} <b>{fmtTime(r.started)}</b></time>
              <span class="srow-w">{r.matterTitle ?? <span class="mut">Án máls</span>}</span>
              <span class="srow-k">{r.type}</span>
              <span class="srow-n">{r.words ? `${n(r.words)} orð` : ""}</span>
            </a></li>
          ))}
        </ol>
      </section>
      {m.seats.length > 0 && (
        <section>
          <h2>Þingseta</h2>
          <details open={m.seats.length <= 8}>
            <summary>{m.seats.length} tímabil á {sessions.length} {sessions.length === 1 ? "þingi" : "þingum"}</summary>
            <div class="table-wrap"><table>
              <thead><tr><th class="num">Þing</th><th>Staða</th><th>Flokkur</th><th>Kjördæmi</th><th>Tímabil</th></tr></thead>
              <tbody>{[...m.seats].reverse().map((s) => <tr><td class="num">{s.lthing}</td><td>{s.kind}</td><td>{s.party && <Party name={s.party} />}</td><td>{s.constituency}</td><td class="mut nowrap">{s.from ? shortDate(s.from) : ""}{s.to ? ` – ${shortDate(s.to)}` : ""}</td></tr>)}</tbody>
            </table></div>
          </details>
          <p class="hint">„með varamann“ merkir að þingmaður er í leyfi og varamaður situr í hans stað.</p>
        </section>
      )}
    </Layout>
  );
};

export const PartyPageView = ({ p }: { p: PartyPage }) => {
  const sitting = p.members.filter((m) => m.sitting);
  const others = p.members.filter((m) => !m.sitting);
  const max = Math.max(1, ...p.top.map((t) => t.speeches));
  return (
    <Layout title={`${p.name} – þingmenn og ræður`} canonical={`/flokkur/${p.id}`} wide>
      <header class="profile" style={pc(p.name)}>
        <PartyMark name={p.name} size="l" />
        <div class="pr-b">
          <h1>{p.name}</h1>
          <dl class="facts">
            {p.lthing && <div><dt>Þingmenn á {p.lthing}. þingi</dt><dd>{sitting.length}</dd></div>}
            <div><dt>Ræður í safni</dt><dd>{n(p.speechCount)}</dd></div>
          </dl>
        </div>
      </header>
      <p class="hint">Ræður teljast til flokksins sem þingmaðurinn sat fyrir daginn sem ræðan var flutt.</p>
      <div class="cols">
        <section>
          <h2>Þingmenn {p.lthing ? <>á {p.lthing}. þingi</> : null}</h2>
          {sitting.length === 0 && <p class="empty">Enginn þingmaður skráður.</p>}
          <div class="klist">
            {sitting.map((m) => (
              <a class="erow" href={`/thingmadur/${m.id}`}><Avatar name={m.name} party={p.name} />
                <span class="erow-b"><span class="erow-t">{m.name}</span><span class="erow-m">{[m.constituency, m.kind === "með varamann" ? "í leyfi" : null].filter(Boolean).join(" · ")}</span></span>
                <span class="erow-s">{n(m.speeches)} {m.speeches === 1 ? "ræða" : "ræður"}</span></a>
            ))}
          </div>
          {others.length > 0 && (
            <details class="more-d"><summary>Aðrir sem sátu fyrir flokkinn á {p.lthing}. þingi ({others.length})</summary>
              <div class="klist">
                {others.map((m) => (
                  <a class="erow" href={`/thingmadur/${m.id}`}><Avatar name={m.name} party={p.name} />
                    <span class="erow-b"><span class="erow-t">{m.name}</span><span class="erow-m">{[m.kind, m.constituency].filter(Boolean).join(" · ")}</span></span>
                    <span class="erow-s">{n(m.speeches)} {m.speeches === 1 ? "ræða" : "ræður"}</span></a>
                ))}
              </div>
            </details>
          )}
        </section>
        <section>
          <h2>Flestar ræður</h2>
          {p.top.length === 0 && <p class="empty">Engar ræður í safninu (enn).</p>}
          <ol class="bars">
            {p.top.map((t) => (
              <li><a href={`/thingmadur/${t.id}`}><span class="bar-l">{t.name}</span><span class="bar-v">{n(t.speeches)}</span>
                <span class="pbar" style={`${pc(p.name)};width:${((t.speeches / max) * 100).toFixed(1)}%`} aria-hidden="true"></span></a></li>
            ))}
          </ol>
        </section>
      </div>
      <section>
        <h2>Nýjustu ræður</h2>
        <ol class="srows">
          {p.recent.map((r) => (
            <li><a class="srow srow-3" href={speechUrl(r.id)}>
              <time class="srow-t">{shortDate(r.started)} <b>{fmtTime(r.started)}</b></time>
              <span class="srow-w"><b>{r.memberName}</b> <span class="mut">· {r.title ?? "Án máls"}</span></span>
              <span class="srow-k">{r.type}</span>
            </a></li>
          ))}
        </ol>
      </section>
    </Layout>
  );
};

export const DayPageView = ({ d }: { d: DayPage }) => (
  <Layout title={`Ræður ${fmtDate(d.date)}`} canonical={`/dagur/${d.date}`}>
    <header class="page-head">
      <p class="crumbs">Þingdagur</p>
      <h1>{fmtDate(d.date)}</h1>
      <p class="lede">{d.total} ræður{d.total === 0 && " (enginn þingfundur í safninu þennan dag)"}{d.groups.length > 0 && ` í ${d.groups.length} ${d.groups.length === 1 ? "máli" : "málum"}`}</p>
    </header>
    <nav class="pager pager-top" aria-label="Aðrir dagar">
      {d.prev ? <a href={`/dagur/${d.prev}`} rel="prev"><span>{fmtDate(d.prev)}</span></a> : <span />}
      {d.next ? <a href={`/dagur/${d.next}`} rel="next" class="next"><span>{fmtDate(d.next)}</span></a> : <span />}
    </nav>
    {d.groups.map((g) => (
      <section class="day-g">
        <h2>{g.title && g.cls && g.nr !== null ? <a href={matterUrl(g.lthing, g.cls, g.nr)}>{g.title}</a> : "Án máls"} <span class="n">{g.speeches.length}</span></h2>
        <ol class="srows">
          {g.speeches.map((s) => (
            <li><a class="srow" href={speechUrl(s.id)}><time class="srow-t"><b>{fmtTime(s.started)}</b></time><span class="srow-w">{s.memberName}</span><span class="srow-k">{s.type}</span><span class="srow-n">{s.words ? `${n(s.words)} orð` : ""}</span></a></li>
          ))}
        </ol>
      </section>
    ))}
  </Layout>
);

/** A parliament chart: one dot per seat on concentric arcs, filled left to right by party. */
const Hemicycle = ({ parties }: { parties: { id: number; name: string; seats: number }[] }) => {
  const total = parties.reduce((a, p) => a + p.seats, 0);
  if (!total) return null;
  const rows = total > 40 ? 4 : 3;
  const radii = Array.from({ length: rows }, (_, i) => 0.42 + (0.58 * i) / (rows - 1));
  const sum = radii.reduce((a, b) => a + b, 0);
  const counts = radii.map((r) => Math.round((total * r) / sum));
  counts[rows - 1]! += total - counts.reduce((a, b) => a + b, 0);
  const pts: { x: number; y: number; a: number }[] = [];
  radii.forEach((r, i) => {
    const k = counts[i]!;
    for (let j = 0; j < k; j++) { const a = Math.PI * (1 - (k === 1 ? 0.5 : j / (k - 1))); pts.push({ x: r * Math.cos(a), y: -r * Math.sin(a), a }); }
  });
  pts.sort((p, q) => q.a - p.a);
  const seatOf: string[] = parties.flatMap((p) => Array(p.seats).fill(p.name));
  return (
    <svg class="hemi" viewBox="-1.08 -1.08 2.16 1.14" role="img" aria-label={parties.map((p) => `${p.name} ${p.seats}`).join(", ")}>
      {pts.map((p, i) => <circle cx={p.x.toFixed(3)} cy={p.y.toFixed(3)} r="0.058" style={`fill:${partyColor(seatOf[i])}`}><title>{seatOf[i]}</title></circle>)}
      <text x="0" y="-0.06" text-anchor="middle" class="hemi-n">{total}</text>
    </svg>
  );
};
// a rough left-to-right seating order; anything unknown goes to the right
const SPECTRUM = ["Sósíalistaflokkur Íslands", "Vinstrihreyfingin - grænt framboð", "Samfylkingin", "Píratar", "Flokkur fólksins", "Framsóknarflokkur", "Viðreisn", "Sjálfstæðisflokkur", "Miðflokkurinn"];
const spectrum = (name: string) => { const i = SPECTRUM.indexOf(name); return i < 0 ? 99 : i; };

export const HomePage = ({ stats, lthing, parties }: { stats: { speeches: number; from: string | null; to: string | null }; lthing?: number; parties?: { id: number; name: string; seats: number }[] }) => {
  const seated = [...(parties ?? [])].sort((a, b) => spectrum(a.name) - spectrum(b.name));
  return (
    <Layout title="Leit í ræðum Alþingis" desc="Hröð leit í ræðum Alþingis sem finnur allar beygingarmyndir orða." canonical="/">
      <section class="hero">
        <h1>Leit í ræðum Alþingis</h1>
        <p class="lede">Finnur allar beygingarmyndir orðs: „hestinum“ finnur „hestur“. Leitaðu líka að þingmönnum, flokkum, málum og lögum.</p>
        <form class="hero-s" action="/leit" method="get" role="search">
          <input type="search" name="q" placeholder="til dæmis: veiðigjald, „virðulegi forseti“, 300. mál" aria-label="Leita" autofocus required enterkeyhint="search" />
          <button class="btn" type="submit">Leita</button>
        </form>
        <p class="examples"><span class="mut">Prófaðu</span> {["veiðigjald", "\"virðulegi forseti\"", "hælisleitendur", "lög nr. 34/1991", "300. mál"].map((q) => <a class="chip" href={`/leit?q=${encodeURIComponent(q)}`}>{q}</a>)}</p>
      </section>
      <p class="corpus">
        <b>{n(stats.speeches)}</b> ræður með texta{stats.from && stats.to ? <> frá {fmtDate(stats.from)} til {fmtDate(stats.to)}</> : ""}.
        {stats.to && <> <a href={`/dagur/${stats.to}`}>Nýjasti þingdagur</a></>}
      </p>
      {seated.length > 0 && lthing && (
        <section class="house" aria-labelledby="house-h">
          <h2 id="house-h">Þingheimur á {lthing}. þingi</h2>
          <div class="house-in">
            <Hemicycle parties={seated} />
            <ul class="legend">
              {[...seated].sort((a, b) => b.seats - a.seats).map((p) => (
                <li><a href={`/flokkur/${p.id}`}><PartyMark name={p.name} size="s" /><span class="lg-n">{p.name}</span><span class="lg-v">{p.seats}</span></a></li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </Layout>
  );
};

export const AboutPage = () => (
  <Layout title="Um vefinn" canonical="/um">
    <article class="doc">
      <h1>Um vefinn</h1>
      <p class="lede">Leitarvél yfir ræður Alþingis með íslenskri beygingargreiningu (<a href="https://github.com/jokull/lemma-is">lemma-is</a>).</p>
      <p>Gögnin koma úr opinni XML-þjónustu Alþingis; vefurinn sækir hvert skjal einu sinni, með 5 sekúndna millibili og auðkennir sig.</p>
      <h2>Mörk safnsins</h2>
      <p>Ræðutexti er til frá 2005. Eldri ræður (1991–2004) eru aðeins skráðar í ræðuskrá, textinn er ekki sóttur og því ekki leitarbær. Allar „fyrstu“ og „samtals“ tölur eiga við tímabilið frá 2005.</p>
      <h2>Hvað er áætlað</h2>
      <p>Tengsl sem ekki eru gefin upp í gögnunum (til dæmis hvaða ræðu andsvar svarar) eru merkt sem áætluð. Framíköll eru birt en ekki leitarbær.</p>
      <h2 id="ordskyringar">Orðskýringar</h2>
      <dl class="kv gloss">
        {GLOSSARY.map(([is, en, d]) => <div><dt>{is} <span class="mut">· {en}</span></dt><dd>{d}</dd></div>)}
      </dl>
      <h2>Flýtilyklar</h2>
      <p><kbd>/</kbd> fer í leitarreitinn. Í tillögum færa <kbd>↑</kbd> og <kbd>↓</kbd> á milli og <kbd>Enter</kbd> opnar.</p>
      <h2>Persónuvernd</h2>
      <p>Fyrirspurnir og IP-tölur eru ekki sendar til þriðja aðila.</p>
      <p class="hint">Lemmun byggir á Beygingarlýsingu íslensks nútímamáls (BÍN), © Stofnun Árna Magnússonar í íslenskum fræðum, CC BY-SA 4.0, um lemma-is.</p>
    </article>
  </Layout>
);

export const NotFound = ({ what }: { what: string }) => (
  <Layout title="Fannst ekki">
    <div class="doc"><h1>Fannst ekki</h1><p class="lede">{what}</p><p><a class="btn" href="/">Á forsíðu</a></p></div>
  </Layout>
);

// ---------------------------------------------------------------- document, topic, committee, transcript

export const DocPageView = ({ d }: { d: DocPage }) => (
  <Layout title={`Þingskjal ${d.nr} á ${d.lthing}. þingi – ${d.type}`} canonical={`/thingskjal/${d.lthing}/${d.nr}`}>
    <header class="page-head">
      <p class="crumbs">Þingskjal {d.nr} á {d.lthing}. þingi <span class="tag">{d.type}</span></p>
      <h1>{d.matter?.title ?? `Þingskjal ${d.nr}`}</h1>
      <p class="lede">{d.issued ? `Útbýtt ${fmtDate(d.issued)}` : ""}{d.matter && <> · <a href={matterUrl(d.lthing, d.matter.cls, d.matter.nr)}>{d.matter.nr}. mál á {d.lthing}. þingi</a></>}</p>
    </header>
    <p class="notice notice-soft">Texti þingskjala er ekki enn í þessu safni. <a href={d.althingiUrl} rel="noopener">Á vef Alþingis →</a>{d.pdfUrl && <> · <a href={d.pdfUrl} rel="noopener">PDF</a></>}</p>
    {d.votes.length > 0 && (
      <section id="atkvaedi">
        <h2>Atkvæðagreiðslur um skjalið <span class="n">{d.votes.length}</span></h2>
        <div class="table-wrap"><table class="votes">
          <thead><tr><th>Tími</th><th>Um hvað</th><th class="num">Já</th><th class="num">Nei</th><th class="num">Hjá</th><th>Niðurstaða</th></tr></thead>
          <tbody>{d.votes.map((v) => <tr><td class="mut nowrap"><a href={v.althingiUrl} rel="noopener" title="Atkvæðagreiðslan á vef Alþingis">{v.at ? `${shortDate(v.at)} ${fmtTime(v.at)}` : `nr. ${v.id}`}</a></td><td>{v.kind}</td><td class="num">{v.yes ?? "–"}</td><td class="num">{v.no ?? "–"}</td><td class="num">{v.abstain ?? "–"}</td><td>{v.result ?? ""}</td></tr>)}</tbody>
        </table></div>
        <p class="hint">Atkvæði einstakra þingmanna bætast við síðar.</p>
      </section>
    )}
  </Layout>
);

const MatterRows = ({ ms, extra }: { ms: ListedMatter[]; extra?: (m: ListedMatter) => string }) => (
  <div class="klist">
    {ms.map((m) => (
      <a class="erow k-mal" href={matterUrl(m.lthing, m.cls, m.nr)}>
        <span class="erow-b"><span class="erow-t">{m.title}</span>
          <span class="erow-m">{m.nr}. mál á {m.lthing}. þingi{m.type ? ` · ${m.type}` : ""}{m.status ? ` · ${m.status}` : ""}{extra ? extra(m) : ""}</span></span>
      </a>
    ))}
  </div>
);

export const TopicPageView = ({ t }: { t: { id: number; name: string; parent: string | null; description: string | null; matters: ListedMatter[] } }) => {
  const laws = t.matters.filter((m) => /lög frá Alþingi/i.test(m.status ?? ""));
  return (
    <Layout title={`${t.name} – mál í efnisflokknum`} canonical={`/efni/${t.id}`}>
      <header class="page-head">
        <p class="crumbs">Efnisflokkur{t.parent ? ` · ${t.parent}` : ""}</p>
        <h1>{t.name}</h1>
        {t.description && <p class="lede">{t.description}</p>}
        <p class="mut">{t.matters.length} mál{laws.length ? `, þar af ${laws.length} samþykkt sem lög` : ""}.</p>
      </header>
      {t.matters.length === 0 && <p class="empty">Engin mál í safninu í þessum flokki (enn).</p>}
      <MatterRows ms={t.matters} />
    </Layout>
  );
};

export const CommitteePageView = ({ c, today }: { c: { id: number; name: string; matters: CommitteeMatter[] }; today: string }) => {
  const open = c.matters.filter((m) => m.due && m.due >= today);
  const rest = c.matters.filter((m) => !(m.due && m.due >= today));
  const ex = (m: ListedMatter) => { const x = m as CommitteeMatter; return `${x.due ? ` · frestur ${fmtDate(x.due)}` : ""} · ${x.requests} beiðnir · ${x.submissions} erindi`; };
  return (
    <Layout title={`${c.name} – umsagnir og frestir`} canonical={`/nefnd/${c.id}`}>
      <header class="page-head">
        <p class="crumbs">Fastanefnd</p>
        <h1>{c.name}</h1>
        <p class="mut">{c.matters.length} mál með umsagnabeiðnum eða erindum.</p>
      </header>
      <section>
        <h2>Opnir umsagnafrestir <span class="n">{open.length}</span></h2>
        {open.length === 0 && <p class="empty">Enginn umsagnafrestur er opinn í gögnunum sem eru komin inn.</p>}
        <MatterRows ms={open} extra={ex} />
      </section>
      {rest.length > 0 && <section><h2>Eldri mál <span class="n">{rest.length}</span></h2><MatterRows ms={rest} extra={ex} /></section>}
    </Layout>
  );
};

export const TranscriptView = ({ m, speeches }: { m: MatterPage; speeches: TranscriptSpeech[] }) => {
  let stage = "";
  return (
    <Layout title={`Umræðan um ${m.nr}. mál – ${m.title}`} canonical={`${matterUrl(m.lthing, m.cls, m.nr)}/umraeda`}>
      <article class="speech transcript">
        <header class="page-head">
          <p class="crumbs"><a href={matterUrl(m.lthing, m.cls, m.nr)}>{m.nr}. mál á {m.lthing}. þingi</a></p>
          <h1>{m.title}</h1>
          <p class="lede">Öll umræðan í tímaröð: {speeches.length} ræður{m.speechCount > speeches.length ? ` af ${m.speechCount}` : ""}. Prentvænt; framíköll eru ekki með.</p>
        </header>
        {speeches.map((s) => {
          const st = debateLabel(s.debate) ?? "Aðrar ræður";
          const head = st !== stage ? (stage = st, <h2>{st}</h2>) : null;
          return (
            <>
              {head}
              <section class="tr-sp" id={s.id}>
                <h3><a href={speechUrl(s.id)}>{s.memberName}</a>{s.party ? ` (${s.party})` : ""} <span class="mut">· {s.type} · {fmtDateTime(s.started)}</span></h3>
                <div class="prose">{s.paragraphs.map((p) => <p>{p}</p>)}</div>
              </section>
            </>
          );
        })}
      </article>
    </Layout>
  );
};

/** "hvað er andsvar", "hvað þýðir nál." -> the glossary entry, if one matches */
export function glossaryHit(q: string): [string, string, string] | null {
  const m = q.trim().toLocaleLowerCase("is").match(/^(?:hvað|hvaða)\s+(?:er|eru|þýðir|þýða|merkir|merkja|táknar)\s+(?:að\s+)?(?:„|")?(.+?)(?:“|")?\??$/);
  if (!m) return null;
  const w = m[1]!.replace(/[?.]+$/, "");
  return GLOSSARY.find(([is]) => is.toLocaleLowerCase("is").split(/[ ,()/]+/).some((x) => x && x.replace(/\.$/, "") === w.replace(/\.$/, "")) || is.toLocaleLowerCase("is").startsWith(w)) ?? null;
}

/** One-paragraph glossary of the terms every result page uses (persona P10: a teacher and voter). */
export const GLOSSARY: [string, string, string][] = [
  ["ræða", "speech", "Ræða þingmanns eða ráðherra í umræðu um mál."],
  ["andsvar", "reply", "Stutt svar (allt að 2 mín.) við ræðu annars þingmanns, strax á eftir henni; ræðumaður má svara aftur."],
  ["flutningsræða", "opening speech", "Fyrsta ræða um mál, flutt af þeim sem leggur það fram (ráðherra eða flutningsmanni)."],
  ["um fundarstjórn forseta", "point of order", "Athugasemd við stjórn fundarins, ekki um efni málsins."],
  ["1., 2. og 3. umræða", "first/second/third reading", "Frumvarp er rætt þrisvar: 1. umræða um meginefni, síðan fer það til nefndar; 2. umræða um nefndarálit og breytingartillögur; 3. umræða og lokaatkvæðagreiðsla."],
  ["þingmál (mál)", "matter / item of business", "Allt sem þingið fjallar um: frumvörp, tillögur, fyrirspurnir. A-mál eru þingmál; B-mál eru dagskrárliðir eins og störf þingsins."],
  ["frv. (frumvarp)", "bill", "Tillaga að nýjum lögum eða lagabreytingu."],
  ["þáltill. (þingsályktunartillaga)", "parliamentary resolution (draft)", "Tillaga um ályktun Alþingis, ekki lög."],
  ["þskj. (þingskjal)", "parliamentary document", "Hvert skjal í máli fær númer: frumvarp, nefndarálit, breytingartillaga, svar."],
  ["nál. (nefndarálit)", "committee report", "Álit nefndar á máli eftir umfjöllun; meiri- og minnihluti skila oft hvor sínu."],
  ["brtt. (breytingartillaga)", "amendment", "Tillaga um breytingu á frumvarpi eða tillögu."],
  ["fsp. (fyrirspurn)", "parliamentary question", "Spurning þingmanns til ráðherra, svarað munnlega í þingsal eða skriflega."],
  ["umsögn / erindi", "submission", "Álit sem nefnd berst frá stofnunum, félögum og almenningi um mál."],
  ["varamaður", "substitute member", "Tekur sæti þingmanns sem er í leyfi („með varamann“)."],
];

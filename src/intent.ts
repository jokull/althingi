// Query understanding for the search box: people type questions ("Hvað sagði Kristrún Frostadóttir um Landspítala í
// vikunni?"), not filter URLs. This turns the parts of a query that are really FILTERS — a member, a party, a minister's
// title, a speech type, a debate stage, a matter number, a relative date, a sort order — into the URL parameters the
// search already supports, and leaves the rest as the text query. Pure (no DB): the web layer passes the member and party
// lists. Every interpretation is shown to the user with a one-click "leita orðrétt" escape hatch (ordrett=1).

export interface NamedId { id: number; name: string }

export interface Intent {
  /** the text that is still searched as words */
  q: string;
  memberId?: number; memberName?: string;
  partyId?: number; partyName?: string;
  dateFrom?: string; dateTo?: string; dateLabel?: string;
  sort?: "newest" | "oldest";
  type?: string;
  office?: string; officeLabel?: string;
  capacity?: string;
  debate?: string;
  matter?: { lthing: number; cls: string; nr: number };
  /** the query only asks about a matter's section: go to the matter page (anchor, "" = top) */
  matterSection?: string;
  /** words removed as question filler ("hvað sagði") */
  dropped: string[];
  /** anything at all was interpreted */
  changed: boolean;
}

interface Tok { raw: string; w: string; used: boolean; phrase?: boolean }

const MONTHS = ["janúar", "febrúar", "mars", "apríl", "maí", "júní", "júlí", "ágúst", "september", "október", "nóvember", "desember"];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));
const monday = (d: Date) => addDays(d, -((d.getUTCDay() + 6) % 7));
const short = (s: string) => { const [y, m, d] = s.split("-").map(Number); return `${d}. ${MONTHS[m! - 1]!.slice(0, 3)}${y !== new Date().getUTCFullYear() ? ` ${y}` : ""}`; };

/** Inflection-tolerant word match: shared prefix long enough for the shorter word (Kristrúnar ~ Kristrún, Miðflokksins ~ Miðflokkurinn). */
export function sameWord(a: string, b: string): boolean {
  a = a.toLocaleLowerCase("is"); b = b.toLocaleLowerCase("is");
  if (a === b) return true;
  // a typed initial matches a name part ("Steingrímur J." ~ Jóhann); never the reverse ("Dagur barnsins" is not Dagur B.)
  if (/^\p{L}\.$/u.test(a)) return b.startsWith(a[0]!);
  if (/^\p{L}\.$/u.test(b)) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const min = Math.min(a.length, b.length);
  return i >= 3 && i >= min - 4 && i >= Math.ceil(min * 0.6);
}

// ministers' titles -> the portfolio abbreviation in the speech files (prefix match on speeches.office)
const OFFICES: [RegExp, string, string][] = [
  [/^forsætisráðherr/, "forsrh.", "forsætisráðherra"],
  [/^dómsmálaráðherr/, "dómsmrh.", "dómsmálaráðherra"],
  [/^utanríkisráðherr/, "utanrrh.", "utanríkisráðherra"],
  [/^innviðaráðherr/, "innvrh.", "innviðaráðherra"],
  [/^innanríkisráðherr/, "innanrrh.", "innanríkisráðherra"],
  [/^(umhverfis|loftslags|umhverfis-?\s*orku-?\s*og\s*loftslags)ráðherr/, "umhv.", "umhverfisráðherra"],
  [/^atvinnuvegaráðherr/, "atvvrh.", "atvinnuvegaráðherra"],
  [/^heilbrigðisráðherr/, "heilbrrh.", "heilbrigðisráðherra"],
  [/^menningar(mála)?ráðherr/, "mennrh.", "menningarráðherra"],
  [/^(menntamála|barnamála|mennta)ráðherr/, "mennta", "mennta- og barnamálaráðherra"],
  [/^(félagsmála|húsnæðismála|félags)ráðherr/, "fél.", "félags- og húsnæðismálaráðherra"],
  [/^fjármálaráðherr/, "fjmrh.", "fjármálaráðherra"],
  [/^samstarfsráðherr/, "samstrh.", "samstarfsráðherra"],
];
const GENERIC_MINISTER = /^ráðherr(a|ann|anum|ans|ar|arnir|ana|unum|um)$/;

const TYPES: [RegExp, string][] = [
  [/^andsv(ar|ari|ars|ör|örum|örin|örunum|arið|arinu)$/, "andsvar"],
  [/^(flutnings|framsögu)ræð/, "flutningsræða"],
  [/^fundarstjórn/, "um fundarstjórn"],
];

// words that only ask about a matter's page section
const SECTION: [RegExp, string][] = [
  [/^(umsagn|umsögn|erind|umsagnabeiðn)/, "umsagnir"],
  [/^(atkvæð|studd|styð|felld|kaus|kusu|greidd|greidd)/, "atkvaedi"],
  [/^(þingskj|skjöl|skjal|nefndarálit)/, "skjol"],
  [/^(staða|stöðu|statt|stendur|nefnd|ferill|feril)/, ""],
];
const FILLER_WORDS = new Set(["hvað", "hver", "hverjir", "hverjar", "hvaða", "hvernig", "hvar", "hvenær", "er", "var", "um", "í", "á", "frá", "og", "við", "þegar", "sem"]);
const SAY = /^(sagði|sögðu|segir|segja|sagt|talaði|töluðu|nefndi|nefndu|ræddi|ræddu|fjallaði|fjölluðu)$/;
const DEBATE_WORDS = /^(umræð|ræður$|ræðum$|ræðurnar$)/;

export interface IntentCtx { members: NamedId[]; parties: NamedId[]; today: Date; currentLthing: number }

export function interpret(raw: string, ctx: IntentCtx): Intent {
  const out: Intent = { q: raw, dropped: [], changed: false };
  // tokens; quoted phrases stay whole and are never interpreted
  const toks: Tok[] = [];
  for (const m of raw.matchAll(/"[^"]*"|„[^“”]*[“”]|\S+/g)) {
    const r = m[0];
    if (/^["„]/.test(r)) { toks.push({ raw: r, w: r, used: false, phrase: true }); continue; }
    let w = r.toLocaleLowerCase("is").replace(/^[(„"'“]+|[)?!,;:"'“”]+$/g, "");
    if (!/^\d{1,4}\.$/.test(w) && !/^\p{L}\.$/u.test(w) && !/^(þskj|nr|gr|lþ|hv|þm)\.$/.test(w)) w = w.replace(/\.+$/, "");
    if (w) toks.push({ raw: r, w, used: false });
  }
  const free = () => toks.filter((t) => !t.used && !t.phrase);
  /** find a run of unused, non-phrase tokens matching each test in order */
  const seq = (...tests: ((w: string) => boolean)[]): number => {
    for (let i = 0; i + tests.length <= toks.length; i++) {
      if (tests.every((f, k) => !toks[i + k]!.used && !toks[i + k]!.phrase && f(toks[i + k]!.w))) return i;
    }
    return -1;
  };
  const is = (...ws: string[]) => (w: string) => ws.includes(w);
  const re = (r: RegExp) => (w: string) => r.test(w);
  const use = (i: number, n: number) => { for (let k = i; k < i + n; k++) toks[k]!.used = true; };
  const signals: string[] = [];

  // ---- dates (relative to today; the empty state explains when the corpus has not reached that date yet)
  const today = ctx.today;
  const setRange = (a: Date, b: Date, label: string) => { out.dateFrom = iso(a); out.dateTo = iso(b); out.dateLabel = label; signals.push("date"); };
  let i: number;
  if ((i = seq(is("í"), is("dag"))) >= 0) { use(i, 2); setRange(today, today, "í dag"); }
  else if ((i = seq(is("í"), is("gær"))) >= 0) { use(i, 2); const y = addDays(today, -1); setRange(y, y, "í gær"); }
  else if ((i = seq(re(/^gærdag/))) >= 0) { use(i, 1); const y = addDays(today, -1); setRange(y, y, "í gær"); }
  else if ((i = seq(is("í", "á"), is("síðustu", "seinustu", "liðinni"), is("viku"))) >= 0 || (i = seq(is("síðustu", "seinustu", "liðinni"), is("viku"))) >= 0) {
    const n = toks[i]!.w === "í" || toks[i]!.w === "á" ? 3 : 2; use(i, n);
    const m = monday(today); setRange(addDays(m, -7), addDays(m, -1), "í síðustu viku");
  } else if ((i = seq(is("í"), is("þessari"), is("viku"))) >= 0 || (i = seq(is("í"), is("vikunni"))) >= 0 || (i = seq(is("þessa", "þessari"), is("viku"))) >= 0) {
    use(i, toks[i]!.w === "í" && toks[i + 1]!.w === "þessari" ? 3 : 2); setRange(monday(today), today, "í þessari viku");
  } else if ((i = seq(is("síðustu", "seinustu"), re(/^\d{1,3}$/), re(/^(daga|dögum|dagana|dögunum)$/))) >= 0) {
    const n = Number(toks[i + 1]!.w); use(i, 3); if (i > 0 && toks[i - 1]!.w === "á" && !toks[i - 1]!.used) toks[i - 1]!.used = true;
    setRange(addDays(today, -n), today, `síðustu ${n} daga`);
  } else if ((i = seq(is("í"), re(/^(mánuðinum|þessum)$/))) >= 0) {
    use(i, toks[i + 1]!.w === "þessum" && toks[i + 2]?.w === "mánuði" ? 3 : 2);
    setRange(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)), today, "í þessum mánuði");
  } else if ((i = seq(is("í", "á"), is("síðasta"), re(/^mánuð/))) >= 0 || (i = seq(is("síðasta"), re(/^mánuð/))) >= 0) {
    use(i, toks[i]!.w === "síðasta" ? 2 : 3);
    const a = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    setRange(a, new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0)), "í síðasta mánuði");
  } else if ((i = seq(re(new RegExp(`^(${MONTHS.join("|")})$`)), re(/^(19|20)\d{2}$/))) >= 0) {
    const m = MONTHS.indexOf(toks[i]!.w), y = Number(toks[i + 1]!.w); use(i, 2);
    if (i > 0 && toks[i - 1]!.w === "í" && !toks[i - 1]!.used) toks[i - 1]!.used = true;
    setRange(new Date(Date.UTC(y, m, 1)), new Date(Date.UTC(y, m + 1, 0)), `${MONTHS[m]} ${y}`);
  } else if ((i = seq(re(/^(árið|árinu)$/), re(/^(19|20)\d{2}$/))) >= 0) {
    const y = Number(toks[i + 1]!.w); use(i, 2);
    if (i > 0 && toks[i - 1]!.w === "á" && !toks[i - 1]!.used) toks[i - 1]!.used = true;
    setRange(new Date(Date.UTC(y, 0, 1)), new Date(Date.UTC(y, 11, 31)), `árið ${y}`);
  } else if ((i = seq(re(/^(19|20)\d{2}[–-](19|20)\d{2}$/))) >= 0) {
    const [a, b] = toks[i]!.w.split(/[–-]/).map(Number); use(i, 1);
    setRange(new Date(Date.UTC(a!, 0, 1)), new Date(Date.UTC(b!, 11, 31)), `${a}–${b}`);
  } else if ((i = seq(is("frá", "síðan"), re(/^(19|20)\d{2}$/))) >= 0) {
    const y = Number(toks[i + 1]!.w); use(i, 2);
    out.dateFrom = `${y}-01-01`; out.dateLabel = `frá ${y}`; signals.push("date");
  }
  if (out.dateFrom && out.dateTo && out.dateFrom !== out.dateTo && !/^\d|árið|–/.test(out.dateLabel ?? "")) out.dateLabel += ` (${short(out.dateFrom)}–${short(out.dateTo)})`;

  // ---- sort
  if ((i = seq(re(/^(nýjast|nýjustu)$/), is("fyrst"))) >= 0) { use(i, 2); out.sort = "newest"; }
  else if ((i = seq(re(/^(nýjast|nýjustu)$/))) >= 0) { use(i, 1); out.sort = "newest"; }
  else if ((i = seq(re(/^(elst|elstu)$/), is("fyrst"))) >= 0) { use(i, 2); out.sort = "oldest"; }
  else if ((i = seq(re(SAY), is("fyrst"))) >= 0 || (i = seq(is("fyrst"), re(SAY))) >= 0) { toks[toks[i]!.w === "fyrst" ? i : i + 1]!.used = true; out.sort = "oldest"; }
  if (out.sort) signals.push("sort");

  // ---- question filler: "hvað sagði", "hver nefndi", "þingmaðurinn minn"
  while ((i = seq(re(/^(hvað|hver|hverjir|hverjar|hvernig|hvenær|hvar)$/), re(SAY))) >= 0) { out.dropped.push(`${toks[i]!.raw} ${toks[i + 1]!.raw}`); use(i, 2); }
  if ((i = seq(re(SAY))) >= 0 && toks.length > 2) { out.dropped.push(toks[i]!.raw); use(i, 1); }
  if ((i = seq(re(/^þingm(aðurinn|ennirnir|enn)$/), is("minn", "okkar", "mínir"))) >= 0) { out.dropped.push(`${toks[i]!.raw} ${toks[i + 1]!.raw}`); use(i, 2); }
  if (out.dropped.length) signals.push("filler");

  // ---- matter: "300. mál", "300. máls", "300. mál á 157. þingi", "157. þing 300. mál"
  if ((i = seq(re(/^\d{1,4}\.$/), re(/^mál(s|i|ið|sins|inu)?$/))) >= 0) {
    let lthing = ctx.currentLthing;
    const nr = parseInt(toks[i]!.w, 10);
    use(i, 2);
    const after = seq(is("á"), re(/^\d{1,3}\.$/), re(/^(þingi|þing|löggjafarþingi|lþ\.)$/));
    if (after === i + 2) { lthing = parseInt(toks[after + 1]!.w, 10); use(after, 3); }
    else if (i >= 2 && /^\d{1,3}\.$/.test(toks[i - 2]!.w) && /^(þingi|þing|lþ\.)$/.test(toks[i - 1]!.w)) { lthing = parseInt(toks[i - 2]!.w, 10); toks[i - 2]!.used = toks[i - 1]!.used = true; }
    out.matter = { lthing, cls: "A", nr };
    signals.push("matter");
  }

  // ---- debate stage: "1. umræða", "við 2. umræðu"
  if ((i = seq(re(/^[123]\.$/), re(/^umræð/))) >= 0) { out.debate = toks[i]!.w[0]; use(i, 2); signals.push("debate"); }

  // ---- minister's title / speaker capacity
  for (const t of free()) {
    const o = OFFICES.find(([r]) => r.test(t.w));
    if (o) { out.office = o[1]; out.officeLabel = o[2]; t.used = true; signals.push("office"); break; }
  }
  // "félags- og húsnæðismálaráðherra": the dangling first half
  if (out.office) for (let k = 0; k + 1 < toks.length; k++) if (!toks[k]!.used && /-$/.test(toks[k]!.w) && toks[k + 1]!.w === "og") { toks[k]!.used = toks[k + 1]!.used = true; }
  if (!out.office) for (const t of free()) if (GENERIC_MINISTER.test(t.w)) { out.capacity = "ráðherra"; t.used = true; signals.push("capacity"); break; }

  // ---- speech type words (only meaningful next to something else: "hvað er andsvar" stays a word search)
  const typeHits: [Tok, string][] = [];
  for (const t of free()) { const ty = TYPES.find(([r]) => r.test(t.w)); if (ty) typeHits.push([t, ty[1]]); }
  if (typeHits.length === 1) { const [t, ty] = typeHits[0]!; const k = toks.indexOf(t); if (k > 0 && toks[k - 1]!.w === "um" && ty === "um fundarstjórn") toks[k - 1]!.used = true; if (k + 1 < toks.length && toks[k + 1]!.w === "forseta" && ty === "um fundarstjórn") toks[k + 1]!.used = true; t.used = true; out.type = ty; }

  // ---- member: two or more consecutive words matching a member's name (first name + another name part)
  const words = toks.map((t) => (t.used || t.phrase ? "" : t.w));
  let best: { m: NamedId; i: number; n: number } | null = null;
  let ambiguous = false;
  for (const m of ctx.members) {
    const nw = m.name.split(/\s+/);
    for (let s = 0; s < words.length; s++) {
      if (!words[s] || !sameWord(words[s]!, nw[0]!)) continue;
      let n = 1, j = 1;
      while (s + n < words.length && words[s + n] && j < nw.length) {
        const k = nw.findIndex((x, idx) => idx >= j && sameWord(words[s + n]!, x));
        if (k < 0) break;
        j = k + 1; n++;
      }
      if (n < 2) continue;
      if (!best || n > best.n) { best = { m, i: s, n }; ambiguous = false; }
      else if (n === best.n && best.m.id !== m.id && best.i === s) ambiguous = true;
    }
  }
  if (best && !ambiguous) {
    // "forsætisráðherra í andsvari við Sigmund Davíð": with a speaker title, the named member is who was ADDRESSED,
    // so the name stays in the text query instead of becoming the speaker filter.
    if (!out.office && !out.capacity) { out.memberId = best.m.id; out.memberName = best.m.name; use(best.i, best.n); signals.push("member"); }
  }

  // ---- party: all words of the party name, inflected ("Flokks fólksins", "Samfylkingarinnar", "Miðflokksins")
  for (const p of ctx.parties) {
    if (/^utan /.test(p.name)) continue;
    const pw = p.name.split(/\s+/).filter((x) => x !== "-");
    const w2 = toks.map((t) => (t.used || t.phrase ? "" : t.w));
    for (let s = 0; s + pw.length <= w2.length; s++) {
      if (!pw.every((x, k) => w2[s + k] && sameWord(w2[s + k]!, x) && w2[s + k]!.length >= Math.min(4, x.length))) continue;
      // a single-word party name that is also a common noun only counts when capitalised (Viðreisn vs viðreisn)
      if (pw.length === 1 && p.name === "Viðreisn" && !/^\p{Lu}/u.test(toks[s]!.raw)) continue;
      out.partyId = p.id; out.partyName = p.name; use(s, pw.length); signals.push("party");
      break;
    }
    if (out.partyId) break;
  }

  // ---- what is left
  const rest = toks.filter((t) => !t.used);
  const content = rest.filter((t) => t.phrase || !FILLER_WORDS.has(t.w));
  // a matter question whose remaining words only name a section of the matter page -> go there
  if (out.matter) {
    const secs = content.filter((t) => !t.phrase).map((t) => SECTION.find(([r]) => r.test(t.w))?.[1]);
    if (content.every((t) => !t.phrase) && secs.every((x) => x !== undefined) && !out.memberId && !out.dateFrom && !out.type && !out.debate && !out.capacity && !out.office) {
      out.matterSection = secs.find((x) => x) ?? (content.length ? "" : "");
      out.changed = true;
      out.q = "";
      return out;
    }
  }
  // "umræða"/"ræður" carry no topic once something else is there
  let kept = content.filter((t) => t.phrase || !DEBATE_WORDS.test(t.w) || content.length === 1);
  if (kept.length < content.length) out.dropped.push(...content.filter((t) => !kept.includes(t)).map((t) => t.raw));
  // A lone party or member name stays as it was (entity card / member page); a type word needs company ("hvað er
  // andsvar" is a word search); filler or a sort word alone with nothing left to search is no query at all.
  const unchanged = { q: raw, dropped: [], changed: false };
  const filters = signals.filter((s) => s !== "filler" && s !== "sort");
  if (!filters.length && !out.sort && !out.dropped.length && !kept.length) return unchanged;
  if (!filters.length && !out.sort && !out.dropped.length) { if (!out.type) return unchanged; if (kept.length === 0) return unchanged; }
  if (!kept.length) {
    if (!filters.length) return unchanged;
    if (filters.length === 1 && filters[0] === "party") return unchanged;
    if (filters.length === 1 && filters[0] === "member" && !out.type && !out.sort) return unchanged;
  }
  out.q = kept.map((t) => t.raw.replace(/[?!]+$/, "")).join(" ").trim();
  out.changed = true;
  return out;
}

/** Plain-language list of what was interpreted, for the note above the results. */
export function describeIntent(it: Intent): string[] {
  const s: string[] = [];
  if (it.memberName) s.push(`ræður ${it.memberName}`);
  if (it.officeLabel) s.push(`ræðumaður: ${it.officeLabel}`);
  if (it.capacity) s.push(`ræðumaður: ${it.capacity}`);
  if (it.partyName) s.push(`flokkur: ${it.partyName}`);
  if (it.type) s.push(`tegund: ${it.type}`);
  if (it.debate) s.push(`${it.debate}. umræða`);
  if (it.matter) s.push(`innan ${it.matter.nr}. máls á ${it.matter.lthing}. þingi`);
  if (it.dateLabel) s.push(it.dateLabel);
  if (it.sort === "newest") s.push("nýjast fyrst");
  if (it.sort === "oldest") s.push("elst fyrst");
  if (it.dropped.length) s.push(`slepptum: ${it.dropped.join(", ")}`);
  return s;
}

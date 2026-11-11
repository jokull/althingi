// The althingi.is page of each entity. Rule (docs/DECISIONS.md "Deep links"): the URL the source XML gives is stored and
// wins; only when it is missing is one constructed, and only from a pattern that URLs in the data confirm. Never fetched.
// Entities with no confirmed page pattern (parties, committees, sitting days) get no link.
const A = "https://www.althingi.is";
/** as served, upgraded to https; a doubled path slash (`althingi.is//thingstorf/…`, seen in thingmalalisti) is collapsed */
const https = (u: string | null | undefined) => (u ? u.trim().replace(/^http:\/\//, "https://").replace(/([^:])\/{2,}/g, "$1/") : null);

/** speech lists <html>; pattern confirmed by 2,501 such links in fixtures: /altext/raeda/<lthing>/<id>.html */
export const speechPageUrl = (lthing: number, id: string, stored?: string | null) =>
  https(stored) ?? (/^rad\d{8}T\d{6}$/.test(id) ? `${A}/altext/raeda/${lthing}/${id}.html` : null);

/** thingmalalisti <html>; patterns confirmed there and in vote lists / lagasafn: ferill (A) and bferill (B) */
export const matterPageUrl = (lthing: number, cls: string, nr: number, stored?: string | null) =>
  https(stored) ?? `${A}/thingstorf/thingmalalistar-eftir-thingum/${cls.toUpperCase() === "B" ? "bferill" : "ferill"}/?ltg=${lthing}&mnr=${nr}`;

/** thingmenn <html><lífshlaup>; confirmed: /altext/cv/?nfaerslunr=<member id> */
export const memberPageUrl = (id: number, stored?: string | null) => https(stored) ?? `${A}/altext/cv/?nfaerslunr=${id}`;

/** atkvaedagreidslur <nánar><html>; confirmed: /dba-bin/atkvgr.pl?nnafnak=<vote id> */
export const votePageUrl = (id: number, stored?: string | null) => https(stored) ?? `${A}/dba-bin/atkvgr.pl?nnafnak=${id}`;

/** thingskjol / matter detail <slóð><html>; confirmed: /altext/<lthing>/s/<nnnn>.html */
export const documentPageUrl = (lthing: number, nr: number, stored?: string | null) =>
  https(stored) ?? `${A}/altext/${lthing}/s/${String(nr).padStart(4, "0")}.html`;

/** current law collection page; constructed (/lagas/nuna/<YYYYNNN>.html: owner-specified, used by this site before 0006) */
export const lawPageUrl = (year: number, nr: number) => `${A}/lagas/nuna/${year}${String(nr).padStart(3, "0")}.html`;

/** submissions (erindi): their PDF as served (<slóð><pdf>); nothing constructed */
export const submissionUrl = (stored?: string | null) => https(stored);

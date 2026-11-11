// Polite fetcher for the Alþingi XML service.
// - one request in flight, >= 5 s between the end of one request and the start of the next (robots.txt Crawl-delay: 5)
// - descriptive User-Agent with contact address (llms.txt asks for this)
// - URL allowlist: ONLY the XML service. HTML/.sgml/.pdf under /altext/ sit behind a bot challenge and the
//   operator asks automated clients not to scrape HTML, so they are unreachable from here by construction.
// - 403 or an HTML body = we are being challenged: stop, never retry, never work around.
export const USER_AGENT = process.env.CRAWL_UA ?? "althingi-search/0.1 (jokull@solberg.is)";

const HOST = "www.althingi.is";
const ALLOWED_PATHS: RegExp[] = [
  /^\/altext\/xml\//, // service endpoints (lists, members, matters, votes…)
  /^\/xml\/\d+\/raedur\/rad\d{8}T\d{6}\.xml$/, // speech text files linked from the speech lists
];
/** Binary downloads: exactly one path, the current law collection (invited by llms.txt). Nothing else, ever. */
const BINARY_PATHS: RegExp[] = [/^\/lagasafn\/zip\/nuna\/allt\.zip$/];

export class Blocked extends Error {
  constructor(msg: string) { super(msg); this.name = "Blocked"; }
}
export class RateLimited extends Error {
  constructor(msg: string) { super(msg); this.name = "RateLimited"; }
}

/** Normalise to https://www.althingi.is/… and refuse anything outside the allowlist (`binary`: the zip allowlist). */
export function normalizeUrl(raw: string, kind: "xml" | "binary" = "xml"): string {
  const u = new URL(raw.trim());
  if (u.hostname !== "althingi.is" && u.hostname !== HOST) throw new Error(`host not allowed: ${u.hostname}`);
  const allowed = kind === "binary" ? BINARY_PATHS : ALLOWED_PATHS;
  if (!allowed.some((re) => re.test(u.pathname))) throw new Error(`path not allowed: ${u.pathname}`);
  if (kind === "binary" && u.search) throw new Error("query string not allowed on a binary download");
  u.protocol = "https:";
  u.hostname = HOST;
  u.port = "";
  u.hash = "";
  return u.toString();
}

export interface FetchResult {
  url: string; status: number; body: string; bytes: number;
  /** response headers (lower-case names); recorded in raw_fetch.headers */
  headers: Record<string, string>;
}
export interface BinaryResult { url: string; status: number; data: Uint8Array; bytes: number; headers: Record<string, string> }
/** Validators from an earlier response: sent as If-None-Match / If-Modified-Since. A 304 then has no body. */
export interface Validators { etag?: string | null; lastModified?: string | null }

export class Offline extends Error {
  constructor(url: string) { super(`ALTHINGI_OFFLINE is set: refusing to fetch ${url}`); this.name = "Offline"; }
}

export interface FetcherOptions {
  minGapMs?: number;
  /** waits between retries for 429/5xx/network errors; after the last one the error is thrown */
  backoffMs?: number[];
  maxBytes?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

export class Fetcher {
  private lastEnd = 0;
  private readonly o: Required<FetcherOptions>;
  requests = 0;

  constructor(opts: FetcherOptions = {}) {
    this.o = {
      minGapMs: opts.minGapMs ?? 5000,
      backoffMs: opts.backoffMs ?? [60_000, 180_000, 600_000],
      maxBytes: opts.maxBytes ?? 50_000_000,
      fetchImpl: opts.fetchImpl ?? fetch,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      now: opts.now ?? Date.now,
      log: opts.log ?? (() => {}),
    };
  }

  private async pace(): Promise<void> {
    const wait = this.lastEnd + this.o.minGapMs - this.o.now();
    if (wait > 0) await this.o.sleep(wait);
  }

  async get(rawUrl: string, v: Validators = {}): Promise<FetchResult> {
    const url = normalizeUrl(rawUrl);
    const r = await this.request(url, "application/xml, text/xml;q=0.9", v);
    if (r.res.status === 304) return { url, status: 304, body: "", bytes: 0, headers: r.headers };
    const declared = Number(r.res.headers.get("content-length") ?? 0);
    if (declared > this.o.maxBytes) throw new Error(`body too large (${declared}) for ${url}`);
    const body = await r.res.text();
    this.lastEnd = this.o.now();
    if (/^\s*<(!doctype html|html)/i.test(body)) throw new Blocked(`HTML body from ${url} — challenge page; stopping`);
    return { url, status: r.res.status, body, bytes: Buffer.byteLength(body), headers: r.headers };
  }

  /** The lagasafn zip (BINARY_PATHS only). A body that is not a zip (`PK`) is a challenge page: stop. */
  async getBinary(rawUrl: string, v: Validators = {}): Promise<BinaryResult> {
    const url = normalizeUrl(rawUrl, "binary");
    const r = await this.request(url, "application/zip", v);
    if (r.res.status === 304) return { url, status: 304, data: new Uint8Array(), bytes: 0, headers: r.headers };
    const declared = Number(r.res.headers.get("content-length") ?? 0);
    if (declared > this.o.maxBytes) throw new Error(`body too large (${declared}) for ${url}`);
    const data = new Uint8Array(await r.res.arrayBuffer());
    this.lastEnd = this.o.now();
    if (r.res.status === 200 && !(data[0] === 0x50 && data[1] === 0x4b)) throw new Blocked(`non-zip body from ${url} — challenge page; stopping`);
    return { url, status: r.res.status, data, bytes: data.length, headers: r.headers };
  }

  private async request(url: string, accept: string, v: Validators): Promise<{ res: Response; headers: Record<string, string> }> {
    if (process.env.ALTHINGI_OFFLINE) throw new Offline(url);
    const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: accept };
    if (v.etag) headers["If-None-Match"] = v.etag;
    if (v.lastModified) headers["If-Modified-Since"] = v.lastModified;
    for (let attempt = 0; ; attempt++) {
      await this.pace();
      let res: Response | undefined;
      let netErr: unknown;
      try {
        this.requests++;
        res = await this.o.fetchImpl(url, { headers, redirect: "follow", signal: AbortSignal.timeout(90_000) });
      } catch (e) {
        netErr = e;
      }

      if (res && res.status === 403) {
        this.lastEnd = this.o.now();
        throw new Blocked(`403 from ${url} — challenged; stopping (not retrying, not working around)`);
      }
      const retryable = !res || res.status === 429 || res.status >= 500;
      if (retryable) {
        this.lastEnd = this.o.now();
        const why = res ? String(res.status) : `network: ${(netErr as Error).message}`;
        const wait = this.o.backoffMs[attempt];
        if (wait === undefined) {
          if (res?.status === 429) throw new RateLimited(`429 persisted for ${url}`);
          throw new Error(`giving up on ${url}: ${why}`);
        }
        this.o.log(`retry ${attempt + 1} for ${url} (${why}) in ${Math.round(wait / 1000)}s`);
        await this.o.sleep(wait);
        continue;
      }
      if (res!.status === 304) this.lastEnd = this.o.now();
      const h: Record<string, string> = {};
      res!.headers.forEach((value, key) => { h[key.toLowerCase()] = value; });
      return { res: res!, headers: h };
    }
  }
}

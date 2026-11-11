// In-process token bucket per client IP (cf-connecting-ip behind the tunnel). The Cloudflare rule (40 req / 10 s per IP on
// /leit* and /mcp*) is the hard edge limit; this one answers with a 429 + Retry-After that MCP clients can act on.
export interface RateOpts { capacity: number; perSecond: number }

export function rateLimiter({ capacity, perSecond }: RateOpts) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  let swept = Date.now();
  /** null = allowed; otherwise the whole seconds to wait */
  return (key: string, now = Date.now()): number | null => {
    if (now - swept > 60_000) { // forget idle clients (a full bucket is the same as no bucket)
      for (const [k, b] of buckets) if (b.tokens + ((now - b.at) / 1000) * perSecond >= capacity) buckets.delete(k);
      swept = now;
    }
    const b = buckets.get(key) ?? { tokens: capacity, at: now };
    b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * perSecond);
    b.at = now;
    buckets.set(key, b);
    if (b.tokens >= 1) { b.tokens -= 1; return null; }
    return Math.max(1, Math.ceil((1 - b.tokens) / perSecond));
  };
}

export const clientKey = (h: (name: string) => string | undefined): string =>
  h("cf-connecting-ip") ?? h("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";

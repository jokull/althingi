// Small in-process caches (docs/PERFORMANCE.md §3.4). Results are immutable until the next ingest, so every key carries
// the corpus_state version: a version bump on ingest invalidates everything at once, no TTL arithmetic.

/** ALTHINGI_CACHE=0 disables every LRU (benchmarks measure the queries, not the cache). Read per call: order-free. */
const disabled = () => process.env.ALTHINGI_CACHE === "0";

/** Bounded LRU: oldest-inserted entries fall out first; a hit moves the entry to the back. */
export class Lru<V> {
  private m = new Map<string, V>();
  constructor(private max = 500) {}
  get(k: string): V | undefined {
    const v = this.m.get(k);
    if (v !== undefined) { this.m.delete(k); this.m.set(k, v); }
    return v;
  }
  set(k: string, v: V): V {
    if (disabled()) return v;
    if (this.m.has(k)) this.m.delete(k);
    this.m.set(k, v);
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value!);
    return v;
  }
  delete(k: string) { this.m.delete(k); }
  get size() { return this.m.size; }
  clear() { this.m.clear(); }
}

/** Memoize an async producer by (version, params). In-flight calls are shared, so a burst of identical requests runs once. */
export function memo<A extends unknown[], R>(lru: Lru<Promise<R>>, keyOf: (...a: A) => string, fn: (...a: A) => Promise<R>): (...a: A) => Promise<R> {
  return (...a: A) => {
    const k = keyOf(...a);
    const hit = lru.get(k);
    if (hit) return hit;
    const p = fn(...a);
    lru.set(k, p);
    p.catch(() => { if (lru.get(k) === p) lru.delete(k); }); // never cache a failure
    return p;
  };
}

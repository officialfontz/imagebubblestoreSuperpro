// ── Fixed-window rate limiting ────────────────────────────────────────────────
// In-memory on purpose. There is one Railway container, so a shared counter
// would mean running Redis to protect against something a single Map already
// handles; a restart clearing the counters is harmless because an attacker
// cannot cause restarts.

type Entry = { count: number; resetAt: number };

/**
 * Returns a `limited(key)` predicate. Each caller gets its own bucket, so the
 * upload limit and the pairing limit cannot exhaust each other.
 */
export function makeLimiter(limit: number, windowMs = 60_000, maxKeys = 5_000) {
  const buckets = new Map<string, Entry>();

  return function limited(key: string): boolean {
    const now = Date.now();
    const entry = buckets.get(key);

    if (!entry || now > entry.resetAt) {
      // Sweep on insert rather than on a timer: no interval to keep alive, and
      // the cost lands on the request that actually grew the map.
      if (buckets.size >= maxKeys) {
        for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
      }
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return false;
    }

    if (entry.count >= limit) return true;
    entry.count++;
    return false;
  };
}

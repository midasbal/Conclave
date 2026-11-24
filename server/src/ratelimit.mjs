// Token-bucket rate limiter keyed by an arbitrary string (the player's pubkey for gated routes, the client address for open ones).
export function createLimiter({ capacity, perMinute, now = () => Date.now() / 1000, maxKeys = 50000 }) {
  const buckets = new Map(); const rate = perMinute / 60;
  return { take(key) { const t = now(); let b = buckets.get(key); if (!b) { if (buckets.size >= maxKeys) { for (const [k, v] of buckets) if (t - v.t > 120) buckets.delete(k); if (buckets.size >= maxKeys) return { ok: false, retryAfter: 60 }; } b = { tokens: capacity, t }; buckets.set(key, b); }
    b.tokens = Math.min(capacity, b.tokens + (t - b.t) * rate); b.t = t; if (b.tokens >= 1) { b.tokens -= 1; return { ok: true }; } return { ok: false, retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / rate)) }; }, size: () => buckets.size };
}

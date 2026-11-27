// Level 2's challenges: issued by this server, answered once, expiring. This store is IN MEMORY, so it is correct for ONE instance only. Run two instances behind a balancer and a challenge issued by one cannot be redeemed at the
// other, and a single use could be spent twice. Before running more than one instance, give this class a shared store (Redis or similar): the interface is three methods, `put`, `take` and `size`, and `take` must be an atomic
// read-and-delete. The same applies to the rate-limit buckets and the session nonce store (server/README.md, Deferred).
export class ChallengeStore {
  constructor({ ttlMs = 10 * 60_000, max = 5000, now = () => Date.now() } = {}) { this.ttlMs = ttlMs; this.max = max; this.now = now; this.items = new Map(); }
  sweep() { const t = this.now(); for (const [k, v] of this.items) if (v.expiresAt <= t) this.items.delete(k); }
  /** false if the store is full of challenges that have not yet expired */
  put(challenge) { this.sweep(); if (this.items.size >= this.max) return false; this.items.set(challenge.nonce, { challenge, expiresAt: this.now() + this.ttlMs }); return true; }
  /** the challenge, removed in the same step: it can be answered once. Unknown, already used and expired are the same answer on purpose */
  take(nonce) { const v = this.items.get(nonce); if (!v) return null; this.items.delete(nonce); return v.expiresAt > this.now() ? v.challenge : null; }
  size() { return this.items.size; }
}

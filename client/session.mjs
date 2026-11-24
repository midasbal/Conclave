// Client side of the wallet-signed session (see server/src/auth.mjs for the protocol). Works in Node and in a browser (fetch + a signMessage function from the wallet).
// The wallet signs a message, not a transaction: no gas, no funds at risk. The token is kept in memory only, sent in an Authorization header, and renewed by signing again when it nears expiry.
import bs58 from "bs58";
export const DOMAIN = "CNCL-AUTH-v1";
/** Refuse to sign anything that is not exactly our protocol's message for THIS pubkey and THIS audience with a sane lifetime: a hostile server must not be able to get an arbitrary signature out of the wallet. */
export function checkChallenge(msg, { pubkey, audience, now = Math.floor(Date.now() / 1000), maxTtl = 600 }) {
  const m = /^CNCL-AUTH-v1\naudience: ([^\n]+)\npubkey: ([1-9A-HJ-NP-Za-km-z]{32,44})\nnonce: ([0-9a-f]{64})\nissued: (\d{1,12})\nexpires: (\d{1,12})$/.exec(msg);
  if (!m) throw new Error("refusing to sign: not a Conclave auth message"); const [, aud, pk, , issued, expires] = m;
  if (audience && aud !== audience) throw new Error("refusing to sign: wrong audience"); if (pk !== pubkey) throw new Error("refusing to sign: message is for another pubkey");
  if (+expires - +issued > maxTtl || +expires <= now - 30 || +issued > now + 30) throw new Error("refusing to sign: unreasonable validity window"); return { audience: aud };
}
export class Session {
  /** signMessage: async (Uint8Array) => 64-byte ed25519 signature (a wallet adapter's signMessage, or nacl.sign.detached in Node) */
  constructor({ baseUrl, pubkey, signMessage, audience, skewSeconds = 30, fetchImpl = fetch, now = () => Math.floor(Date.now() / 1000) }) { Object.assign(this, { baseUrl, pubkey, signMessage, audience, skewSeconds, fetchImpl, now }); this._tok = null; this._exp = 0; this._inflight = null; this.logins = 0; }
  async login() { // one login at a time even when several requests find the token expired together
    if (this._inflight) return this._inflight; this._inflight = (async () => { try {
      const post = async (path, body) => { const r = await this.fetchImpl(this.baseUrl + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.error || `http ${r.status}`), { status: r.status, code: j.error }); return j; };
      const ch = await post("/auth/challenge", { pubkey: this.pubkey }); checkChallenge(ch.message, { pubkey: this.pubkey, audience: this.audience, now: this.now() });
      const sig = await this.signMessage(new TextEncoder().encode(ch.message)); const t = await post("/auth/token", { pubkey: this.pubkey, nonce: ch.nonce, signature: bs58.encode(sig) });
      this._tok = t.token; this._exp = t.expiresAt; this.logins++; return t; } finally { this._inflight = null; } })(); return this._inflight; }
  async token() { if (!this._tok || this._exp - this.now() <= this.skewSeconds) await this.login(); return this._tok; }
  /** fetch a gated path: Authorization header only; on 401 token_expired / token_invalid sign again once and retry */
  async fetch(path, init = {}) { for (let attempt = 0; ; attempt++) { const tok = await this.token(); const r = await this.fetchImpl(this.baseUrl + path, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${tok}` } });
    if (r.status === 401 && attempt === 0) { this._tok = null; continue; } return r; } }
}

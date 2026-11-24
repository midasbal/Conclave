// Wallet-signed, expiring session tokens. No password, no gas, no credential in a URL.
//
//   1. POST /auth/challenge {pubkey}            the server issues a single-use nonce and returns the exact message to sign
//   2. the wallet signs the message bytes (UTF-8) with its ed25519 key (wallet "signMessage": not a transaction, costs nothing)
//   3. POST /auth/token {pubkey, nonce, signature}   the server rebuilds the message from ITS record of the nonce, verifies, burns the nonce, issues a token
//   4. the token goes in `Authorization: Bearer <token>` (or a POST body), never in a URL
//
// The signed message (UTF-8, LF line endings, no trailing newline):
//
//   CNCL-AUTH-v1
//   audience: <audience>
//   pubkey: <base58 player pubkey>
//   nonce: <64 hex chars>
//   issued: <unix seconds>
//   expires: <unix seconds>
//
// The first line is the domain separator: a signature made for any other protocol (or a transaction) cannot be replayed here and this signature is not a valid transaction.
// Audience binds the message to one service, pubkey to one player, nonce to one use, expires to a time limit. The server never trusts client-supplied values for any of them:
// it looks the nonce up and rebuilds the message from what it stored when it issued the challenge.
//
// Session token (stateless, HMAC-SHA256 under a server secret that never leaves the server): v1.<base64url payload>.<base64url mac>
// payload = {v, sub: <pubkey>, aud, iat, exp, jti}. The mac covers a domain tag plus the payload bytes. The token is bound to `sub`: every gated endpoint takes the identity from the token and nowhere else.
import crypto from "node:crypto"; import nacl from "tweetnacl"; import bs58 from "bs58";

export const DOMAIN = "CNCL-AUTH-v1"; export const CHALLENGE_TTL = 120; export const SESSION_TTL = 900; // seconds
export class AuthError extends Error { constructor(code, status = 401) { super(code); this.code = code; this.status = status; } }
export const authMessage = ({ audience, pubkey, nonce, issued, expires }) => `${DOMAIN}\naudience: ${audience}\npubkey: ${pubkey}\nnonce: ${nonce}\nissued: ${issued}\nexpires: ${expires}`;
const b64u = b => Buffer.from(b).toString("base64url");
export function decodePubkey(s) { let b; try { b = bs58.decode(String(s)); } catch { throw new AuthError("bad_pubkey", 400); } if (b.length !== 32) throw new AuthError("bad_pubkey", 400); return b; }
function decodeSig(s) { let b; try { b = bs58.decode(String(s)); } catch { throw new AuthError("bad_signature_encoding", 400); } if (b.length !== 64) throw new AuthError("bad_signature_encoding", 400); return b; }

/** now: () => unix seconds (injectable so expiry can be tested with real signatures and a real clock-free scenario). store: Map-like nonce store (single process; see README for the shared-store deferral). */
export function createAuth({ audience, secret, now = () => Math.floor(Date.now() / 1000), challengeTtl = CHALLENGE_TTL, sessionTtl = SESSION_TTL, maxPending = 20000 }) {
  if (!audience) throw new Error("audience required"); if (!secret || Buffer.byteLength(secret) < 32) throw new Error("secret of at least 32 bytes required");
  const pending = new Map(); // nonce -> {pubkey, issued, expires}
  const gc = () => { const t = now(); for (const [n, r] of pending) if (r.expires <= t) pending.delete(n); };
  const mac = payloadB64 => crypto.createHmac("sha256", secret).update("CNCL-SESSION-v1\n").update(payloadB64).digest();
  return {
    audience, challengeTtl, sessionTtl, pendingCount: () => pending.size,
    issueChallenge(pubkey) {
      decodePubkey(pubkey); gc(); if (pending.size >= maxPending) throw new AuthError("busy", 503);
      const nonce = crypto.randomBytes(32).toString("hex"); const issued = now(); const expires = issued + challengeTtl; pending.set(nonce, { pubkey, issued, expires });
      return { nonce, issued, expires, audience, message: authMessage({ audience, pubkey, nonce, issued, expires }) };
    },
    /** burns the nonce on the FIRST attempt, valid or not: a challenge can be redeemed once, a failed signature needs a fresh challenge */
    redeem({ pubkey, nonce, signature }) {
      const pk = decodePubkey(pubkey); const rec = typeof nonce === "string" ? pending.get(nonce) : undefined; if (!rec) throw new AuthError("nonce_unknown_or_used"); pending.delete(nonce);
      if (rec.pubkey !== pubkey) throw new AuthError("nonce_not_issued_to_this_pubkey"); if (now() >= rec.expires) throw new AuthError("challenge_expired");
      const msg = Buffer.from(authMessage({ audience, pubkey, nonce, issued: rec.issued, expires: rec.expires }), "utf8");
      if (!nacl.sign.detached.verify(msg, decodeSig(signature), pk)) throw new AuthError("invalid_signature");
      const iat = now(); const exp = iat + sessionTtl; const payload = b64u(JSON.stringify({ v: 1, sub: pubkey, aud: audience, iat, exp, jti: crypto.randomBytes(12).toString("hex") }));
      return { token: `v1.${payload}.${b64u(mac(payload))}`, tokenType: "Bearer", issuedAt: iat, expiresAt: exp, ttl: sessionTtl };
    },
    /** returns {pubkey, exp, jti} or throws AuthError(401, "token_expired" | "token_invalid" | "wrong_audience") */
    verifyToken(token) {
      const parts = typeof token === "string" ? token.split(".") : []; if (parts.length !== 3 || parts[0] !== "v1") throw new AuthError("token_invalid");
      const want = mac(parts[1]); let got; try { got = Buffer.from(parts[2], "base64url"); } catch { throw new AuthError("token_invalid"); }
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new AuthError("token_invalid");
      let p; try { p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { throw new AuthError("token_invalid"); }
      if (p.v !== 1 || typeof p.sub !== "string" || typeof p.exp !== "number") throw new AuthError("token_invalid"); if (p.aud !== audience) throw new AuthError("wrong_audience"); if (now() >= p.exp) throw new AuthError("token_expired");
      return { pubkey: p.sub, exp: p.exp, jti: p.jti };
    },
  };
}

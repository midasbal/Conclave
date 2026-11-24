// HTTP front: open routes (public, coarse), the auth routes, and the gated player routes. Credentials only ever arrive in the Authorization header or a POST body.
import http from "node:http"; import bs58 from "bs58"; import { PublicKey } from "@solana/web3.js"; import { AuthError } from "./auth.mjs"; import { createLimiter } from "./ratelimit.mjs"; import { coarseReceipt } from "./receipt.mjs";

const PUBLIC_METHODS = new Set(["getSlot", "getLatestBlockhash", "getAccountInfo", "getMultipleAccounts"]);
const PLAYER_METHODS = new Set([...PUBLIC_METHODS, "getBalance", "getProgramAccounts", "getSignaturesForAddress", "getSignatureStatuses", "getTransaction", "simulateTransaction", "sendTransaction"]);
const CREDENTIAL_PARAMS = /^(token|access_token|id_token|auth|authorization|jwt|session|sig|signature|key|api[-_]?key|apikey|secret|bearer)$/i;
const MAX_BODY = 64 * 1024;

export function createApp({ auth, upstream, programId, origins = [], limits = {}, trustProxy = false, now = () => Date.now() / 1000, log = () => {}, fetchImpl = fetch, upstreamTimeoutMs = 10000 }) {
  if (!upstream) throw new Error("upstream RPC url required (it may contain the provider key; it is only ever used server-side)");
  const L = { auth: limits.auth ?? 20, open: limits.open ?? 60, player: limits.player ?? 120 };
  const lim = { auth: createLimiter({ capacity: L.auth, perMinute: L.auth, now }), open: createLimiter({ capacity: L.open, perMinute: L.open, now }), player: createLimiter({ capacity: L.player, perMinute: L.player, now }) };
  const program = new PublicKey(programId);
  const ok = (res, status, body, extra = {}) => { const s = JSON.stringify(body); res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s), ...extra }); res.end(s); };
  const fail = (res, status, error, extra = {}) => ok(res, status, { error }, extra);
  async function readJson(req) { const chunks = []; let n = 0; for await (const c of req) { n += c.length; if (n > MAX_BODY) throw new AuthError("body_too_large", 413); chunks.push(c); } if (!n) return {}; try { const j = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (j === null || typeof j !== "object" || Array.isArray(j)) throw 0; return j; } catch { throw new AuthError("bad_json", 400); } }
  async function callUpstream(method, params) {
    try { const r = await fetchImpl(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(upstreamTimeoutMs) }); return await r.json(); }
    catch { throw new AuthError("upstream_unavailable", 502); } // the error never names the upstream URL: it may carry the key
  }
  async function proxyRpc(res, body, allowed, extraCheck) {
    if (typeof body.method !== "string" || !allowed.has(body.method)) return fail(res, 403, "method_not_allowed"); const params = Array.isArray(body.params) ? body.params : [];
    if (extraCheck) { const why = extraCheck(body.method, params); if (why) return fail(res, 403, why); } const out = await callUpstream(body.method, params); ok(res, 200, { jsonrpc: "2.0", id: body.id ?? null, ...(out.error ? { error: out.error } : { result: out.result }) });
  }
  const programOnly = (m, p) => (m === "getProgramAccounts" && p[0] !== program.toBase58()) ? "program_not_allowed" : null;
  function session(req) { const h = req.headers.authorization; if (typeof h !== "string") throw new AuthError("missing_token"); const m = /^Bearer ([A-Za-z0-9._-]+)$/.exec(h); if (!m) throw new AuthError("malformed_authorization"); return auth.verifyToken(m[1]); }
  const REG_SIZE = 128, M_REG = 0x5245_4753;
  // A registry is owned by this program while it sits on base and by the delegation program while it is delegated to the rollup (the data, and so the owner field at byte 8, is the same either way): ask for both, same tight filters.
  const DLP = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
  async function strategies(pubkey) { const seen = new Map();
    for (const owner of [program.toBase58(), DLP]) { const out = await callUpstream("getProgramAccounts", [owner, { encoding: "base64", filters: [{ dataSize: REG_SIZE }, { memcmp: { offset: 8, bytes: pubkey } }] }]); if (out.error) throw new AuthError("upstream_error", 502);
      for (const a of out.result || []) { const d = Buffer.from(a.account.data[0], "base64"); if (d.length < REG_SIZE || d.readUInt32LE(0) !== M_REG || d.subarray(8, 40).compare(Buffer.from(bs58.decode(pubkey))) !== 0) continue;
        const id = d.readBigUInt64LE(40).toString(); if (!seen.has(id)) seen.set(id, { id, commitment: d.subarray(48, 80).toString("hex"), delegated: owner === DLP, seasons: d.readUInt32LE(80), bestRank: d.readUInt32LE(84) === 0xffffffff ? null : d.readUInt32LE(84), totalPnl: d.readBigInt64LE(88).toString(), lastSeason: d.readBigUInt64LE(96).toString(), lastRank: d.readUInt32LE(104), entries: d.readUInt32LE(108) }); } }
    return [...seen.values()]; }

  const server = http.createServer(async (req, res) => {
    const t0 = Date.now(); let who = "-", status = 0; const origEnd = res.end.bind(res); res.end = (...a) => { status = res.statusCode; return origEnd(...a); };
    res.on("close", () => log(`${req.method} ${new URL(req.url, "http://x").pathname} ${status} ${who} ${Date.now() - t0}ms`)); // path only: no query, no headers, no body
    try {
      const u = new URL(req.url, "http://x"); const origin = req.headers.origin;
      res.setHeader("Referrer-Policy", "no-referrer"); res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
      if (origin && origins.includes(origin)) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); res.setHeader("Access-Control-Allow-Headers", "authorization, content-type"); res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS"); }
      if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
      for (const k of u.searchParams.keys()) if (CREDENTIAL_PARAMS.test(k)) return fail(res, 400, "credentials_in_url_refused"); // never accept a credential in a URL, not even to ignore it
      const ip = (trustProxy && req.headers["x-forwarded-for"] ? String(req.headers["x-forwarded-for"]).split(",")[0].trim() : req.socket.remoteAddress) || "?"; const path = u.pathname;
      const limit = (l, key) => { const r = lim[l].take(key); if (!r.ok) { fail(res, 429, "rate_limited", { "retry-after": String(r.retryAfter) }); return false; } return true; };
      if (path === "/health" && req.method === "GET") return ok(res, 200, { ok: true, audience: auth.audience });
      // ---- auth
      if (path === "/auth/challenge" && req.method === "POST") { who = ip; if (!limit("auth", ip)) return; const b = await readJson(req); return ok(res, 200, auth.issueChallenge(b.pubkey)); }
      if (path === "/auth/token" && req.method === "POST") { who = ip; if (!limit("auth", ip)) return; const b = await readJson(req); return ok(res, 200, auth.redeem({ pubkey: b.pubkey, nonce: b.nonce, signature: b.signature })); }
      // ---- open: public and coarse, no token
      if (path.startsWith("/public/")) { who = ip; if (!limit("open", ip)) return;
        const m = /^\/public\/receipt\/(\d{1,20})$/.exec(path); if (m && req.method === "GET") { const rc = PublicKey.findProgramAddressSync([Buffer.from("receipt"), (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(m[1])); return b; })()], program)[0];
          const out = await callUpstream("getAccountInfo", [rc.toBase58(), { encoding: "base64" }]); const v = out.result?.value; const r = v ? coarseReceipt(Buffer.from(v.data[0], "base64")) : null; return r ? ok(res, 200, r) : fail(res, 404, "no_receipt"); }
        if (path === "/public/rpc" && req.method === "POST") return await proxyRpc(res, await readJson(req), PUBLIC_METHODS);
        return fail(res, 404, "not_found"); }
      // ---- gated: player-scoped. Identity comes from the token and nowhere else.
      if (path === "/me" || path.startsWith("/me/")) { let s; try { s = session(req); } catch (e) { if (e instanceof AuthError && e.status === 401) res.setHeader("WWW-Authenticate", `Bearer error="invalid_token", error_description="${e.code}"`); throw e; }
        who = s.pubkey.slice(0, 6); if (!limit("player", s.pubkey)) return;
        if (path === "/me" && req.method === "GET") return ok(res, 200, { pubkey: s.pubkey, expiresAt: s.exp });
        if (path === "/me/strategies" && req.method === "GET") return ok(res, 200, { pubkey: s.pubkey, strategies: await strategies(s.pubkey) });
        if (path === "/me/rpc" && req.method === "POST") return await proxyRpc(res, await readJson(req), PLAYER_METHODS, programOnly);
        return fail(res, 404, "not_found"); }
      return fail(res, 404, "not_found");
    } catch (e) { if (e instanceof AuthError) return fail(res, e.status, e.code); log(`internal error ${e?.name}`); return fail(res, 500, "internal_error"); }
  });
  return server;
}

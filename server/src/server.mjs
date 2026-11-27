// HTTP front: open routes (public, coarse), the auth routes, and the gated player routes. Credentials only ever arrive in the Authorization header or a POST body.
import http from "node:http"; import bs58 from "bs58"; import { PublicKey } from "@solana/web3.js"; import { AuthError } from "./auth.mjs"; import { createLimiter } from "./ratelimit.mjs"; import { coarseReceipt, coarseClaims } from "./receipt.mjs";

const PUBLIC_METHODS = new Set(["getSlot", "getLatestBlockhash", "getAccountInfo", "getMultipleAccounts"]);
const PLAYER_METHODS = new Set([...PUBLIC_METHODS, "getBalance", "getProgramAccounts", "getSignaturesForAddress", "getSignatureStatuses", "getTransaction", "simulateTransaction", "sendTransaction"]);
const CREDENTIAL_PARAMS = /^(token|access_token|id_token|auth|authorization|jwt|session|sig|signature|key|api[-_]?key|apikey|secret|bearer)$/i;
const MAX_BODY = 64 * 1024;

/** recordOnly: serve the public record API (/v1), /health and /healthz and nothing else: no login, no player routes, no route that calls the chain for a caller. Then auth and upstream may be absent.
 *  clientIp: how a caller's address is found for the rate limiter (see config.mjs). trustProxy:true is the old spelling of "xff-first".
 *  health: a function returning { ok, checks }, served at /healthz with 200 or 503. */
export function createApp({ auth = null, upstream = null, rollupUpstream = null, api = null, programId, origins = [], limits = {}, trustProxy = false, clientIp = "socket", recordOnly = false, health = null, gpaCacheSeconds = 60, now = () => Date.now() / 1000, log = () => {}, fetchImpl = fetch, upstreamTimeoutMs = 10000 }) {
  if (!recordOnly && !auth) throw new Error("auth is required unless the server runs in record-only mode");
  const ipMode = clientIp !== "socket" ? clientIp : trustProxy ? "xff-first" : "socket";
  if (!upstream && !recordOnly) throw new Error("upstream RPC url required (it may contain the provider key; it is only ever used server-side)");
  const L = { auth: limits.auth ?? 20, open: limits.open ?? 60, player: limits.player ?? 120, api: limits.api ?? 300, challenge: limits.challenge ?? 30, gpaPlayer: limits.gpaPlayer ?? 4, gpaGlobal: limits.gpaGlobal ?? 6 };
  const lim = { auth: createLimiter({ capacity: L.auth, perMinute: L.auth, now }), open: createLimiter({ capacity: L.open, perMinute: L.open, now }), player: createLimiter({ capacity: L.player, perMinute: L.player, now }), api: createLimiter({ capacity: L.api, perMinute: L.api, now }), challenge: createLimiter({ capacity: L.challenge, perMinute: L.challenge, now }), gpaPlayer: createLimiter({ capacity: L.gpaPlayer, perMinute: L.gpaPlayer, now }), gpaGlobal: createLimiter({ capacity: L.gpaGlobal, perMinute: L.gpaGlobal, now }) };
  const program = new PublicKey(programId); if (api) api.bind?.({ callUpstream: upstream ? (m, p) => callUpstream(m, p) : null }); // with no upstream the freshness field says "no_upstream" instead of failing a request
  const ok = (res, status, body, extra = {}) => { const s = JSON.stringify(body); res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s), ...extra }); res.end(s); };
  const fail = (res, status, error, extra = {}) => ok(res, status, { error }, extra);
  async function readJson(req) { const chunks = []; let n = 0; for await (const c of req) { n += c.length; if (n > MAX_BODY) throw new AuthError("body_too_large", 413); chunks.push(c); } if (!n) return {}; try { const j = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (j === null || typeof j !== "object" || Array.isArray(j)) throw 0; return j; } catch { throw new AuthError("bad_json", 400); } }
  async function callUpstream(method, params, url = upstream) {
    try { const r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(upstreamTimeoutMs) }); return await r.json(); }
    catch { throw new AuthError("upstream_unavailable", 502); } // the error never names the upstream URL: it may carry the key
  }
  // The calls that cost the most upstream credit are getProgramAccounts: GET /me/strategies (two of them per answer: the program's registries and the delegation program's) and POST /me/rpc with that method.
  // Each is answered from a short cache, identical concurrent calls share one upstream request, and a cache MISS is taken from two buckets: the caller's own and one for everybody. Hitting the cache costs the budget nothing.
  const gpaCache = new Map(), gpaFlight = new Map(), GPA_CACHE_MAX = 500;
  async function gpa(key, cost, player, compute) {
    const t = now() * 1000; const hit = gpaCache.get(key); if (hit && t - hit.at < gpaCacheSeconds * 1000) return { value: hit.value };
    const flying = gpaFlight.get(key); if (flying) return { value: await flying };
    const p = lim.gpaPlayer.take(player); if (!p.ok) return { rl: p.retryAfter }; for (let i = 0; i < cost; i++) { const g = lim.gpaGlobal.take("all"); if (!g.ok) return { rl: g.retryAfter }; }
    const f = compute().then(v => { if (!(v && v.error)) { gpaCache.set(key, { at: now() * 1000, value: v }); if (gpaCache.size > GPA_CACHE_MAX) gpaCache.delete(gpaCache.keys().next().value); } return v; }).finally(() => gpaFlight.delete(key));
    gpaFlight.set(key, f); return { value: await f };
  }
  const tooBusy = (res, r) => fail(res, 429, "rate_limited", { "retry-after": String(r.rl) });
  async function proxyRpc(res, body, allowed, extraCheck, guard) {
    if (typeof body.method !== "string" || !allowed.has(body.method)) return fail(res, 403, "method_not_allowed"); const params = Array.isArray(body.params) ? body.params : [];
    if (extraCheck) { const why = extraCheck(body.method, params); if (why) return fail(res, 403, why); } let out; if (guard && body.method === "getProgramAccounts") { const r = await guard(`rpc:${JSON.stringify(params)}`, 1, () => callUpstream(body.method, params)); if (r.rl) return tooBusy(res, r); out = r.value; } else out = await callUpstream(body.method, params); ok(res, 200, { jsonrpc: "2.0", id: body.id ?? null, ...(out.error ? { error: out.error } : { result: out.result }) });
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
      // the v1 API is public, read-only data: any origin may ask what it may send
      if (req.method === "OPTIONS" && u.pathname.startsWith("/v1/") && api) { res.removeHeader("Vary"); res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type, if-none-match", "Access-Control-Max-Age": "86400" }); return res.end(); }
      if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
      for (const k of u.searchParams.keys()) if (CREDENTIAL_PARAMS.test(k)) return fail(res, 400, "credentials_in_url_refused"); // never accept a credential in a URL, not even to ignore it
      const header = n => { const v = req.headers[n]; return typeof v === "string" ? v.trim() : ""; }; const asIp = v => (/^[0-9a-fA-F:.]{2,45}$/.test(v) ? v : "");
      // "global": one bucket for every caller (see config.mjs). The header modes use a proxy's header only when the operator has said the proxy overwrites it; a missing or malformed header falls back to the connection's own address, never to a value a caller made up.
      const ip = (ipMode === "global" ? "all" : (ipMode === "x-real-ip" ? asIp(header("x-real-ip")) : ipMode === "xff-first" ? asIp(header("x-forwarded-for").split(",")[0].trim()) : "") || req.socket.remoteAddress) || "?"; const path = u.pathname;
      const limit = (l, key) => { const r = lim[l].take(key); if (!r.ok) { fail(res, 429, "rate_limited", { "retry-after": String(r.retryAfter) }); return false; } return true; };
      if (path === "/health" && req.method === "GET") return ok(res, 200, { ok: true, audience: auth?.audience ?? null, recordOnly });
      // the real health check: 200 only when the capture loop, the record, the ledger and the volume are all as they should be; 503 with every check named otherwise. It reads the store and the volume and nothing else.
      if (path === "/healthz" && req.method === "GET") { who = ip; if (!limit("api", ip)) return; if (!health) return fail(res, 404, "no_health_check"); const r = health(); return ok(res, r.ok ? 200 : 503, { ok: r.ok, checks: r.checks }); }
      // ---- the public record API (docs/API.md). It reads the record store, holds no token and no secret, and has its own rate-limit buckets
      if (api && path.startsWith("/v1/")) { who = ip; if (await api.handle(req, res, { url: u, ip, limit, readJson })) return; }
      // ---- record-only: nothing below this line exists. The routes that log a player in, act for one, or ask the chain on a caller's behalf are refused, by name, so nobody mistakes the refusal for a missing page
      if (recordOnly && (path.startsWith("/auth/") || path === "/me" || path.startsWith("/me/") || path.startsWith("/public/"))) { who = ip; return ok(res, 403, { error: "disabled_in_record_only_mode", message: "this server runs in record-only mode: it serves the public record API under /v1 and no login, player or chain-proxy route" }); }
      // ---- auth
      if (path === "/auth/challenge" && req.method === "POST") { who = ip; if (!limit("auth", ip)) return; const b = await readJson(req); return ok(res, 200, auth.issueChallenge(b.pubkey)); }
      if (path === "/auth/token" && req.method === "POST") { who = ip; if (!limit("auth", ip)) return; const b = await readJson(req); return ok(res, 200, auth.redeem({ pubkey: b.pubkey, nonce: b.nonce, signature: b.signature })); }
      // ---- open: public and coarse, no token
      if (path.startsWith("/public/")) { who = ip; if (!limit("open", ip)) return;
        const m = /^\/public\/receipt\/(\d{1,20})$/.exec(path); if (m && req.method === "GET") { const rc = PublicKey.findProgramAddressSync([Buffer.from("receipt"), (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(m[1])); return b; })()], program)[0];
          const out = await callUpstream("getAccountInfo", [rc.toBase58(), { encoding: "base64" }]); const v = out.result?.value; const r = v ? coarseReceipt(Buffer.from(v.data[0], "base64")) : null; return r ? ok(res, 200, r) : fail(res, 404, "no_receipt"); }
        // the claims account lives only in the rollup (it is public, so no credential is used); once every claim is paid it can be closed, and the receipt remains the record
        const k = /^\/public\/claims\/(\d{1,20})$/.exec(path); if (k && req.method === "GET") { if (!rollupUpstream) return fail(res, 404, "no_rollup_upstream"); const acct = PublicKey.findProgramAddressSync([Buffer.from("claims"), (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(k[1])); return b; })()], program)[0];
          const out = await callUpstream("getAccountInfo", [acct.toBase58(), { encoding: "base64" }], rollupUpstream); const v = out.result?.value; const r = v ? coarseClaims(Buffer.from(v.data[0], "base64")) : null; return r ? ok(res, 200, r) : fail(res, 404, "no_claims_account"); }
        if (path === "/public/rpc" && req.method === "POST") return await proxyRpc(res, await readJson(req), PUBLIC_METHODS);
        return fail(res, 404, "not_found"); }
      // ---- gated: player-scoped. Identity comes from the token and nowhere else.
      if (path === "/me" || path.startsWith("/me/")) { let s; try { s = session(req); } catch (e) { if (e instanceof AuthError && e.status === 401) res.setHeader("WWW-Authenticate", `Bearer error="invalid_token", error_description="${e.code}"`); throw e; }
        who = s.pubkey.slice(0, 6); if (!limit("player", s.pubkey)) return;
        if (path === "/me" && req.method === "GET") return ok(res, 200, { pubkey: s.pubkey, expiresAt: s.exp });
        if (path === "/me/strategies" && req.method === "GET") { const r = await gpa(`strategies:${s.pubkey}`, 2, s.pubkey, () => strategies(s.pubkey)); if (r.rl) return tooBusy(res, r); return ok(res, 200, { pubkey: s.pubkey, strategies: r.value }); }
        if (path === "/me/rpc" && req.method === "POST") return await proxyRpc(res, await readJson(req), PLAYER_METHODS, programOnly, (k, c, f) => gpa(k, c, s.pubkey, f));
        return fail(res, 404, "not_found"); }
      return fail(res, 404, "not_found");
    } catch (e) { if (e instanceof AuthError) return fail(res, e.status, e.code); log(`internal error ${e?.name}`); return fail(res, 500, "internal_error"); }
  });
  return server;
}

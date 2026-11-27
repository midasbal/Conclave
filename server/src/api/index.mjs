// The v1 API: routing, validation, cache headers and the proof endpoints. Every response body is built by model.mjs and described by schema.mjs. Nothing here holds a rollup token or a secret, reads the chain (except one finalized-slot
// read for the freshness field of /v1/status), or ever logs a request body.
import crypto from "node:crypto"; import bs58 from "bs58";
import { routes, openapi } from "./schema.mjs"; import { validateAgainst } from "./validate.mjs"; import * as M from "./model.mjs"; import { NOTICE } from "./notices.mjs"; import { ChallengeStore } from "./challenges.mjs";
import * as P from "../../../verifier/lib/proofs.mjs"; import { judge } from "../../../verifier/lib/lookup.mjs";

const U64_MAX = (1n << 64n) - 1n; const FORBIDDEN_FIELDS = /^(salt|sealed_?salt|code|bytecode|source|passphrase|secret|private_?key|secret_?key|seed)$/i;
class ApiError extends Error { constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; } }
const bad = (code, message) => new ApiError(400, code, message), missing = (code, message) => new ApiError(404, code, message);
const decimal = (v, what) => { if (!/^[0-9]{1,20}$/.test(v) || BigInt(v) > U64_MAX) throw bad("invalid_" + what, `${what} must be a decimal number below 2^64`); return String(BigInt(v)); };
const pubkey = v => { try { if (bs58.decode(v).length === 32) return v; } catch { /* falls through */ } throw bad("invalid_wallet", "a wallet is a base58 public key"); };
const commitment = v => { if (!/^[0-9a-f]{64}$/.test(v)) throw bad("invalid_commitment", "a commitment is 64 lowercase hex characters"); return v; };
const intParam = (q, name, def, min, max) => { if (!q.has(name)) return def; const v = q.get(name); if (!/^[0-9]{1,9}$/.test(v) || +v < min || +v > max) throw bad("invalid_" + name, `${name} must be an integer from ${min} to ${max}`); return +v; };
const enumParam = (q, name, allowed, def = null) => { if (!q.has(name)) return def; const v = q.get(name); if (!allowed.includes(v)) throw bad("invalid_" + name, `${name} must be one of ${allowed.join(", ")}`); return v; };
const etagOf = body => `"${crypto.createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;

export function createApi({ store, rules, challenges = new ChallengeStore(), genesis, program, callUpstream = null, now = () => Date.now(), staleAfterSeconds = 300 }) {
  const bind = o => { if (!callUpstream && o.callUpstream) callUpstream = o.callUpstream; };
  const compiled = routes.map(r => ({ r, re: new RegExp("^" + r.path.replace(/\{(\w+)\}/g, "([^/]+)") + "$") }));
  let chainCache = null;
  async function chain() {
    if (chainCache && now() - chainCache.at < 10_000) return chainCache.v; const checkedAt = new Date(now()).toISOString(); let v;
    if (!callUpstream) v = { currentSlot: null, checkedAt, error: "no_upstream" };
    else try { const out = await callUpstream("getSlot", [{ commitment: "finalized" }]); v = Number.isInteger(out?.result) ? { currentSlot: out.result, checkedAt, error: null } : { currentSlot: null, checkedAt, error: "upstream_bad_answer" }; } catch (e) { v = { currentSlot: null, checkedAt, error: e.code ?? "upstream_unavailable" }; }
    chainCache = { at: now(), v }; return v;
  }
  function loaded() { const L = store.load(); if (L.problem) { if (L.problem === "store_not_configured") throw missing("store_not_configured", "this server has no record store configured"); throw new ApiError(503, L.problem, L.problem === "store_empty" ? "the record has not been built yet" : L.problem === "store_format" ? "the record store is in a format this API does not read: run the capture loop of this version to rewrite it" : "the record could not be read"); } return L; }

  function send(req, res, status, body, cache) {
    const text = JSON.stringify(body); res.setHeader("content-type", "application/json; charset=utf-8");
    if (status === 200 && cache !== "no-store") { const etag = etagOf(text); res.setHeader("ETag", etag); res.setHeader("Cache-Control", cache); if (req.headers["if-none-match"]?.split(",").map(s => s.trim()).includes(etag)) { res.writeHead(304); return res.end(); } }
    else res.setHeader("Cache-Control", "no-store");
    if (body?.permalink) res.setHeader("Content-Location", body.permalink);
    res.writeHead(status, { "content-length": Buffer.byteLength(text) }); res.end(text);
  }
  const errorBody = e => ({ apiVersion: "v1", error: { type: e.code, message: e.message } });

  // ---- proofs: the record's own season object is what the verifier's checks run on
  const receiptOf = s => ({ address: s.address, status: s.status, from: s.status === "final" ? "this service's store: the first final copy of the receipt" : "this service's store: the receipt's current state on base, still delegated, so it can still change", sha256: s.copy.sha256, alarms: s.flags.filter(f => !f.info).map(f => f.kind) });
  function present(result, season, allowProvisional, { claimed = null } = {}) {
    const j = judge(result, receiptOf(season), { allowProvisional });
    return { apiVersion: "v1", level: j.level, verified: j.verified, checks: j.checks.map(c => ({ name: c.name, ok: c.ok, ...(c.detail ? { detail: c.detail } : {}) })), blockers: j.blockers, establishes: j.verified ? j.establishes : [], doesNot: j.doesNot, receipt: j.receipt, entry: j.entry ? M.entry(j.entry) : null, claimed, notes: j.notes ?? [] };
  }
  function body(raw, def) {
    for (const k of Object.keys(raw)) if (FORBIDDEN_FIELDS.test(k)) throw bad("secret_field_refused", "this API never accepts a salt, a bytecode, a source or a key: level 4 runs in your browser or the CLI, not here");
    const why = validateAgainst(def, raw); if (why) throw bad("invalid_request", why); return raw;
  }
  const seasonFor = (L, id) => L.seasonById.get(id) ?? (() => { throw missing("season_not_in_record", "no season with this id is in the verified record"); })();
  const levels = () => ({ apiVersion: "v1", levels: [
    { level: 1, name: "recorded", where: "server", endpoint: "/v1/proofs/recorded", establishes: P.CLAIMS.recorded.establishes, doesNot: P.CLAIMS.recorded.doesNot },
    { level: 2, name: "wallet", where: "server", endpoint: "/v1/proofs/wallet/challenges", establishes: P.CLAIMS.wallet.establishes, doesNot: P.CLAIMS.wallet.doesNot },
    { level: 3, name: "totals", where: "server", endpoint: "/v1/proofs/totals", establishes: P.CLAIMS.totals.establishes, doesNot: [...P.CLAIMS.totals.doesNot, "Sending a score salt to this server tells its operator that season's totals. To keep them to yourself, check offline with the verifier CLI (verify-totals)."] },
    { level: 4, name: "code", where: "browser-or-cli", endpoint: null, establishes: P.CLAIMS.code.establishes, doesNot: P.CLAIMS.code.doesNot } ],
    level4: "Level 4 is never accepted by this server. It runs in your browser on the conclave-vm WASM (crates/conclave-author) or with the verifier CLI (verify-code). The server never receives a salt or a bytecode, and a request that carries one is refused." });

  async function dispatch(id, req, res, { q, params, readJson, take }) {
    const get = (r, h) => send(req, res, 200, h, r.cache);
    const route = routes.find(r => r.id === id);
    switch (id) {
      case "openapi": return send(req, res, 200, openapi(), route.cache);
      case "proofLevels": return get(route, levels());
      case "status": { const L = store.load(); let rulesConfigured = false; try { rulesConfigured = rules.get().configured; } catch { /* reported by the leaderboard */ }
        return get(route, M.status({ record: L.record ?? null, st: store.status(), problem: L.problem ?? null, genesis, program, staleAfterSeconds, rulesConfigured, chain: await chain(), nowMs: now() })); }
      case "legacy": return get(route, M.legacy(loaded().record));
      case "leaderboard": { const L = loaded(); let src; try { src = rules.get(); } catch { throw new ApiError(503, "rules_unreadable", "the counting rules file could not be read"); }
        try { return get(route, M.leaderboard(L.record, src, { limit: intParam(q, "limit", 100, 1, 500), offset: intParam(q, "offset", 0, 0, 1_000_000) })); } catch (e) { if (e instanceof ApiError) throw e; throw new ApiError(503, "rules_invalid", "the counting rules file is not valid: " + e.message); } }
      case "seasons": { const L = loaded(); const creator = q.has("creator") ? pubkey(q.get("creator")) : null;
        return get(route, M.seasonList(L.record, { status: enumParam(q, "status", ["final", "provisional"]), kind: enumParam(q, "kind", ["settled", "cancelled"]), creator, order: enumParam(q, "order", ["asc", "desc"], "desc"), limit: intParam(q, "limit", 50, 1, 200), offset: intParam(q, "offset", 0, 0, 1_000_000) })); }
      case "season": { const L = loaded(); const s = L.seasonById.get(decimal(params.season, "season")); if (!s) throw missing("season_not_in_record", "no season with this id is in the verified record"); return get(route, M.seasonDetail(L.record, s)); }
      case "strategy": { const L = loaded(); const p = M.strategyPage(L.record, decimal(params.id, "strategy")); if (!p) throw missing("strategy_not_in_record", "this strategy id is on no receipt in the verified record"); return get(route, p); }
      case "wallet": { const L = loaded(); const p = M.walletPage(L.record, pubkey(params.pubkey)); if (!p) throw missing("wallet_not_in_record", "this wallet is the owner on no receipt in the verified record"); return get(route, p); }
      case "commitment": { const L = loaded(); const p = M.commitmentPage(L.record, commitment(params.commitment)); if (!p) throw missing("commitment_not_in_record", "this commitment is on no receipt in the verified record"); return get(route, p); }
      case "proofCode": req.resume(); throw new ApiError(422, "level_4_not_accepted", "level 4 is never accepted here: it needs your salt and bytecode, which this server must never receive. Run it in your browser on the conclave-vm WASM, or with the verifier CLI (verify-code).");
      case "proofRecorded": { const L = loaded(); const b = body(await readJson(req), "RecordedRequest"); return send(req, res, 200, present(P.verifyRecorded(seasonFor(L, b.season), { id: b.strategyId, codeCommitment: b.codeCommitment }), seasonFor(L, b.season), !!b.allowProvisional), "no-store"); }
      case "proofTotals": { const L = loaded(); const b = body(await readJson(req), "TotalsRequest"); const s = seasonFor(L, b.season); let r;
        try { r = P.verifyTotals(s, { id: b.strategyId, slot: b.slot, total: b.total, finalsTotal: b.finalsTotal, scoreSalt: b.scoreSalt }); } catch (e) { throw bad("invalid_request", e.message); }
        return send(req, res, 200, present(r, s, !!b.allowProvisional, { claimed: { total: b.total, finalsTotal: b.finalsTotal } }), "no-store"); }
      case "proofChallenge": { if (!take("challenge", params.ip)) return; const L = loaded(); const b = body(await readJson(req), "ChallengeRequest"); const s = seasonFor(L, b.season);
        if (!s.entries.some(e => e.strategyId === b.strategyId)) throw missing("strategy_not_on_season", "that strategy is not on that season's receipt");
        let c; try { c = P.makeChallenge({ genesis, program, season: s.season, id: b.strategyId, askedBy: b.askedBy, now: now() }); } catch (e) { throw bad("invalid_request", e.message); }
        if (!challenges.put(c)) throw new ApiError(503, "too_many_challenges", "too many challenges are waiting to be answered; try again shortly");
        const bytes = P.challengeMessage(c);
        return send(req, res, 200, { apiVersion: "v1", singleUse: true, expiresAt: c.expiresAt, challenge: c, signThis: { encoding: "base64", bytes: bytes.toString("base64"), text: bytes.subarray(1).toString(), howTo: "Sign these exact bytes (the base64 decoded, including the leading 0xff) with the entering wallet's ed25519 key, as a message and never as a transaction, then send the signature as 128 hex characters." }, verifyAt: "/v1/proofs/wallet/verify", signatureEncoding: "hex" }, "no-store"); }
      case "proofWallet": { const L = loaded(); const b = body(await readJson(req), "WalletVerifyRequest");
        const issued = challenges.take(b.nonce); // burned here, on the first attempt, whatever the outcome
        if (!issued) throw missing("challenge_not_found", "this server issued no such challenge, or it was already answered, or it has expired");
        const s = seasonFor(L, issued.season); return send(req, res, 200, present(P.verifyWallet(s, issued, { nonce: b.nonce, signature: b.signature }, { genesis, program, now: now() }), s, !!b.allowProvisional), "no-store"); }
      default: throw new ApiError(500, "internal_error", "route without a handler");
    }
  }

  /** returns true if the request was for /v1 (and has been answered) */
  async function handle(req, res, { url, ip, limit, readJson }) {
    const path = url.pathname; if (!path.startsWith("/v1/")) return false;
    // public data: any origin may read it, nothing is credentialed
    res.removeHeader("Vary"); res.setHeader("Access-Control-Allow-Origin", "*"); res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS"); res.setHeader("Access-Control-Allow-Headers", "content-type, if-none-match"); res.setHeader("Access-Control-Expose-Headers", "ETag, Cache-Control, Content-Location");
    if (!limit("api", ip)) return true;
    try {
      const hit = compiled.find(c => c.re.test(path)); if (!hit) throw missing("not_found", "no such route"); if (hit.r.method !== req.method) { res.setHeader("Allow", hit.r.method); throw new ApiError(405, "method_not_allowed", `this route takes ${hit.r.method}`); }
      for (const k of url.searchParams.keys()) if (!(hit.r.query ?? []).includes(k)) throw bad("unknown_parameter", `${k} is not a parameter of this route (a parameter is never silently ignored)`);
      const m = hit.re.exec(path); const names = [...hit.r.path.matchAll(/\{(\w+)\}/g)].map(x => x[1]); const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])])); params.ip = ip;
      await dispatch(hit.r.id, req, res, { q: url.searchParams, params, readJson, take: (b, k) => limit(b, k) });
    } catch (e) {
      if (e instanceof ApiError) return send(req, res, e.status, errorBody(e), "no-store"), true;
      if (e?.code && e?.status && typeof e.status === "number") return send(req, res, e.status, errorBody({ code: String(e.code).replace(/[^a-z0-9_]/g, "_"), message: e.code.replaceAll("_", " ") }), "no-store"), true; // the server's own errors (bad json, body too large)
      throw e;
    }
    return true;
  }
  return { handle, bind, challenges, openapi };
}

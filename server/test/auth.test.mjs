import test from "node:test"; import assert from "node:assert/strict"; import nacl from "tweetnacl"; import bs58 from "bs58";
import { authMessage, createAuth, DOMAIN, AuthError } from "../src/auth.mjs"; import { wallet, clock, SECRET, startUpstream, startApp, post, login, token } from "./helpers.mjs"; import { Session, checkChallenge } from "../../client/session.mjs";

test("the challenge message is exactly the documented, domain-separated format", async () => {
  const up = await startUpstream(); const app = await startApp({ upstream: up }); const w = wallet(); const ch = await (await post(app.base, "/auth/challenge", { pubkey: w.pubkey })).json();
  assert.equal(ch.message, `${DOMAIN}\naudience: conclave-api\npubkey: ${w.pubkey}\nnonce: ${ch.nonce}\nissued: ${ch.issued}\nexpires: ${ch.expires}`); assert.match(ch.nonce, /^[0-9a-f]{64}$/); assert.equal(ch.expires - ch.issued, 120); assert.ok(ch.message.startsWith("CNCL-AUTH-v1\n"));
  await app.close(); await up.close(); });

test("sign with a real key, verify, receive a token bound to the pubkey; the token works in a header", async () => {
  const up = await startUpstream(); const app = await startApp({ upstream: up }); const w = wallet(); const t = await token(app.base, w);
  assert.equal(t.tokenType, "Bearer"); assert.equal(t.expiresAt - t.issuedAt, 900, "session TTL is 15 minutes"); const [v, payload] = t.token.split("."); assert.equal(v, "v1"); const p = JSON.parse(Buffer.from(payload, "base64url")); assert.equal(p.sub, w.pubkey); assert.equal(p.aud, "conclave-api");
  const me = await (await fetch(app.base + "/me", { headers: { authorization: `Bearer ${t.token}` } })).json(); assert.equal(me.pubkey, w.pubkey); await app.close(); await up.close(); });

test("a signature from a different key, over a different message, or for another pubkey is rejected", async () => {
  const up = await startUpstream(); const app = await startApp({ upstream: up }); const a = wallet(), b = wallet();
  // (1) b signs a's challenge
  { const ch = await (await post(app.base, "/auth/challenge", { pubkey: a.pubkey })).json(); const r = await post(app.base, "/auth/token", { pubkey: a.pubkey, nonce: ch.nonce, signature: b.signB58(ch.message) }); assert.equal(r.status, 401); assert.equal((await r.json()).error, "invalid_signature"); }
  // (2) a signs a different message (another audience): the server rebuilds the message from its own record, so this cannot verify
  { const r = (await login(app.base, a, { tamper: m => m.replace("audience: conclave-api", "audience: evil-site") })).res; assert.equal(r.status, 401); assert.equal((await r.json()).error, "invalid_signature"); }
  // (3) a signs a message with a plausible edit to the expiry
  { const r = (await login(app.base, a, { tamper: m => m.replace(/expires: (\d+)/, (_, n) => `expires: ${+n + 3600}`) })).res; assert.equal(r.status, 401); }
  // (4) a challenge issued to a is redeemed claiming to be b, with b's valid signature over a's message
  { const ch = await (await post(app.base, "/auth/challenge", { pubkey: a.pubkey })).json(); const r = await post(app.base, "/auth/token", { pubkey: b.pubkey, nonce: ch.nonce, signature: b.signB58(ch.message) }); assert.equal((await r.json()).error, "nonce_not_issued_to_this_pubkey"); }
  // (5) a signature over a transaction-like blob or an unrelated protocol message is not a valid login
  { const ch = await (await post(app.base, "/auth/challenge", { pubkey: a.pubkey })).json(); const r = await post(app.base, "/auth/token", { pubkey: a.pubkey, nonce: ch.nonce, signature: a.signB58("Login to Query Filtering Service\nTimestamp: 1795560051\nUser: " + a.pubkey) }); assert.equal(r.status, 401); }
  await app.close(); await up.close(); });

test("a nonce is single use: replay is rejected, including a replay racing the first redemption", async () => {
  const up = await startUpstream(); const app = await startApp({ upstream: up }); const w = wallet(); const ch = await (await post(app.base, "/auth/challenge", { pubkey: w.pubkey })).json(); const body = { pubkey: w.pubkey, nonce: ch.nonce, signature: w.signB58(ch.message) };
  const [r1, r2] = await Promise.all([post(app.base, "/auth/token", body), post(app.base, "/auth/token", body)]); const codes = [r1.status, r2.status].sort(); assert.deepEqual(codes, [200, 401], "exactly one of two concurrent redemptions wins");
  const r3 = await post(app.base, "/auth/token", body); assert.equal(r3.status, 401); assert.equal((await r3.json()).error, "nonce_unknown_or_used"); assert.equal(app.auth.pendingCount(), 0);
  // a failed attempt burns the nonce too: it cannot be ground against
  const ch2 = await (await post(app.base, "/auth/challenge", { pubkey: w.pubkey })).json(); const bad = await post(app.base, "/auth/token", { pubkey: w.pubkey, nonce: ch2.nonce, signature: wallet().signB58(ch2.message) }); assert.equal(bad.status, 401);
  const good = await post(app.base, "/auth/token", { pubkey: w.pubkey, nonce: ch2.nonce, signature: w.signB58(ch2.message) }); assert.equal((await good.json()).error, "nonce_unknown_or_used"); await app.close(); await up.close(); });

test("an expired challenge is rejected even with a valid signature", async () => {
  const up = await startUpstream(); const clk = clock(); const app = await startApp({ upstream: up, clk }); const w = wallet(); const ch = await (await post(app.base, "/auth/challenge", { pubkey: w.pubkey })).json();
  clk.advance(121); const r = await post(app.base, "/auth/token", { pubkey: w.pubkey, nonce: ch.nonce, signature: w.signB58(ch.message) }); assert.equal(r.status, 401); assert.equal((await r.json()).error, "challenge_expired");
  // just inside the window works
  const ch2 = await (await post(app.base, "/auth/challenge", { pubkey: w.pubkey })).json(); clk.advance(119); assert.equal((await post(app.base, "/auth/token", { pubkey: w.pubkey, nonce: ch2.nonce, signature: w.signB58(ch2.message) })).status, 200); await app.close(); await up.close(); });

test("the session token expires, the old one stays dead, and the client re-signs on its own", async () => {
  const up = await startUpstream(); const clk = clock(); const app = await startApp({ upstream: up, clk }); const w = wallet(); const t = await token(app.base, w); const H = tok => ({ authorization: `Bearer ${tok}` });
  clk.advance(899); assert.equal((await fetch(app.base + "/me", { headers: H(t.token) })).status, 200, "valid until the last second");
  clk.advance(1); const dead = await fetch(app.base + "/me", { headers: H(t.token) }); assert.equal(dead.status, 401); assert.equal((await dead.json()).error, "token_expired"); assert.match(dead.headers.get("www-authenticate"), /token_expired/);
  // the Session helper (real signatures) signs again when the token is near or past expiry
  const s = new Session({ baseUrl: app.base, pubkey: w.pubkey, signMessage: w.sign, audience: "conclave-api", now: clk.now }); assert.equal((await s.fetch("/me")).status, 200); assert.equal(s.logins, 1);
  clk.advance(880); assert.equal((await s.fetch("/me")).status, 200); assert.equal(s.logins, 2, "inside the 30 s skew: renewed before it could fail"); assert.equal((await s.fetch("/me")).status, 200); assert.equal(s.logins, 2, "and reused while fresh");
  // a token the client still believes is fresh but the server has expired (clock disagreement, server restart with a shorter TTL): one 401, one re-sign, one retry
  const s2 = new Session({ baseUrl: app.base, pubkey: w.pubkey, signMessage: w.sign, audience: "conclave-api", now: clk.now }); await s2.token(); clk.advance(901); s2._exp = clk.now() + 5000; const r = await s2.fetch("/me"); assert.equal(r.status, 200); assert.equal(s2.logins, 2, "signed again exactly once");
  // concurrent callers share one login
  const s3 = new Session({ baseUrl: app.base, pubkey: w.pubkey, signMessage: w.sign, audience: "conclave-api", now: clk.now }); await Promise.all([s3.token(), s3.token(), s3.token()]); assert.equal(s3.logins, 1); await app.close(); await up.close(); });

test("tokens cannot be forged, edited, moved to another audience, or reused across secrets", async () => {
  const up = await startUpstream(); const app = await startApp({ upstream: up }); const a = wallet(), b = wallet(); const t = await token(app.base, a); const H = tok => ({ authorization: `Bearer ${tok}` }); const err = async tok => (await (await fetch(app.base + "/me", { headers: H(tok) })).json()).error;
  const [v, p, m] = t.token.split("."); const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url")), sub: b.pubkey })).toString("base64url");
  assert.equal(await err(`${v}.${edited}.${m}`), "token_invalid", "swapping the pubkey in the payload breaks the MAC"); assert.equal(await err(`${v}.${p}.${m.slice(0, -2)}AA`), "token_invalid"); assert.equal(await err("garbage"), "token_invalid"); assert.equal(await err(`v2.${p}.${m}`), "token_invalid");
  const other = createAuth({ audience: "conclave-api", secret: "another-secret-another-secret-another-secret-12" }); const w2 = other.issueChallenge(a.pubkey); const forged = other.redeem({ pubkey: a.pubkey, nonce: w2.nonce, signature: a.signB58(w2.message) }); assert.equal(await err(forged.token), "token_invalid", "a token minted under another secret");
  const wrongAud = createAuth({ audience: "other-service", secret: SECRET }); const c = wrongAud.issueChallenge(a.pubkey); const tk = wrongAud.redeem({ pubkey: a.pubkey, nonce: c.nonce, signature: a.signB58(c.message) }); assert.equal(await err(tk.token), "wrong_audience", "same secret, different audience");
  await app.close(); await up.close(); });

test("identity comes from the token only: a pubkey in the URL or body cannot select another player", async () => {
  const up = await startUpstream((b) => b.method === "getProgramAccounts" ? { result: [] } : { result: null }); const app = await startApp({ upstream: up }); const a = wallet(), b = wallet(); const t = await token(app.base, a);
  const r = await fetch(app.base + `/me/strategies?pubkey=${b.pubkey}`, { headers: { authorization: `Bearer ${t.token}` } }); const j = await r.json(); assert.equal(r.status, 200); assert.equal(j.pubkey, a.pubkey);
  const qs = up.seen.filter(s => s.body.method === "getProgramAccounts"); assert.equal(qs.length, 2, "base-owned and delegated registries"); for (const q of qs) assert.equal(q.body.params[1].filters[1].memcmp.bytes, a.pubkey, "the upstream query is for the token's pubkey, not the requested one"); await app.close(); await up.close(); });

test("gating: private routes need a token, public and coarse routes stay open, and credentials in a URL are refused outright", async () => {
  const up = await startUpstream(); const app = await startApp({ upstream: up }); const w = wallet(); const t = await token(app.base, w);
  for (const [m, p] of [["GET", "/me"], ["GET", "/me/strategies"], ["POST", "/me/rpc"]]) { const r = await fetch(app.base + p, { method: m, headers: { "content-type": "application/json" }, body: m === "POST" ? "{}" : undefined }); assert.equal(r.status, 401, `${m} ${p} needs a token`); assert.match(r.headers.get("www-authenticate"), /Bearer/); }
  assert.equal((await fetch(app.base + "/me", { headers: { authorization: "Bearer " } })).status, 401); assert.equal((await fetch(app.base + "/me", { headers: { authorization: `Basic ${t.token}` } })).status, 401);
  assert.equal((await fetch(app.base + "/health")).status, 200); assert.equal((await post(app.base, "/public/rpc", { jsonrpc: "2.0", id: 7, method: "getSlot" })).status, 200);
  const before = up.seen.length; for (const q of ["token=" + t.token, "access_token=x", "api_key=x", "key=x", "jwt=x", "Authorization=x"]) { for (const p of ["/public/rpc", "/me", "/health"]) { const r = await fetch(app.base + p + "?" + q, { method: p === "/public/rpc" ? "POST" : "GET", headers: { authorization: `Bearer ${t.token}`, "content-type": "application/json" }, body: p === "/public/rpc" ? "{}" : undefined }); assert.equal(r.status, 400, `${p}?${q.split("=")[0]}`); assert.equal((await r.json()).error, "credentials_in_url_refused"); } }
  assert.equal(up.seen.length, before, "nothing reached the upstream"); await app.close(); await up.close(); });

test("the proxy exposes only allowlisted methods and only this program's accounts", async () => {
  const up = await startUpstream(); const app = await startApp({ upstream: up }); const w = wallet(); const t = await token(app.base, w); const H = { authorization: `Bearer ${t.token}` };
  assert.equal((await post(app.base, "/public/rpc", { method: "sendTransaction", params: ["x"] })).status, 403); assert.equal((await post(app.base, "/public/rpc", { method: "getProgramAccounts", params: [] })).status, 403); assert.equal((await post(app.base, "/public/rpc", { method: ["getSlot"] })).status, 403);
  assert.equal((await post(app.base, "/me/rpc", { method: "getProgramAccounts", params: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"] }, H)).status, 403, "a scan of someone else's program would burn the key"); assert.equal((await post(app.base, "/me/rpc", { method: "getProgramAccounts", params: [(await import("./helpers.mjs")).PROGRAM, { encoding: "base64" }] }, H)).status, 200);
  assert.equal((await post(app.base, "/me/rpc", { method: "requestAirdrop", params: [] }, H)).status, 403); assert.equal((await fetch(app.base + "/public/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(70 * 1024) })).status, 413); await app.close(); await up.close(); });

test("rate limits are per pubkey: one player exhausting theirs does not affect another, and tokens refill", async () => {
  const up = await startUpstream(); const clk = clock(); const app = await startApp({ upstream: up, clk, limits: { auth: 1000, open: 3, player: 5 } }); const a = wallet(), b = wallet(); const ta = await token(app.base, a), tb = await token(app.base, b); const get = (t, p = "/me") => fetch(app.base + p, { headers: { authorization: `Bearer ${t.token}` } });
  for (let i = 0; i < 5; i++) assert.equal((await get(ta)).status, 200); const r = await get(ta); assert.equal(r.status, 429); assert.ok(+r.headers.get("retry-after") >= 1); assert.equal((await get(tb)).status, 200, "another pubkey has its own bucket");
  clk.advance(12); assert.equal((await get(ta)).status, 200, "a token refilled after 12 s at 5 per minute");
  for (let i = 0; i < 3; i++) assert.equal((await post(app.base, "/public/rpc", { method: "getSlot" })).status, 200); assert.equal((await post(app.base, "/public/rpc", { method: "getSlot" })).status, 429, "open routes are limited per client address"); await app.close(); await up.close(); });

test("the upstream key never reaches a client, a log line or an error, and client credentials never reach the upstream", async () => {
  const up = await startUpstream(); const app = await startApp({ upstream: up }); const w = wallet(); const t = await token(app.base, w); const everything = [];
  const grab = async r => { everything.push(JSON.stringify([...r.headers])); everything.push(await r.text()); };
  await grab(await post(app.base, "/public/rpc", { method: "getAccountInfo", params: ["11111111111111111111111111111111"] })); await grab(await fetch(app.base + "/me/strategies", { headers: { authorization: `Bearer ${t.token}` } })); await grab(await fetch(app.base + "/public/receipt/123"));
  assert.ok(up.seen.length >= 3 && up.seen.every(s => s.url.includes(UPSTREAM_KEY_Q())), "the key is used server-side on every upstream call"); assert.ok(up.seen.every(s => !s.headers.authorization), "the player's Authorization header is never forwarded");
  await up.close(); const dead = await post(app.base, "/public/rpc", { method: "getSlot" }); assert.equal(dead.status, 502); await grab(dead);
  const blob = everything.join("\n") + app.logs.join("\n"); const keyVal = UPSTREAM_KEY_Q().split("=")[1]; assert.ok(!blob.includes(keyVal), "no upstream key in responses, headers or logs"); assert.ok(!blob.includes(t.token), "no session token in responses or logs"); assert.ok(!app.logs.join("\n").includes("Bearer") && !app.logs.some(l => l.includes("?")), "log lines carry method, path, status and a pubkey prefix only");
  await app.close(); });
const UPSTREAM_KEY_Q = () => "api-key=UPSTREAM-API-KEY-8f3a91c2d4";

test("response headers: no referrer, no caching, CORS only for configured origins, no wildcard", async () => {
  const up = await startUpstream(); const app = await startApp({ upstream: up }); const ok = await fetch(app.base + "/health", { headers: { origin: "https://app.example" } }); assert.equal(ok.headers.get("referrer-policy"), "no-referrer"); assert.equal(ok.headers.get("cache-control"), "no-store"); assert.equal(ok.headers.get("access-control-allow-origin"), "https://app.example");
  const bad = await fetch(app.base + "/health", { headers: { origin: "https://evil.example" } }); assert.equal(bad.headers.get("access-control-allow-origin"), null); const pre = await fetch(app.base + "/me", { method: "OPTIONS", headers: { origin: "https://app.example" } }); assert.equal(pre.status, 204); assert.match(pre.headers.get("access-control-allow-headers"), /authorization/); await app.close(); await up.close(); });

test("coarse receipt is public and exposes ranks only (no commitments)", async () => {
  const d = Buffer.alloc(192 + 20 * 80); d.writeUInt32LE(0x54435052, 0); d[4] = 0; d[5] = 2; d[6] = 2; d.writeBigUInt64LE(77n, 8); d[144] = 2; d.writeBigUInt64LE(11n, 192); d.writeUInt32LE(2, 192 + 72); d.fill(0xab, 192 + 8, 192 + 72); d.writeBigUInt64LE(12n, 192 + 80); d.writeUInt32LE(1, 192 + 80 + 72);
  const up = await startUpstream(() => ({ result: { value: { data: [d.toString("base64"), "base64"] } } })); const app = await startApp({ upstream: up }); const r = await fetch(app.base + "/public/receipt/77"); const j = await r.json(); assert.equal(r.status, 200);
  assert.deepEqual({ kind: j.kind, state: j.state, entrants: j.entrants, published: j.published, season: j.season }, { kind: "ensemble", state: "closed", entrants: 2, published: 2, season: "77" }); assert.deepEqual(j.entries.map(e => [e.id, e.rank]), [["11", 2], ["12", 1]]); assert.ok(!JSON.stringify(j).includes("abab"), "commitments are not in the coarse view");
  assert.equal((await fetch(app.base + "/public/receipt/abc")).status, 404); await app.close(); await up.close(); });

test("coarse receipt of the new layout shows both ranks, the finals status and the amount owed, and nothing private", async () => {
  const d = Buffer.alloc(224 + 20 * 80); d.writeUInt32LE(0x54435052, 0); d[5] = 2; d[6] = 2; d.writeBigUInt64LE(78n, 8); d[144] = 2; d[145] = 5; d[210] = 2; d.writeBigUInt64LE(20n, 216);
  for (const [i, id, frank, srank] of [[0, 11n, 2, 2], [1, 12n, 1, 1]]) { const e = 224 + i * 80; d.writeBigUInt64LE(id, e); d.fill(0xcd, e + 8, e + 72); d.writeUInt32LE(frank, e + 72); d.writeUInt16LE(srank, e + 76); }
  const up = await startUpstream(() => ({ result: { value: { data: [d.toString("base64"), "base64"] } } })); const app = await startApp({ upstream: up }); const j = await (await fetch(app.base + "/public/receipt/78")).json();
  assert.deepEqual({ kind: j.kind, finals: j.finals, reason: j.reason, owedTotal: j.owedTotal, layout: j.layout }, { kind: "season", finals: "voided", reason: "finals_deadline", owedTotal: "20", layout: 2 }); assert.deepEqual(j.entries, [{ id: "11", rank: 2, seasonRank: 2 }, { id: "12", rank: 1, seasonRank: 1 }]); assert.ok(!JSON.stringify(j).includes("cdcd")); await app.close(); await up.close(); });

test("the claims view shows owed versus claimed, comes from the rollup endpoint only, and carries no wallet address", async () => {
  const d = Buffer.alloc(72 + 3 * 48); d.writeUInt32LE(0x534d4c43, 0); d[4] = 1; d[5] = 3; d[6] = 3; d[7] = 1; d.writeBigUInt64LE(79n, 8); d.writeBigUInt64LE(30n, 48); d.writeBigUInt64LE(18n, 56);
  for (const [i, owed, done] of [[0, 18n, 1], [1, 12n, 0], [2, 0n, 1]]) { const e = 72 + i * 48; d.fill(0xee, e, e + 32); d.writeBigUInt64LE(owed, e + 32); d[e + 40] = done; }
  const base = await startUpstream(); const rollup = await startUpstream(() => ({ result: { value: { data: [d.toString("base64"), "base64"] } } })); const app = await startApp({ upstream: base, rollup }); const r = await fetch(app.base + "/public/claims/79"); const j = await r.json(); assert.equal(r.status, 200);
  assert.deepEqual({ state: j.state, kind: j.kind, owed: j.owed, claimed: j.claimed, outstanding: j.outstanding }, { state: "recorded", kind: "payout", owed: "30", claimed: "18", outstanding: "12" }); assert.deepEqual(j.entries.map(e => [e.owed, e.status]), [["18", "claimed"], ["12", "outstanding"], ["0", "nothing_owed"]]);
  assert.ok(!JSON.stringify(j).includes("eeee")); assert.equal(base.seen.length, 0, "the base upstream is not asked"); assert.equal(rollup.seen.length, 1); await app.close(); await base.close(); await rollup.close();
  const up = await startUpstream(); const plain = await startApp({ upstream: up }); assert.equal((await fetch(plain.base + "/public/claims/79")).status, 404, "disabled without a rollup endpoint"); await plain.close(); await up.close(); });

test("the client refuses to sign anything that is not this protocol's message for this pubkey and audience", () => {
  const w = wallet(), now = 1_800_000_000; const good = authMessage({ audience: "conclave-api", pubkey: w.pubkey, nonce: "a".repeat(64), issued: now, expires: now + 120 }); assert.deepEqual(checkChallenge(good, { pubkey: w.pubkey, audience: "conclave-api", now }), { audience: "conclave-api" });
  for (const [why, msg] of [["another pubkey", good.replace(w.pubkey, wallet().pubkey)], ["another audience", good.replace("conclave-api", "evil")], ["arbitrary text", "Transfer all my SOL"], ["no domain line", good.replace("CNCL-AUTH-v1\n", "")], ["long validity", authMessage({ audience: "conclave-api", pubkey: w.pubkey, nonce: "a".repeat(64), issued: now, expires: now + 86400 })], ["already expired", authMessage({ audience: "conclave-api", pubkey: w.pubkey, nonce: "a".repeat(64), issued: now - 500, expires: now - 400 })], ["extra line", good + "\nextra: 1"]]) assert.throws(() => checkChallenge(msg, { pubkey: w.pubkey, audience: "conclave-api", now }), /refusing to sign/, why); });

// Test fixtures. All cryptography is real: ed25519 keys from tweetnacl sign the challenges and the server verifies them with the same library's verifier.
// The only stand-in is the UPSTREAM RPC (a real local HTTP server returning fixed JSON-RPC answers and recording what it receives) so the proxy tests need no network and can inspect what the upstream sees.
import http from "node:http"; import nacl from "tweetnacl"; import bs58 from "bs58"; import { createAuth } from "../src/auth.mjs"; import { createApp } from "../src/server.mjs";
export const SECRET = "test-secret-test-secret-test-secret-0123456789"; export const UPSTREAM_KEY = "UPSTREAM-API-KEY-8f3a91c2d4"; export const PROGRAM = "HZ3b6zexePfH5cXT5qaKKHfA8B29xwBGGYgu84WgMdne";
export const wallet = () => { const kp = nacl.sign.keyPair(); return { pubkey: bs58.encode(kp.publicKey), sign: async m => nacl.sign.detached(m, kp.secretKey), signB58: m => bs58.encode(nacl.sign.detached(Buffer.from(m), kp.secretKey)) }; };
export function clock(start = 1_800_000_000) { let t = start; return { now: () => t, ms: () => t, advance: s => { t += s; }, set: s => { t = s; } }; }
export async function listen(server) { await new Promise(r => server.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${server.address().port}`; }
export async function startUpstream(answer = () => ({ result: { context: { slot: 1 }, value: null } })) {
  const seen = []; const srv = http.createServer((req, res) => { const chunks = []; req.on("data", c => chunks.push(c)); req.on("end", () => { const body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); seen.push({ url: req.url, headers: req.headers, body }); const a = answer(body, req.url); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, ...a })); }); });
  const base = await listen(srv); return { base, seen, close: () => new Promise(r => srv.close(r)), url: `${base}/rpc?api-key=${UPSTREAM_KEY}` };
}
export async function startApp({ clk = clock(), upstream, limits = { auth: 1000, open: 1000, player: 1000 }, origins = ["https://app.example"], audience = "conclave-api", secret = SECRET } = {}) {
  const logs = []; const auth = createAuth({ audience, secret, now: clk.now }); const app = createApp({ auth, upstream: upstream.url, programId: PROGRAM, origins, limits, now: clk.ms, log: l => logs.push(l) });
  const base = await listen(app); return { base, auth, logs, clk, close: () => new Promise(r => app.close(r)) };
}
export const post = (base, path, body, headers = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
export async function login(base, w, { tamper } = {}) { const ch = await (await post(base, "/auth/challenge", { pubkey: w.pubkey })).json(); const msg = tamper ? tamper(ch.message) : ch.message; return { ch, res: await post(base, "/auth/token", { pubkey: w.pubkey, nonce: ch.nonce, signature: w.signB58(msg) }) }; }
export async function token(base, w) { const { res } = await login(base, w); const j = await res.json(); if (!j.token) throw new Error("login failed " + JSON.stringify(j)); return j; }

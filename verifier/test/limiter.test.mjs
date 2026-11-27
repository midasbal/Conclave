// The pacing and the rate-limit breaker, against a local HTTP server that behaves like an RPC node that refuses. This tests HTTP behaviour (spacing, what is sent after a 429), not chain data: the chain data in the other tests is real.
import test from "node:test"; import assert from "node:assert/strict"; import http from "node:http";
import { rpcSource, RateLimited, rpcDefaults } from "../lib/chain.mjs";
async function server(handler) { const seen = []; const s = http.createServer((req, res) => { let b = ""; req.on("data", d => b += d); req.on("end", () => { const body = JSON.parse(b); seen.push({ at: Date.now(), method: body.method, params: body.params }); handler(seen.length, body, res); }); }); await new Promise(r => s.listen(0, "127.0.0.1", r)); s.unref(); /* a failing assertion must not leave a server that keeps the process alive */ return { url: `http://127.0.0.1:${s.address().port}`, seen, close: () => new Promise(r => { s.closeAllConnections?.(); s.close(r); }) }; }
const ok = (res, result) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result })); };

test("requests are spaced: one at a time, never closer than the pause", async () => {
  const s = await server((n, b, res) => ok(res, "h")); const src = rpcSource(s.url, { pause: 120 }); await src.genesisHash(); /* the first request pays for the connection, so it is not measured */ for (let i = 0; i < 5; i++) await src.genesisHash(); await s.close();
  const gaps = s.seen.slice(2).map((x, i) => x.at - s.seen[i + 1].at); assert.ok(gaps.every(g => g >= 100), `gaps ${gaps}`);
});
test("endpoint defaults: a rollup (TEE) host is paced four times slower and kept away ten minutes after a refusal", () => { assert.deepEqual(rpcDefaults("devnet-tee.magicblock.app"), { pause: 1000, banMs: 600_000 }); assert.deepEqual(rpcDefaults("api.devnet.solana.com"), { pause: 250, banMs: 60_000 }); });
test("a 429 opens a breaker: nothing more is sent until Retry-After has passed", async () => {
  const s = await server((n, b, res) => { if (n === 1) { res.statusCode = 429; res.setHeader("retry-after", "1"); res.end("slow down"); } else ok(res, "h"); }); const src = rpcSource(s.url, { pause: 10 });
  const t0 = Date.now(); await assert.rejects(() => src.genesisHash(), e => e instanceof RateLimited && e.retryAt >= t0 + 900 && e.retryAt <= t0 + 1500 && /429/.test(e.message));
  for (const m of ["genesisHash", "slot", "account"]) await assert.rejects(() => src[m]("x"), RateLimited); assert.equal(s.seen.length, 1, "nothing was sent while the breaker was open"); assert.ok(src.blockedUntil > Date.now());
  await new Promise(r => setTimeout(r, 1100)); assert.equal(await src.genesisHash(), "h"); assert.equal(s.seen.length, 2); await s.close();
});
test("an answer that says the client is banned opens it too, even with a 200", async () => {
  const s = await server((n, b, res) => { res.statusCode = 200; res.end('{"error":"client temporarily banned"}'); }); const src = rpcSource(s.url, { pause: 10, banMs: 5000 });
  await assert.rejects(() => src.genesisHash(), e => e instanceof RateLimited && e.retryAt - Date.now() > 4000); await assert.rejects(() => src.genesisHash(), RateLimited); assert.equal(s.seen.length, 1); await s.close();
});
test("a server error is retried with backoff, a refusal is not", async () => {
  const s = await server((n, b, res) => { if (n === 1) { res.statusCode = 503; res.end("busy"); } else ok(res, "h"); }); const src = rpcSource(s.url, { pause: 10, retries: 2 }); const t0 = Date.now(); assert.equal(await src.genesisHash(), "h"); assert.ok(Date.now() - t0 >= 900 && s.seen.length === 2); await s.close();
});
test("a signature read asks only for what is newer than the last one seen", async () => {
  const s = await server((n, b, res) => ok(res, [])); const src = rpcSource(s.url, { pause: 10 }); await src.signatures("A"); await src.signatures("A", "BEFORE", "NEWEST"); await s.close();
  assert.deepEqual(s.seen[0].params[1], { limit: 1000, commitment: "finalized" }); assert.deepEqual(s.seen[1].params[1], { limit: 1000, commitment: "finalized", before: "BEFORE", until: "NEWEST" });
});
test("every read is at finalized commitment", async () => {
  const s = await server((n, b, res) => ok(res, b.method === "getProgramAccounts" ? { context: { slot: 5 }, value: [] } : { context: { slot: 5 }, value: null })); const src = rpcSource(s.url, { pause: 10 }); await src.receiptsOwnedBy("P"); await src.account("A"); await src.signatures("A"); await src.transaction("S"); await s.close();
  for (const x of s.seen) assert.equal(x.params.find(p => p && typeof p === "object")?.commitment, "finalized", x.method);
});

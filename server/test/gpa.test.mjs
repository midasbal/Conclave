// The routes that spend the most upstream credit are the two that call getProgramAccounts for a caller: GET /me/strategies (two scans per answer) and POST /me/rpc with that method.
// They are answered from a short cache, identical concurrent calls share one upstream request, and a miss is taken from the caller's bucket and from one bucket for everybody. The upstream is a real local HTTP server that counts what reaches it.
import test from "node:test"; import assert from "node:assert/strict"; import { startUpstream, startApp, wallet, token, clock, post, PROGRAM } from "./helpers.mjs";
const gpaCount = up => up.seen.filter(s => s.body.method === "getProgramAccounts").length;
const setup = async (limits = {}) => { const up = await startUpstream(b => b.method === "getProgramAccounts" ? { result: [] } : { result: { context: { slot: 1 }, value: null } }); const clk = clock(); const app = await startApp({ clk, upstream: up, limits: { auth: 1000, open: 1000, player: 1000, ...limits } }); return { up, app, clk, close: async () => { await app.close(); await up.close(); } }; };
const strategies = (app, t) => fetch(app.base + "/me/strategies", { headers: { authorization: `Bearer ${t.token}` } });
const rpc = (app, t, params, method = "getProgramAccounts") => post(app.base, "/me/rpc", { method, params }, { authorization: `Bearer ${t.token}` });
const scan = n => [PROGRAM, { encoding: "base64", filters: [{ dataSize: 100 + n }] }];

test("/me/strategies: the second call inside the cache window costs no upstream scan at all", async () => {
  const s = await setup({ gpaPlayer: 10, gpaGlobal: 10 }); try { const t = await token(s.app.base, wallet());
    assert.equal((await strategies(s.app, t)).status, 200); assert.equal(gpaCount(s.up), 2, "one answer is two scans: the program's registries and the delegation program's");
    for (let i = 0; i < 20; i++) assert.equal((await strategies(s.app, t)).status, 200); assert.equal(gpaCount(s.up), 2, "twenty more answers, no more scans");
    s.app.clk.advance(61); assert.equal((await strategies(s.app, t)).status, 200); assert.equal(gpaCount(s.up), 4, "after the cache expires one fresh answer is allowed");
  } finally { await s.close(); } });

test("/me/rpc getProgramAccounts: identical calls are one scan; distinct calls run into the caller's bucket and get 429 with Retry-After", async () => {
  const s = await setup({ gpaPlayer: 2, gpaGlobal: 100 }); try { const t = await token(s.app.base, wallet());
    for (let i = 0; i < 6; i++) assert.equal((await rpc(s.app, t, scan(0))).status, 200); assert.equal(gpaCount(s.up), 1);
    assert.equal((await rpc(s.app, t, scan(1))).status, 200); const r = await rpc(s.app, t, scan(2)); assert.equal(r.status, 429); assert.ok(Number(r.headers.get("retry-after")) >= 1); assert.equal((await r.json()).error, "rate_limited"); assert.equal(gpaCount(s.up), 2, "the refused call never reached the upstream");
    assert.equal((await rpc(s.app, t, scan(0))).status, 200, "a cached answer is still served while the bucket is empty");
    s.app.clk.advance(60); assert.equal((await rpc(s.app, t, scan(2))).status, 200, "the bucket refills with time"); assert.equal(gpaCount(s.up), 3);
  } finally { await s.close(); } });

test("one bucket for everybody: many different wallets together cannot exceed the global budget", async () => {
  const s = await setup({ gpaPlayer: 100, gpaGlobal: 3 }); try { const ts = []; for (let i = 0; i < 6; i++) ts.push(await token(s.app.base, wallet()));
    const codes = []; for (const t of ts) codes.push((await strategies(s.app, t)).status); assert.equal(codes[0], 200); assert.ok(codes.slice(1).includes(429), JSON.stringify(codes)); assert.ok(gpaCount(s.up) <= 3, `scans that reached the upstream: ${gpaCount(s.up)}`);
    const r = await rpc(s.app, ts[5], scan(9)); assert.equal(r.status, 429); assert.ok(gpaCount(s.up) <= 3);
  } finally { await s.close(); } });

test("concurrent identical calls share one upstream request", async () => {
  const s = await setup({ gpaPlayer: 100, gpaGlobal: 100 }); try { const ts = []; for (let i = 0; i < 4; i++) ts.push(await token(s.app.base, wallet()));
    const rs = await Promise.all([...ts.map(t => rpc(s.app, t, scan(7))), ...ts.map(t => rpc(s.app, t, scan(7)))]); assert.ok(rs.every(r => r.status === 200)); assert.equal(gpaCount(s.up), 1);
  } finally { await s.close(); } });

test("an upstream error is passed on and never cached; other methods are not touched by these buckets", async () => {
  let fail = true; const up = await startUpstream(b => b.method === "getProgramAccounts" ? (fail ? { error: { code: -32005, message: "busy" } } : { result: [] }) : { result: 5 }); const app = await startApp({ clk: clock(), upstream: up, limits: { auth: 1000, open: 1000, player: 1000, gpaPlayer: 50, gpaGlobal: 50 } });
  try { const t = await token(app.base, wallet()); let r = await rpc(app, t, scan(0)); assert.equal((await r.json()).error.code, -32005); fail = false; r = await rpc(app, t, scan(0)); assert.deepEqual((await r.json()).result, [], "the error was not cached");
    for (let i = 0; i < 30; i++) assert.equal((await rpc(app, t, [], "getBalance")).status, 200); assert.equal(up.seen.filter(x => x.body.method === "getBalance").length, 30, "getBalance is not cached or counted against the scan budget");
  } finally { await app.close(); await up.close(); } });

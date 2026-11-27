// Record-only mode: the public record API starts and serves with NO auth secret and NO upstream, and every route that needs either is refused by name.
// The server under test is the real bin/serve.mjs, a real child process, started with a store built by the real capture loop over recorded devnet responses.
import test from "node:test"; import assert from "node:assert/strict"; import { spawn } from "node:child_process"; import path from "node:path"; import net from "node:net"; import { fileURLToPath } from "node:url";
import { buildStore, load, tmp } from "./api_helpers.mjs"; import { loadConfig } from "../src/config.mjs";
const here = path.dirname(fileURLToPath(import.meta.url)); const SERVE = path.join(here, "..", "bin", "serve.mjs");
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
/** an environment with none of the secrets the full server needs, whatever the test machine has set */
const clean = extra => { const e = { ...process.env }; for (const k of Object.keys(e)) if (/^(CONCLAVE_|RATE_|HOST$|PORT$)/.test(k)) delete e[k]; return { ...e, ...extra }; };
async function start(env) {
  const child = spawn(process.execPath, [SERVE], { env: clean(env), stdio: ["ignore", "pipe", "pipe"] }); let out = ""; child.stdout.on("data", d => { out += d; }); child.stderr.on("data", d => { out += d; });
  const t0 = Date.now(); while (!/listening on/.test(out) && child.exitCode === null && Date.now() - t0 < 20_000) await new Promise(r => setTimeout(r, 25));
  return { child, out: () => out, stop: () => new Promise(r => { if (child.exitCode !== null) return r(); child.on("exit", r); child.kill("SIGKILL"); }) };
}

test("loadConfig: record-only needs a store and nothing else; the full server still needs its secret and upstream", () => {
  const save = { ...process.env }; try {
    for (const k of Object.keys(process.env)) if (/^(CONCLAVE_|RATE_)/.test(k)) delete process.env[k];
    assert.throws(() => loadConfig(), /CONCLAVE_AUTH_SECRET/); process.env.CONCLAVE_AUTH_SECRET = "x".repeat(40); assert.throws(() => loadConfig(), /CONCLAVE_RPC_UPSTREAM/); delete process.env.CONCLAVE_AUTH_SECRET;
    process.env.CONCLAVE_RECORD_ONLY = "1"; assert.throws(() => loadConfig(), /CONCLAVE_STORE_DIR is required/); process.env.CONCLAVE_STORE_DIR = "/data/store";
    const c = loadConfig(); assert.equal(c.recordOnly, true); assert.equal(c.secret, null); assert.equal(c.upstream, null); assert.equal(c.rollupUpstream, null);
    process.env.CONCLAVE_VERIFIER_RPC = "https://rpc.example/?api-key=SEKRET"; assert.equal(loadConfig().upstream, "https://rpc.example/?api-key=SEKRET", "the freshness read uses the daemon's RPC, one secret, not two"); process.env.CONCLAVE_ROLLUP_UPSTREAM = "https://tee.example"; assert.equal(loadConfig().rollupUpstream, null, "no rollup in record-only mode");
  } finally { for (const k of Object.keys(process.env)) if (!(k in save)) delete process.env[k]; Object.assign(process.env, save); }
});

test("the real server starts clean with neither secret set, serves the public record, and refuses every authed, challenge and chain-proxy route by name", async () => {
  const dir = await buildStore(load("all")); const port = await freePort(); const s = await start({ CONCLAVE_RECORD_ONLY: "1", CONCLAVE_STORE_DIR: dir, HOST: "127.0.0.1", PORT: String(port) });
  try {
    assert.equal(s.child.exitCode, null, "it did not exit: " + s.out()); assert.match(s.out(), /mode=record-only/); assert.ok(!/AUTH_SECRET|must be at least 32/.test(s.out()), s.out());
    const get = p => fetch(`http://127.0.0.1:${port}${p}`); const post = (p, b) => fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    let r = await get("/v1/seasons?limit=1"); assert.equal(r.status, 200); assert.ok((await r.json()).seasons.length === 1);
    r = await get("/v1/status"); assert.equal(r.status, 200); const st = await r.json(); assert.equal(st.chain.error, "no_upstream", "no upstream configured: the freshness read says so, it does not fail"); assert.equal(st.store.usable, true);
    r = await get("/v1/openapi.json"); assert.equal(r.status, 200); r = await get("/v1/leaderboard"); assert.equal(r.status, 200);
    r = await get("/health"); assert.equal((await r.json()).recordOnly, true);
    r = await get("/healthz"); const h = await r.json(); assert.ok([200, 503].includes(r.status)); assert.equal(h.checks.length, 6, "the real clock is long past the recorded store, so 503 is the honest answer here; the checks are what matter");
    for (const [m, p, b] of [["POST", "/auth/challenge", { pubkey: "x" }], ["POST", "/auth/token", {}], ["GET", "/me"], ["GET", "/me/strategies"], ["POST", "/me/rpc", { method: "getSlot" }], ["POST", "/public/rpc", { method: "getSlot" }], ["GET", "/public/receipt/1"], ["GET", "/public/claims/1"]]) {
      r = m === "GET" ? await get(p) : await post(p, b ?? {}); const j = await r.json(); assert.equal(r.status, 403, `${m} ${p}`); assert.equal(j.error, "disabled_in_record_only_mode", p); assert.match(j.message, /record-only mode/);
    }
    assert.equal((await get("/nonsense")).status, 404, "an unknown route is still just not found");
  } finally { await s.stop(); }
});

test("the startup line states what is actually configured, and never prints a value", async () => {
  const dir = await buildStore(load("all")); const line = async env => { const port = await freePort(); const s = await start({ CONCLAVE_STORE_DIR: dir, HOST: "127.0.0.1", PORT: String(port), ...env }); try { assert.match(s.out(), /listening on/, s.out()); return s.out().split("\n").find(l => /listening on/.test(l)); } finally { await s.stop(); } };
  const bare = await line({ CONCLAVE_RECORD_ONLY: "1" }); assert.match(bare, /mode=record-only upstream=none secret=none rollup=none /); assert.ok(!/loaded|configured \(/.test(bare.replace("store configured", "")), "nothing is claimed to be loaded: " + bare);
  const withRpc = await line({ CONCLAVE_RECORD_ONLY: "1", CONCLAVE_VERIFIER_RPC: "https://rpc.invalid/?api-key=KEY-THAT-MUST-NOT-PRINT" }); assert.match(withRpc, /mode=record-only upstream=configured \(used only for the \/v1\/status freshness read; not printed\) secret=none /); assert.ok(!/KEY-THAT-MUST-NOT-PRINT|rpc\.invalid/.test(withRpc), withRpc);
  const unused = await line({ CONCLAVE_RECORD_ONLY: "1", CONCLAVE_AUTH_SECRET: "Z".repeat(40), CONCLAVE_ROLLUP_UPSTREAM: "https://tee.invalid" }); assert.match(unused, /upstream=none secret=set but not used rollup=none /); assert.ok(!unused.includes("ZZZZ"), unused);
  const full = await line({ CONCLAVE_AUTH_SECRET: "Q".repeat(40), CONCLAVE_RPC_UPSTREAM: "https://rpc.invalid/?api-key=OTHER-KEY" }); assert.match(full, /mode=full upstream=configured \(not printed\) secret=loaded \(not printed\) rollup=none /); assert.ok(!/QQQQ|OTHER-KEY|rpc\.invalid/.test(full), full);
});

test("without CONCLAVE_RECORD_ONLY the same bare environment refuses to start, saying why", async () => {
  const s = await start({ CONCLAVE_STORE_DIR: tmp() }); try { await new Promise(r => s.child.exitCode !== null ? r() : s.child.on("exit", r)); assert.notEqual(s.child.exitCode, 0); assert.match(s.out(), /CONCLAVE_AUTH_SECRET/); } finally { await s.stop(); }
});

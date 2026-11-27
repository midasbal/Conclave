// A startup RPC failure must not take down the service. These run the REAL entrypoint pieces: supervise() with the real capture daemon (verifier/cli.mjs ingest) and the real record API (bin/serve.mjs) as child processes,
// exactly as deploy/supervisor.mjs plans them, over a store built by the capture loop from recorded devnet responses. The RPC is really broken: a closed local port, or a real local server that answers 401.
// The one change from the plan is the poll interval (one second instead of five minutes), so that the retries can be watched.
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path"; import net from "node:net"; import http from "node:http";
import { supervise } from "../../deploy/supervise.mjs"; import { plan } from "../../deploy/supervisor.mjs";
import { buildStore, storeFiles, load } from "./api_helpers.mjs"; import { DEVNET_GENESIS, PROGRAM_ID } from "../../verifier/lib/chain.mjs";
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const waitFor = async (what, f, ms) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 100)); } };

async function scenario(rpcUrl, { retries, withinMs, errorShape, shown }, during = () => {}) {
  const dir = await buildStore(load("all")); const f = storeFiles(dir); const recordFile = path.join(f.svc, "record.json"); const recordBefore = fs.readFileSync(recordFile); const seasons = f.record().seasons.length;
  const ledgerFile = path.join(dir, DEVNET_GENESIS, PROGRAM_ID, "_service", "ledger.jsonl"); const copiesBefore = fs.readFileSync(ledgerFile, "utf8").split("\n").filter(l => l.includes('"first-copy"')).length;
  const port = await freePort(); const env = { PATH: process.env.PATH, CONCLAVE_VERIFIER_RPC: rpcUrl, CONCLAVE_STORE_DIR: dir, HOST: "127.0.0.1", PORT: String(port) };
  const p = plan(env); const ingest = p.children[0]; ingest.args[ingest.args.indexOf("--poll-seconds") + 1] = "1";
  const lines = []; const sup = supervise(p.children, { log: l => lines.push(l), graceMs: 20_000 }); let ended = null; sup.done.then(c => { ended = c; });
  const base = `http://127.0.0.1:${port}`; const get = async url => { try { const r = await fetch(base + url); return { status: r.status, body: await r.json() }; } catch { return null; } };
  try {
    // the API is up and serving the last known record at once, long before the capture side has any answer
    const early = await waitFor("the API", () => get("/v1/seasons?limit=200"), 15_000); assert.equal(early.status, 200); assert.equal(early.body.seasons.length, seasons);
    await waitFor(`${retries} failed capture attempts`, () => lines.filter(l => /^\[ingest\] .*(retrying in|rate limited: waiting)/.test(l)).length >= retries, withinMs);
    const failed = lines.filter(l => /^\[ingest\] .*cycle failed/.test(l)); assert.ok(failed.length >= retries && failed.every(l => errorShape.test(l)), failed.join("\n"));
    assert.equal(ended, null, "the unit did not exit: " + lines.slice(-6).join("\n")); assert.deepEqual(sup.children.sort(), ["api", "ingest"], "both processes are still running");
    const after = await get("/v1/seasons?limit=200"); assert.equal(after.status, 200); assert.deepEqual(after.body.seasons, early.body.seasons, "the same record, still served");
    const st = (await get("/v1/status")).body; assert.equal(st.store.usable, true); assert.equal(st.store.service.state, "degraded"); assert.equal(st.store.service.lastError.message, shown, "public: the step and a generic reason, no host");
    const h = await get("/healthz"); assert.equal(h.status, 503, "degraded is not healthy"); assert.equal(h.body.checks.find(c => c.name === "no-error-or-alarm").ok, false); assert.equal(h.body.checks.find(c => c.name === "store-readable").ok, true);
    assert.equal((await get("/health")).status, 200, "the deploy-time check still passes, so Railway does not reject the deployment");
    assert.ok(fs.readFileSync(recordFile).equals(recordBefore), "the record on disk is byte for byte the last good one");
    assert.equal(fs.readFileSync(ledgerFile, "utf8").split("\n").filter(l => l.includes('"first-copy"')).length, copiesBefore, "nothing was captured");
    during(lines);
  } finally { sup.shutdown("test over"); assert.equal(await sup.done, 0, "and it still stops cleanly when asked, mid-retry: " + lines.slice(-6).join("\n")); }
}

test("STARTUP, an RPC that refuses the key (HTTP 401): the API serves the last known record and the daemon keeps retrying", { timeout: 90_000 }, async () => {
  let asked = 0; const methods = new Set(); const srv = http.createServer((req, res) => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => { asked++; methods.add(JSON.parse(Buffer.concat(c).toString()).method); res.statusCode = 401; res.end("Unauthorized"); }); });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  try { await scenario(`http://127.0.0.1:${srv.address().port}/?api-key=NOT-A-REAL-KEY-5b1e`, { retries: 3, withinMs: 45_000, errorShape: /getGenesisHash on 127\.0\.0\.1:\d+: HTTP 401/, shown: "checking the RPC's cluster: the RPC answered HTTP 401" }, lines => assert.ok(!lines.join("\n").includes("NOT-A-REAL-KEY"), "the key is in no log line"));
    assert.ok(asked >= 3, `asked ${asked} times`); assert.deepEqual([...methods].sort(), ["getGenesisHash", "getSlot"], "the daemon asked only for the cluster; the one other method is the API's own freshness read for /v1/status"); }
  finally { await new Promise(r => srv.close(r)); }
});

test("STARTUP, an unreachable RPC (nothing listening): the API serves the last known record and the daemon keeps retrying", { timeout: 120_000 }, async () => {
  const dead = await freePort(); // each attempt spends the client's own retries (1 + 2 + 4 + 8 s) before it gives up, so two attempts take about half a minute
  await scenario(`http://127.0.0.1:${dead}/`, { retries: 2, withinMs: 80_000, errorShape: /getGenesisHash on 127\.0\.0\.1:\d+: no usable answer/, shown: "checking the RPC's cluster: the RPC could not be reached" });
});

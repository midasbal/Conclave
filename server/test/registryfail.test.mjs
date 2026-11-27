// A strategy-registry read that fails in the middle of a cycle (not a rate limit). The capture loop and the record API are the real ones, over a store built from REAL recorded devnet responses; the API and /healthz are asked over real HTTP.
// SYNTHETIC: the failure itself did not happen on devnet. It is injected into the registry reads only; every other read answers from the recording.
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path";
import { Ingest } from "../../verifier/lib/ingest.mjs"; import { replay } from "../../verifier/test/recorded.mjs"; import { DEVNET_GENESIS, PROGRAM_ID, registryAddress, RateLimited } from "../../verifier/lib/chain.mjs";
import { createApp } from "../src/server.mjs"; import { createApi } from "../src/api/index.mjs"; import { RecordStore, RulesSource } from "../src/api/store.mjs"; import { createHealth } from "../src/health.mjs";
import { load, tmp, storeFiles, BUILT_AT } from "./api_helpers.mjs"; import { listen } from "./helpers.mjs";

/** the recording, with a switch that makes the registry reads (the batch one and the one-by-one fallback) fail */
function flaky(ids) { const base = replay(load("api")); const regs = new Set(ids().map(id => registryAddress(id, PROGRAM_ID))); const t = { fail: null, batches: [] };
  t.source = { ...base, host: "t", accounts: async a => { t.batches.push(a.length); if (t.fail) throw t.fail(); return base.accounts(a); }, account: async a => { if (t.fail && ids().map(id => registryAddress(id, PROGRAM_ID)).includes(a)) throw t.fail(); return base.account(a); } }; return t; }

async function rig() {
  const dir = tmp(); const f = storeFiles(dir); let known = []; const t = flaky(() => known); let clock = Date.parse(BUILT_AT); const now = () => new Date(clock).toISOString();
  const ing = await new Ingest(t.source, { dir, now, sweepMs: 3600_000 }).open(); await ing.cycle(); known = Object.keys(f.record().registries);
  const store = new RecordStore({ dir, genesis: DEVNET_GENESIS, program: PROGRAM_ID, staleAfterSeconds: 900, now: () => clock }); const api = createApi({ store, rules: new RulesSource(null), genesis: DEVNET_GENESIS, program: PROGRAM_ID, now: () => clock, staleAfterSeconds: 900 });
  const health = createHealth({ dir, genesis: DEVNET_GENESIS, program: PROGRAM_ID, staleAfterSeconds: 900, now: () => clock });
  const app = createApp({ recordOnly: true, programId: PROGRAM_ID, api, health, limits: { api: 100000 } }); const base = await listen(app); app.unref();
  const get = async p => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
  return { dir, f, t, ing, get, known: () => known, tick: ms => { clock += ms; }, close: async () => { ing.close(); await new Promise(r => app.close(r)); } };
}
const statuses = record => Object.values(record.registries).reduce((n, r) => (n[r.status] = (n[r.status] ?? 0) + 1, n), {});

test("a registry read that fails mid-sweep marks the status degraded with the reason at once; the API keeps serving the last record; nothing known is overwritten", async () => {
  const r = await rig(); try {
    assert.ok(r.known().length > 50, "the recording has registries"); const before = fs.readFileSync(path.join(r.f.svc, "record.json")); const stateBefore = JSON.parse(fs.readFileSync(path.join(r.f.svc, "state.json"))).registries;
    assert.ok(!statuses(r.f.record()).unknown); assert.equal((await r.get("/healthz")).status, 200); const strategy = r.known()[0]; const served = (await r.get(`/v1/strategies/${strategy}`)).body.registry; const seasons = (await r.get("/v1/seasons?limit=200")).body.seasons;
    r.t.fail = () => new Error("getAccountInfo on rpc.example: HTTP 503"); r.tick(60_000);
    await assert.rejects(() => r.ing.cycle({ sweep: true }), /^Error: reading the strategy registries: getAccountInfo on rpc\.example: HTTP 503$/);
    const st = r.f.status(); assert.equal(st.state, "degraded"); assert.equal(st.lastError.message, "reading the strategy registries: getAccountInfo on rpc.example: HTTP 503"); assert.equal(st.lastError.rateLimited, null); assert.ok(st.lastError.at);
    // health says so directly, although the record is still perfectly fresh
    const h = await r.get("/healthz"); assert.equal(h.status, 503); assert.deepEqual(h.body.checks.filter(c => !c.ok).map(c => c.name), ["no-error-or-alarm"], "caught by the error itself, not by staleness"); assert.match(h.body.checks.find(c => c.name === "no-error-or-alarm").detail, /reading the strategy registries: .*HTTP 503/);
    const api = await r.get("/v1/status"); assert.equal(api.body.store.service.state, "degraded"); assert.match(api.body.store.service.lastError.message, /strategy registries/); assert.equal(api.body.store.stale, false);
    assert.ok(fs.readFileSync(path.join(r.f.svc, "record.json")).equals(before), "the record is byte for byte the last good one"); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.f.svc, "state.json"))).registries, stateBefore, "no known status was replaced");
    assert.deepEqual((await r.get(`/v1/strategies/${strategy}`)).body.registry, served); assert.deepEqual((await r.get("/v1/seasons?limit=200")).body.seasons, seasons);
  } finally { await r.close(); }
});

test("it stays degraded until that same read succeeds: an ordinary poll afterwards asks for the registries again instead of reporting success without them", async () => {
  const r = await rig(); try {
    r.t.fail = () => new Error("getAccountInfo on rpc.example: HTTP 503"); r.tick(60_000); await assert.rejects(() => r.ing.cycle({ sweep: true }), /strategy registries/);
    for (let i = 0; i < 2; i++) { r.t.batches.length = 0; r.tick(60_000); await assert.rejects(() => r.ing.cycle(), /strategy registries/); assert.deepEqual(r.t.batches, [r.known().length], "a poll, not a sweep, and it still asked for every registry that was not read"); assert.equal(r.f.status().state, "degraded"); }
    r.t.fail = null; r.t.batches.length = 0; r.tick(60_000); const ok = await r.ing.cycle(); assert.equal(ok.sweep, false); assert.deepEqual(r.t.batches, [r.known().length]); assert.equal(r.f.status().state, "ok"); assert.equal(r.f.status().lastError, null); assert.equal((await r.get("/healthz")).status, 200); assert.ok(!statuses(r.f.record()).unknown);
    r.t.batches.length = 0; r.tick(60_000); await r.ing.cycle(); assert.deepEqual(r.t.batches, [], "once read, a poll does not ask again");
  } finally { await r.close(); }
});

test("a rate limit during the registry read is still reported as rate-limited, and is retried the same way", async () => {
  const r = await rig(); try {
    r.t.fail = () => new RateLimited("t", Date.now() + 5000, "HTTP 429"); r.tick(60_000); await assert.rejects(() => r.ing.cycle({ sweep: true }), RateLimited); assert.equal(r.f.status().state, "rate-limited"); assert.ok(r.f.status().lastError.rateLimited > 0); assert.equal((await r.get("/healthz")).status, 503);
    r.t.fail = null; r.t.batches.length = 0; r.tick(60_000); await r.ing.cycle(); assert.deepEqual(r.t.batches, [r.known().length]); assert.equal(r.f.status().state, "ok");
  } finally { await r.close(); }
});

test("a batch read that fails while the one-by-one reads work is not a failure", async () => {
  // the recording holds the batch answer, so each single read is answered with that same recorded account
  const dir = tmp(); const base = replay(load("api")); const batch = new Map(); let singles = 0, refused = 0;
  const first = await new Ingest({ ...base, accounts: async a => { const out = await base.accounts(a); a.forEach((x, i) => batch.set(x, out[i])); return out; } }, { dir: tmp() }).open(); await first.cycle(); first.close(); const want = storeFiles(first.dir).record().registries;
  const ing = await new Ingest({ ...base, accounts: async () => { refused++; throw new Error("batch refused"); }, account: async a => { if (batch.has(a)) { singles++; return batch.get(a); } return base.account(a); } }, { dir }).open(); await ing.cycle(); ing.close();
  assert.equal(refused, 1); assert.equal(singles, Object.keys(want).length, "every registry was read one by one"); assert.deepEqual(storeFiles(dir).record().registries, want, "with the same result"); assert.equal(storeFiles(dir).status().state, "ok"); assert.equal(storeFiles(dir).status().lastError, null);
});

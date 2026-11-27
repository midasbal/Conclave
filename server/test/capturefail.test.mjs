// Every step of a capture cycle that used to fail quietly. The capture loop, the record API and /healthz are the real ones, over REAL recorded devnet responses, asked over real HTTP.
// SYNTHETIC: where a read did not fail on devnet, the failure is injected into that read only. Disk failures (a mirror, a first copy, the published copy) are REAL filesystem errors where one can be made.
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path";
import { Ingest } from "../../verifier/lib/ingest.mjs"; import { replay } from "../../verifier/test/recorded.mjs"; import { verifyStore } from "../../verifier/lib/store.mjs"; import { verifyMirror } from "../../verifier/lib/mirror.mjs"; import { readLedger } from "../../verifier/lib/ledger.mjs"; import { DEVNET_GENESIS as G, PROGRAM_ID as P, poolAddress, RateLimited } from "../../verifier/lib/chain.mjs";
import { createApp } from "../src/server.mjs"; import { createApi } from "../src/api/index.mjs"; import { RecordStore, RulesSource } from "../src/api/store.mjs"; import { createHealth } from "../src/health.mjs"; import { validateAgainst } from "../src/api/validate.mjs"; import { openapi } from "../src/api/schema.mjs";
import { load, tmp, storeFiles, buildStore, BUILT_AT } from "./api_helpers.mjs"; import { listen } from "./helpers.mjs";

const ALL = load("all");
// what a cycle with nothing wrong produces, and one settled season to aim at: its validator comes from history and its token from the pool, and both are inputs to the leaderboard
const CLEAN = storeFiles(await buildStore(ALL)).record(); const TARGET = CLEAN.seasons.find(s => s.status === "final" && s.validator.status === "observed" && s.stakeToken.status === "observed" && !s.flags.length);
const ADDR = TARGET.address, POOL = poolAddress(BigInt(TARGET.season), P), INITPOOL = /\(([1-9A-HJ-NP-Za-km-z]{60,})\)/.exec(TARGET.stakeToken.source)[1];
const DELEGATION_TX = TARGET.history.events.find(e => e.type === "delegated").signature;
const http503 = what => () => { throw new Error(`${what} on rpc.example: HTTP 503`); };

/** fault.signatures(address) and fault.transaction(signature) may throw or answer null; hidden: receipts base does not list yet (so that one can appear later as new) */
async function rig({ backupDir = null, publishTo = null, hidden = [], dir = tmp(), tape = ALL } = {}) {
  let clock = Date.parse(BUILT_AT); const now = () => new Date(clock).toISOString(); const fault = {}; const hide = new Set(hidden); const asked = { signatures: [], transaction: [] }; const base = replay(tape);
  const source = { ...base, host: "t",
    receiptsOwnedBy: async o => { const all = await base.receiptsOwnedBy(o); const out = all.filter(a => !hide.has(a.address)); out.contextSlot = all.contextSlot; return out; },
    signatures: async (a, b, u) => { asked.signatures.push(a); const f = fault.signatures?.(a); return f !== undefined ? f : base.signatures(a, b, u); },
    transaction: async s => { asked.transaction.push(s); const f = fault.transaction?.(s); return f !== undefined ? f : base.transaction(s); } };
  const ing = await new Ingest(source, { dir, now, sweepMs: 3600_000, backupDir, publishTo }).open(); const f = storeFiles(dir); const root = path.join(dir, G, P);
  const store = new RecordStore({ dir, genesis: G, program: P, staleAfterSeconds: 900, now: () => clock }); const api = createApi({ store, rules: new RulesSource(null), genesis: G, program: P, now: () => clock, staleAfterSeconds: 900 });
  const app = createApp({ recordOnly: true, programId: P, api, health: createHealth({ dir, genesis: G, program: P, staleAfterSeconds: 900, now: () => clock }), limits: { api: 100000 } }); const url = await listen(app); app.unref();
  const get = async p => { const r = await fetch(url + p); return { status: r.status, body: await r.json() }; };
  const r = { dir, root, ing, f, fault, hide, asked, get,
    cycle: o => { clock += 60_000; asked.signatures.length = asked.transaction.length = 0; return ing.cycle(o); },
    recordBytes: () => fs.readFileSync(path.join(f.svc, "record.json")), firstCopy: a => path.join(root, a, "first-final.json"), observed: a => JSON.parse(fs.readFileSync(path.join(root, a, "observed.json"))),
    onLedger: a => readLedger(path.join(f.svc, "ledger.jsonl")).entries.filter(e => e.type === "first-copy" && e.address === a).length,
    served: async () => (await get("/v1/seasons?limit=200")).body.seasons, season: async () => get(`/v1/seasons/${TARGET.season}`),
    failing: async () => { const h = await get("/healthz"); return { status: h.status, bad: h.body.checks.filter(c => !c.ok).map(c => c.name), detail: h.body.checks.find(c => c.name === "no-error-or-alarm").detail }; },
    close: async () => { ing.close(); await new Promise(x => app.close(x)); } };
  return r;
}
/** degraded, with the reason, in the status, in /v1/status and as the one failing health check */
async function assertDegraded(r, reason) {
  const st = r.f.status(); assert.equal(st.state, "degraded"); assert.match(st.lastError.message, reason); assert.equal(st.lastError.rateLimited, null);
  const h = await r.failing(); assert.equal(h.status, 503); assert.deepEqual(h.bad, ["no-error-or-alarm"], "caught by the error itself, not by staleness"); assert.match(h.detail, /last cycle failed/);
  const s = (await r.get("/v1/status")).body; assert.equal(s.store.usable, true); assert.equal(s.store.stale, false); assert.equal(s.store.service.state, "degraded"); assert.match(s.store.service.lastError.message, reason);
}
const assertHealthy = async r => { assert.equal(r.f.status().state, "ok"); assert.equal(r.f.status().lastError, null); assert.equal((await r.failing()).status, 200); };
const recoveredSeason = async r => { const s = (await r.season()).body; const text = JSON.stringify(s); assert.equal((await r.season()).status, 200); assert.ok(text.includes(TARGET.validator.key), "the validator is back"); const rec = r.f.record().seasons.find(x => x.address === ADDR); assert.equal(rec.validator.status, "observed"); assert.equal(rec.stakeToken.mint, TARGET.stakeToken.mint); assert.equal(rec.history.problem, null); };

// ---- transaction history ----
test("HISTORY, a new receipt: the first copy is saved although the read fails, the last record is kept and served, the status says why, and the next poll retries", async () => {
  const r = await rig({ hidden: [ADDR] }); try {
    await r.cycle(); await assertHealthy(r); const before = r.recordBytes(); const served = await r.served(); r.hide.clear();
    r.fault.signatures = a => a === ADDR ? http503("getSignaturesForAddress")() : undefined;
    await assert.rejects(() => r.cycle(), /reading the transaction history of/); await assertDegraded(r, /^reading the transaction history of \w+: getSignaturesForAddress on rpc\.example: HTTP 503$/);
    assert.ok(fs.existsSync(r.firstCopy(ADDR)), "THE FIRST COPY IS ON DISK"); assert.equal(r.onLedger(ADDR), 1);
    assert.ok(r.recordBytes().equals(before), "the record is byte for byte the last good one"); assert.deepEqual(await r.served(), served); assert.equal((await r.season()).status, 404, "the new season is not published without its history");
    await assert.rejects(() => r.cycle(), /transaction history/); assert.ok(r.asked.signatures.includes(ADDR), "an ordinary poll asks for it again although the bytes did not change"); assert.equal(r.f.status().state, "degraded");
    r.fault.signatures = undefined; assert.equal((await r.cycle()).sweep, false); await assertHealthy(r); await recoveredSeason(r); assert.equal(r.onLedger(ADDR), 1, "still once");
  } finally { await r.close(); }
});
test("HISTORY, a known receipt on a sweep: what was already read is kept, nothing is overwritten with a problem or unknown marker, and it stays degraded until the read succeeds", async () => {
  const r = await rig(); try {
    await r.cycle(); const before = r.recordBytes(); const season = (await r.season()).body; const history = r.observed(ADDR).history; assert.ok(history.events.length >= 2);
    r.fault.signatures = a => a === ADDR ? http503("getSignaturesForAddress")() : undefined;
    await assert.rejects(() => r.cycle({ sweep: true }), /transaction history/); await assertDegraded(r, /reading the transaction history of/);
    assert.deepEqual(r.observed(ADDR).history, history, "the history already read is untouched"); assert.ok(r.recordBytes().equals(before)); assert.deepEqual((await r.season()).body.history ?? null, season.history ?? null); assert.equal(r.f.record().seasons.find(x => x.address === ADDR).history.problem, null);
    await assert.rejects(() => r.cycle(), /transaction history/); r.fault.signatures = undefined; await r.cycle(); assert.deepEqual(r.asked.signatures.filter(a => a === ADDR), [ADDR], "the one receipt that failed is read again"); await assertHealthy(r); await recoveredSeason(r);
  } finally { await r.close(); }
});
test("HISTORY, down for every receipt on an empty store: every first copy is still captured, the reads stop being hammered after three failures, and everything is published once they work", async () => {
  const r = await rig(); try {
    r.fault.signatures = () => http503("getSignaturesForAddress")();
    await assert.rejects(() => r.cycle(), /and \d+ more read failure\(s\)/); assert.equal(r.f.status().state, "degraded");
    assert.equal(verifyStore(r.dir, G, P).copies, CLEAN.archive.copies, "EVERY first copy was saved while history was down"); assert.ok(verifyStore(r.dir, G, P).ok);
    assert.ok(r.asked.signatures.length <= 6, `after three receipts in a row the cycle stops asking: ${r.asked.signatures.length} signature requests for ${CLEAN.seasons.length} seasons`);
    assert.ok(!fs.existsSync(path.join(r.f.svc, "record.json")), "nothing is published from a cycle that could not read"); assert.equal((await r.get("/v1/seasons")).status, 503);
    r.fault.signatures = undefined; await r.cycle(); assert.equal(r.f.status().lastError, null); const strip = rec => rec.seasons.map(s => [s.season, s.status, s.validator.key, s.stakeToken.mint, s.history.problem]); assert.deepEqual(strip(r.f.record()), strip(CLEAN));
  } finally { await r.close(); }
});
test("HISTORY, a transaction the node lists and does not serve is a failed read", async () => {
  const r = await rig({ hidden: [ADDR] }); try {
    await r.cycle(); const before = r.recordBytes(); r.hide.clear(); r.fault.transaction = s => s === DELEGATION_TX ? null : undefined;
    await assert.rejects(() => r.cycle(), /did not serve 1 listed transaction/); await assertDegraded(r, /reading the transaction history of \w+: base did not serve 1 listed transaction\(s\)/); assert.ok(r.recordBytes().equals(before)); assert.ok(fs.existsSync(r.firstCopy(ADDR)));
    r.fault.transaction = undefined; await r.cycle(); await assertHealthy(r); await recoveredSeason(r);
  } finally { await r.close(); }
});

// ---- the pool (stake token) ----
test("POOL: a read that fails is not published as an unknown token; the last record is kept and served; the next poll retries", async () => {
  const r = await rig({ hidden: [ADDR] }); try {
    await r.cycle(); const before = r.recordBytes(); const served = await r.served(); r.hide.clear(); r.fault.signatures = a => a === POOL ? http503("getSignaturesForAddress")() : undefined;
    await assert.rejects(() => r.cycle(), /reading the pool's transactions/); await assertDegraded(r, /^reading the pool's transactions for \w+: getSignaturesForAddress on rpc\.example: HTTP 503$/);
    assert.ok(r.recordBytes().equals(before)); assert.deepEqual(await r.served(), served); assert.equal(r.observed(ADDR).pool, undefined, "nothing is remembered about the pool"); assert.ok(fs.existsSync(r.firstCopy(ADDR)));
    await assert.rejects(() => r.cycle(), /pool's transactions/); assert.ok(r.asked.signatures.includes(POOL));
    r.fault.signatures = undefined; await r.cycle(); await assertHealthy(r); await recoveredSeason(r);
  } finally { await r.close(); }
});
test("POOL: an InitPool transaction the node does not serve is 'not known', never 'there is none'", async () => {
  const r = await rig({ hidden: [ADDR] }); try {
    await r.cycle(); const before = r.recordBytes(); r.hide.clear(); r.fault.transaction = s => s === INITPOOL ? null : undefined;
    await assert.rejects(() => r.cycle(), /whether it holds an InitPool is not known/); await assertDegraded(r, /reading the pool's transactions for \w+: base did not serve 1 listed transaction\(s\) of the pool/); assert.equal(r.observed(ADDR).pool, undefined); assert.ok(r.recordBytes().equals(before));
    r.fault.transaction = undefined; await r.cycle(); await assertHealthy(r); await recoveredSeason(r);
  } finally { await r.close(); }
});

// ---- what must survive a failing cycle ----
test("a delegation record, which can only be seen while a receipt is delegated, is kept even when a rate limit stops the cycle at the next read", async () => {
  const stage = load("provisional"); const r = await rig({ tape: stage }); try {
    r.fault.signatures = () => { throw new RateLimited("t", Date.now() + 5000, "HTTP 429"); }; await assert.rejects(() => r.cycle(), RateLimited); assert.equal(r.f.status().state, "rate-limited");
    assert.equal(r.observed(stage.address).delegationRecords.length, 1, "the sighting is on disk");
  } finally { await r.close(); }
});
test("a first copy whose ledger line cannot be written fails the cycle, does not stop the others, and gets its line on the next cycle without a restart", async () => {
  const r = await rig(); try {
    const real = r.ing.store.ledger.append.bind(r.ing.store.ledger); let refused = false; r.ing.store.ledger.append = e => { if (!refused && e.type === "first-copy" && e.address === ADDR) { refused = true; throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }); } return real(e); };
    await assert.rejects(() => r.cycle(), /processing \w+: ENOSPC/); assert.equal(r.f.status().state, "degraded"); assert.match(r.f.status().lastError.message, /ENOSPC/);
    assert.equal(verifyStore(r.dir, G, P).copies, CLEAN.archive.copies, "every other first copy was captured"); assert.equal(r.onLedger(ADDR), 0);
    await r.cycle(); await assertHealthy(r); assert.equal(r.onLedger(ADDR), 1); const v = verifyStore(r.dir, G, P); assert.ok(v.ok, v.problems.join("; ")); await recoveredSeason(r);
  } finally { await r.close(); }
});

test("a rate limit on the history or pool read of a new receipt cannot cost its first copy: the copy is saved before either is asked for", async () => {
  for (const target of [ADDR, POOL]) { const r = await rig({ hidden: [ADDR] }); try {
    await r.cycle(); const before = r.recordBytes(); r.hide.clear(); r.fault.signatures = a => { if (a === target) throw new RateLimited("t", Date.now() + 5000, "HTTP 429"); };
    await assert.rejects(() => r.cycle(), RateLimited); assert.equal(r.f.status().state, "rate-limited"); assert.ok(fs.existsSync(r.firstCopy(ADDR)), "THE FIRST COPY IS ON DISK"); assert.equal(r.onLedger(ADDR), 1); assert.ok(r.recordBytes().equals(before));
    r.fault.signatures = undefined; await r.cycle(); await assertHealthy(r); await recoveredSeason(r);
  } finally { await r.close(); } }
});

// ---- writing the record ----
test("RECORD WRITE: a failed write marks the status degraded with the reason; the last record stays on disk and is served; it recovers", async () => {
  const r = await rig({ hidden: [ADDR] }); try {
    await r.cycle(); const before = r.recordBytes(); const served = await r.served(); r.hide.clear();
    const real = r.ing.store.writeService.bind(r.ing.store); r.ing.store.writeService = (name, v) => { if (name === "record.json") throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }); return real(name, v); };
    await assert.rejects(() => r.cycle(), /^Error: writing the record: ENOSPC/); await assertDegraded(r, /^writing the record: ENOSPC: no space left on device/); assert.ok(r.recordBytes().equals(before)); assert.deepEqual(await r.served(), served); assert.ok(fs.existsSync(r.firstCopy(ADDR)));
    r.ing.store.writeService = real; await r.cycle(); await assertHealthy(r); await recoveredSeason(r);
  } finally { await r.close(); }
});
test("RECORD WRITE, real filesystem errors: record.json that cannot be replaced, and an --out path that cannot be written, are both reported", async () => {
  const blocker = path.join(tmp(), "a-file"); fs.writeFileSync(blocker, "x"); const r = await rig({ publishTo: path.join(blocker, "out.json") }); try {
    await assert.rejects(() => r.cycle(), /^Error: writing the published copy of the record \(--out\): E/); assert.equal(r.f.status().state, "degraded"); assert.match(r.f.status().lastError.message, /--out/); assert.equal((await r.failing()).status, 503);
    fs.rmSync(blocker); await r.cycle(); await assertHealthy(r);
    const rf = path.join(r.f.svc, "record.json"); const keep = fs.readFileSync(rf); fs.rmSync(rf); fs.mkdirSync(rf);
    await assert.rejects(() => r.cycle(), /^Error: writing the record: EISDIR/); assert.equal(r.f.status().state, "degraded"); assert.match(r.f.status().lastError.message, /^writing the record: EISDIR/);
    fs.rmdirSync(rf); fs.writeFileSync(rf, keep); assert.deepEqual((await r.failing()).bad, ["no-error-or-alarm"]); await r.cycle(); await assertHealthy(r);
  } finally { await r.close(); }
});

// ---- the backup mirror ----
test("MIRROR: a sync that fails raises the backup alarm health reads; the good record is still published; every cycle retries; a later success clears it", async () => {
  const blocker = path.join(tmp(), "a-file"); const backupDir = path.join(blocker, "mirror"); const r = await rig({ backupDir, hidden: [ADDR] }); try {
    await r.cycle(); await assertHealthy(r); r.hide.clear(); fs.rmSync(blocker, { recursive: true, force: true }); fs.writeFileSync(blocker, "x"); // a REAL failure: the mirror's parent is now a file
    const done = await r.cycle(); assert.ok(done.record, "the cycle itself succeeds: the record is right"); const st = r.f.status(); assert.equal(st.state, "backup-alarm"); assert.equal(st.lastError, null);
    assert.deepEqual(st.backup.alarms.map(a => a.kind), ["backup-sync-failed"]); assert.match(st.backup.alarms[0].detail, /the backup mirror could not be synced: E(NOTDIR|EXIST)/);
    const h = await r.failing(); assert.equal(h.status, 503); assert.deepEqual(h.bad, ["no-error-or-alarm"]); assert.match(h.detail, /1 backup alarm/); assert.equal((await r.season()).status, 200, "the new season is served");
    const api = (await r.get("/v1/status")).body; assert.deepEqual(api.store.alarms.backup.map(a => [a.kind, a.address]), [["backup-sync-failed", null]]); assert.equal(validateAgainst("Status", api), null, "the answer still fits the API's contract");
    await r.cycle(); await r.cycle(); assert.equal(r.f.status().backup.alarms.length, 1, "one alarm, not one per attempt"); assert.equal(readLedger(path.join(r.f.svc, "ledger.jsonl")).entries.filter(e => e.type === "backup-alarm").length, 1, "and one ledger line for the episode");
    fs.rmSync(blocker); const rec = await r.cycle(); assert.equal(rec.sweep, false); assert.equal(rec.processed, 0, "nothing changed on base, and the sync was still retried"); await assertHealthy(r); assert.deepEqual(r.f.status().backup.alarms, []);
    const v = verifyMirror(path.join(backupDir, G, P), G, P, r.root); assert.ok(v.ok, v.problems.join("; "));
  } finally { await r.close(); }
});
test("MIRROR: an alarm about what a sync FOUND is never cleared by a later successful sync", async () => {
  const backupDir = tmp(); const r = await rig({ backupDir }); try {
    await r.cycle(); await assertHealthy(r); fs.writeFileSync(path.join(backupDir, G, P, ADDR, "first-final.json"), "{}"); await r.cycle({ sweep: true }); await r.cycle({ sweep: true });
    assert.deepEqual(r.f.status().backup.alarms.map(a => a.kind), ["backup-mismatch"]); assert.equal((await r.failing()).status, 503);
  } finally { await r.close(); }
});

test("MIRROR on a full disk, where the alarm's own ledger line cannot be written either: the sync is still retried on the next quiet poll", async () => {
  const blocker = path.join(tmp(), "a-file"); const backupDir = path.join(blocker, "mirror"); const r = await rig({ backupDir }); try {
    await r.cycle(); await assertHealthy(r); fs.rmSync(blocker, { recursive: true, force: true }); fs.writeFileSync(blocker, "x");
    const real = r.ing.store.ledger.append.bind(r.ing.store.ledger); r.ing.store.ledger.append = e => { if (e.type === "backup-alarm") throw new Error("ENOSPC"); return real(e); };
    await r.cycle({ sweep: true }); assert.equal(r.f.status().state, "backup-alarm"); assert.equal((await r.failing()).status, 503);
    fs.rmSync(blocker); const next = await r.cycle(); assert.equal(next.sweep, false); assert.equal(next.processed, 0); await assertHealthy(r); assert.ok(fs.existsSync(path.join(backupDir, G, P, ADDR, "first-final.json")), "the mirror is written again");
  } finally { await r.close(); }
});

// ---- the first copies themselves ----
test("DAMAGED FIRST COPY: the season does not silently vanish from the record: the last record is kept and served, and the status names the damage", async () => {
  const r = await rig(); try {
    await r.cycle(); const before = r.recordBytes(); const good = fs.readFileSync(r.firstCopy(ADDR)); fs.writeFileSync(r.firstCopy(ADDR), "{damaged");
    await assert.rejects(() => r.cycle({ sweep: true }), /the first copy of \w+ on disk is damaged/); await assertDegraded(r, /^the first copy of \w+ on disk is damaged: the first copy cannot be parsed/); assert.ok(r.recordBytes().equals(before)); assert.equal((await r.season()).status, 200);
    fs.writeFileSync(r.firstCopy(ADDR), good); await r.cycle(); assert.equal(r.f.status().state, "ok", "publishing resumes"); assert.equal((await r.season()).status, 200);
    assert.deepEqual(r.f.record().seasons.find(x => x.address === ADDR).flags.filter(f => !f.info).map(f => f.kind), ["archive-damaged"], "the flag stays, as every alarm flag does"); assert.equal((await r.failing()).status, 503); assert.match((await r.failing()).detail, /1 receipt flag/);
  } finally { await r.close(); }
});
test("a first copy that cannot be READ (a real disk error) is a failed read, not damage: no flag is raised, and it recovers completely", async () => {
  const r = await rig(); try {
    await r.cycle(); const before = r.recordBytes(); const good = fs.readFileSync(r.firstCopy(ADDR)); fs.rmSync(r.firstCopy(ADDR)); fs.mkdirSync(r.firstCopy(ADDR));
    await assert.rejects(() => r.cycle({ sweep: true }), /processing \w+: EISDIR/); assert.equal(r.f.status().state, "degraded"); assert.match(r.f.status().lastError.message, /EISDIR/); assert.ok(r.recordBytes().equals(before)); assert.equal((await r.season()).status, 200);
    assert.ok(!fs.existsSync(path.join(r.root, ADDR, "flags.json")), "no permanent flag for a passing disk error");
    fs.rmdirSync(r.firstCopy(ADDR)); fs.writeFileSync(r.firstCopy(ADDR), good); await r.cycle(); await assertHealthy(r);
  } finally { await r.close(); }
});

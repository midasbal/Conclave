// /v1/status and /healthz are public. A failure there names the step and a generic reason; paths, host names and whatever an RPC or the operating system said stay in the service's log.
// The disk errors here are REAL filesystem errors, whose messages really do carry paths. The capture loop, the API and /healthz are the real ones over recorded devnet responses, asked over real HTTP.
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path";
import { Ingest } from "../../verifier/lib/ingest.mjs"; import { replay } from "../../verifier/test/recorded.mjs"; import { DEVNET_GENESIS as G, PROGRAM_ID as P, RateLimited } from "../../verifier/lib/chain.mjs";
import { publicFailure, publicBackupAlarm, publicCode, GENERIC_REASON } from "../../verifier/lib/public_error.mjs";
import { createApp } from "../src/server.mjs"; import { createApi } from "../src/api/index.mjs"; import { RecordStore, RulesSource } from "../src/api/store.mjs"; import { createHealth } from "../src/health.mjs";
import { load, tmp, storeFiles, BUILT_AT, stringsOf } from "./api_helpers.mjs"; import { listen } from "./helpers.mjs";

const ALL = load("all");
async function rig({ backupDir = null } = {}) {
  const dir = tmp(); const f = storeFiles(dir); let clock = Date.parse(BUILT_AT); const log = []; const healthLog = [];
  const ing = await new Ingest(replay(ALL), { dir, now: () => new Date(clock).toISOString(), backupDir, log: m => log.push(m) }).open();
  const store = new RecordStore({ dir, genesis: G, program: P, staleAfterSeconds: 900, now: () => clock }); const api = createApi({ store, rules: new RulesSource(null), genesis: G, program: P, now: () => clock, staleAfterSeconds: 900 });
  const app = createApp({ recordOnly: true, programId: P, api, health: createHealth({ dir, genesis: G, program: P, staleAfterSeconds: 900, now: () => clock, log: m => healthLog.push(m) }), limits: { api: 100000 } }); const url = await listen(app); app.unref();
  const get = async p => { const r = await fetch(url + p); const text = await r.text(); return { status: r.status, text, body: JSON.parse(text) }; };
  /** the daemon's own loop, until it has logged one failed cycle */
  const runUntilFailure = async () => { const stop = new AbortController(); const before = log.length; const watch = setInterval(() => { if (log.slice(before).some(l => /cycle failed|rate limited/.test(l))) stop.abort(); }, 10); await ing.run({ pollMs: 20, signal: stop.signal, onCycle: () => stop.abort() }); clearInterval(watch); };
  return { dir, f, ing, log, healthLog, get, runUntilFailure, cycle: () => { clock += 60_000; return ing.cycle(); }, close: async () => { ing.close(); await new Promise(x => app.close(x)); } };
}
/** nothing in any string of a public answer may carry the folder, any absolute path, or a temporary file name */
const assertNoHostDetail = (answer, secrets) => { for (const s of stringsOf(answer.body)) { for (const x of secrets) assert.ok(!s.includes(x), `"${x}" is in public text: ${s}`); assert.ok(!/(^|[\s'"(])\/(tmp|data|root|app|home|var|usr)\//.test(s), `an absolute path is in public text: ${s}`); } for (const x of secrets) assert.ok(!answer.text.includes(x), `"${x}" is in the response body`); };

test("A DISK ERROR CARRYING A PATH: the whole path is in the service's log and in status.json, and in no public answer", async () => {
  const r = await rig(); try {
    await r.cycle(); const rf = path.join(r.f.svc, "record.json"); const keep = fs.readFileSync(rf); fs.rmSync(rf); fs.mkdirSync(rf); // a real EISDIR from rename(), which names both paths
    await r.runUntilFailure(); fs.rmdirSync(rf); fs.writeFileSync(rf, keep);
    const line = r.log.find(l => /cycle failed/.test(l)); assert.ok(line.includes(rf) && /EISDIR/.test(line), "the log keeps the full message, path and all: " + line); assert.ok(r.f.status().lastError.message.includes(rf), "and so does status.json, on the server's own disk");
    const status = await r.get("/v1/status"); assert.equal(status.status, 200); assert.equal(status.body.store.service.state, "degraded"); assert.equal(status.body.store.service.lastError.message, "writing the record: a file could not be read or written"); assertNoHostDetail(status, [r.dir, "record.json", ".tmp", "rename", "EISDIR"]);
    const health = await r.get("/healthz"); assert.equal(health.status, 503); assert.equal(health.body.checks.find(c => c.name === "no-error-or-alarm").detail, "last cycle failed: writing the record: a file could not be read or written"); assertNoHostDetail(health, [r.dir, ".tmp", "rename", "EISDIR"]);
    assert.ok(r.healthLog.some(l => l.includes(rf)), "the health check logs what it would not show"); const n = r.healthLog.length; await r.get("/healthz"); assert.equal(r.healthLog.length, n, "once per distinct message, however often it is asked");
  } finally { await r.close(); }
});

test("a failed mirror sync: the path is in the log, the public alarm names the step and a generic reason", async () => {
  const blocker = path.join(tmp(), "a-file"); fs.writeFileSync(blocker, "x"); const r = await rig({ backupDir: path.join(blocker, "mirror") }); try {
    await r.cycle(); assert.ok(r.log.some(l => /BACKUP ALARM backup-sync-failed/.test(l) && l.includes(blocker)), r.log.join("|")); assert.ok(r.f.status().backup.alarms[0].detail.includes(blocker));
    const status = await r.get("/v1/status"); assert.deepEqual(status.body.store.alarms.backup, [{ kind: "backup-sync-failed", address: null, detail: "the backup mirror could not be synced: a file could not be read or written" }]); assertNoHostDetail(status, [blocker, "a-file", "ENOTDIR"]); assertNoHostDetail(await r.get("/healthz"), [blocker, "a-file"]);
  } finally { await r.close(); }
});

test("an RPC's own error text, whatever it holds, never reaches the public; a rate limit's host stays in the log", async () => {
  const r = await rig(); try {
    await r.cycle(); const poison = "getProgramAccounts on rpc.internal.example: open /data/store/secret.pem failed ?api-key=SECRET-123"; r.ing.source.receiptsOwnedBy = async () => { throw new Error(poison); }; // SYNTHETIC: an RPC error body can say anything
    await r.runUntilFailure(); assert.ok(r.log.some(l => l.includes(poison)));
    for (const p of ["/v1/status", "/healthz"]) assertNoHostDetail(await r.get(p), ["rpc.internal.example", "secret.pem", "SECRET-123", "api-key"]);
    assert.equal((await r.get("/v1/status")).body.store.service.lastError.message, "listing the receipts: the RPC returned an error");
    r.ing.source.receiptsOwnedBy = async () => { throw new RateLimited("rpc.internal.example", Date.now() + 50, "HTTP 429"); }; await r.runUntilFailure(); assert.ok(r.log.some(l => /rate limited: waiting \d+ s \(rpc\.internal\.example is rate limiting/.test(l)), "the log still says who and why");
    const s = await r.get("/v1/status"); assert.equal(s.body.store.service.lastError.message, "listing the receipts: the RPC rate limited the request"); assertNoHostDetail(s, ["rpc.internal.example"]);
    r.ing.source.receiptsOwnedBy = replay(ALL).receiptsOwnedBy; r.ing.source.accounts = async () => { throw new RateLimited("rpc.internal.example", Date.now() + 50, "HTTP 429"); }; r.ing.state.lastSweep = null; await r.runUntilFailure();
    assert.equal((await r.get("/v1/status")).body.store.service.lastError.message, "reading the strategy registries: the RPC rate limited the request", "the phase says what was being read");
  } finally { await r.close(); }
});

test("health's own failures: a real operating system error that names a path shows only its code", () => {
  const gone = path.join(tmp(), "no-such-volume"); const log = []; const out = createHealth({ dir: gone, genesis: G, program: P, log: m => log.push(m) })();
  const text = JSON.stringify(out); assert.ok(!text.includes(gone) && !text.includes("no-such-volume"), text); assert.equal(out.checks.find(c => c.name === "volume-free-space").detail, "could not read the volume: ENOENT"); assert.ok(log.some(l => l.includes(gone)), "the log has the path: " + log.join("|"));
});

test("the public text is built from fixed phrases only: nothing of a hostile message survives, in any step, known or not", () => {
  const A = "ByrFNg4AXs5ooSEu5PGR6MHLKUAKSzpUUCvHtxxkz4Hh"; const hostile = "EACCES: permission denied, open '/data/store/x' host-7f3a.internal https://u:p@rpc.example/?api-key=K\nstack at /app/verifier/lib/ingest.mjs:1";
  const prefixes = [`reading the transaction history of ${A}: `, `the transaction history of ${A} was not read: `, `reading the pool's transactions for ${A}: `, `the pool's transactions for ${A} were not read: `, `the first copy of ${A} on disk is damaged: `, `processing ${A}: `, "reading the strategy registries: ", "writing the record: ", "writing the published copy of the record (--out): ", "getGenesisHash on h: ", "getProgramAccounts on h: ", "", "something new: ", "processing /data/store: ", "reading the transaction history of /etc/passwd: "];
  const grammar = /^(the capture cycle|processing the receipts|checking the RPC's cluster|listing the receipts|reading transaction history|reading the stake token pool|reading the strategy registries|processing a receipt|reading a first final copy|writing the record|writing the published copy of the record)( \(receipt [1-9A-HJ-NP-Za-km-z]{32,44}\))?: [A-Za-z0-9' ()]+$/;
  for (const p of prefixes) for (const tail of [hostile, "x /data/y", "getSlot on h: HTTP 503 /data/z", `${hostile} (and 4 more read failure(s) in this cycle)`]) {
    const out = publicFailure(p + tail); assert.match(out, grammar, p + " -> " + out); for (const x of ["/data", "/app", "/etc", "internal", "api-key", "rpc.example", "stack", "passwd", "permission denied"]) assert.ok(!out.includes(x), `${x} survived: ${out}`); }
  assert.equal(publicFailure("the sky fell"), `the capture cycle: ${GENERIC_REASON}`); assert.equal(publicFailure("h is rate limiting this client (HTTP 429)", { rateLimited: true, phase: "listing the receipts" }), "listing the receipts: the RPC rate limited the request"); assert.equal(publicFailure("x", { phase: "/data/store: listing" }), `the capture cycle: ${GENERIC_REASON}`, "a phase is only ever one of the fixed words"); assert.equal(publicFailure("writing the record: EIO", { phase: "listing the receipts" }), "writing the record: a file could not be read or written", "the message's own step wins"); assert.equal(publicFailure(undefined), `the capture cycle: ${GENERIC_REASON}`);
  assert.equal(publicFailure(`processing ${A}: EISDIR: illegal operation on a directory, read (and 2 more read failure(s) in this cycle)`), `processing a receipt (receipt ${A}): a file could not be read or written (and 2 more read failure(s) in this cycle)`);
  assert.equal(publicFailure(`the transaction history of ${A} was not read: 3 receipts in a row failed`), `reading transaction history (receipt ${A}): not attempted after repeated failures`);
  assert.equal(publicFailure("this RPC serves cluster 4uhc, not the expected EtWT"), "checking the RPC's cluster: the RPC serves another cluster"); assert.equal(publicFailure("writing the record: ENOSPC: no space left on device, write"), "writing the record: the disk is full");
  for (const a of [{ kind: "backup-mismatch", address: A, detail: hostile }, { kind: "flags-regressed", address: "/data/x", detail: hostile }, { kind: "ledger-diverged", detail: hostile }, { kind: "backup-sync-failed", detail: `the backup mirror could not be synced: ${hostile}` }, { kind: "/data/new-kind", detail: hostile }, { kind: "constructor", detail: hostile }]) { const o = JSON.stringify(publicBackupAlarm(a)); for (const x of ["/data", "internal", "api-key", "permission denied"]) assert.ok(!o.includes(x), o); }
  assert.equal(publicCode({ code: "ENOENT" }), "ENOENT"); assert.equal(publicCode({ code: "/data/x" }), "unreadable"); assert.equal(publicCode(new Error("/data/x")), "unreadable");
});

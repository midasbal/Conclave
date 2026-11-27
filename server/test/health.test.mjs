// /healthz and createHealth: 200 only when every condition holds. The store is REAL (built by the capture loop over recorded devnet responses); a failing condition is made by editing a COPY of that store, and says SYNTHETIC.
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path";
import { createHealth } from "../src/health.mjs"; import { createApp } from "../src/server.mjs"; import { Ledger } from "../../verifier/lib/ledger.mjs"; import { DEVNET_GENESIS, PROGRAM_ID } from "../../verifier/lib/chain.mjs";
import { buildStore, storeFiles, load, tmp, BUILT_AT } from "./api_helpers.mjs"; import { listen } from "./helpers.mjs";

const ALL = load("all"); const T0 = Date.parse(BUILT_AT);
const make = async mutate => buildStore(ALL, tmp(), { mutate });
const checker = (dir, o = {}) => createHealth({ dir, genesis: DEVNET_GENESIS, program: PROGRAM_ID, staleAfterSeconds: 900, now: () => T0 + 60_000, ...o });
const by = r => Object.fromEntries(r.checks.map(c => [c.name, c]));
const editJson = (file, f) => { const j = JSON.parse(fs.readFileSync(file, "utf8")); f(j); fs.writeFileSync(file, JSON.stringify(j)); };
const only = (r, name) => { const bad = r.checks.filter(c => !c.ok).map(c => c.name); assert.deepEqual(bad, [name], `expected only ${name} to fail: ${JSON.stringify(r.checks.filter(c => !c.ok))}`); };

test("a healthy store passes all six checks", async () => {
  const dir = await make(); const r = checker(dir)(); assert.equal(r.ok, true, JSON.stringify(r.checks)); assert.deepEqual(r.checks.map(c => c.name), ["store-readable", "capture-loop-alive", "record-fresh", "no-error-or-alarm", "ledger-matches-status", "volume-free-space"]); assert.ok(r.checks.every(c => c.ok && c.detail));
});
test("SYNTHETIC: the capture loop that has not written its status for two poll intervals fails the check, one that is merely late does not", async () => {
  const dir = await make(); const f = storeFiles(dir); editJson(path.join(f.svc, "status.json"), s => { s.pollMs = 300_000; });
  assert.equal(checker(dir, { staleAfterSeconds: 99999, now: () => T0 + 2 * 300_000 + 59_000 })().ok, true, "just inside two intervals plus a minute");
  const late = checker(dir, { staleAfterSeconds: 99999, now: () => T0 + 2 * 300_000 + 61_000 })(); only(late, "capture-loop-alive"); assert.match(by(late)["capture-loop-alive"].detail, /allowed 660 s/);
  editJson(path.join(f.svc, "status.json"), s => { s.state = "stopped"; }); only(checker(dir, { staleAfterSeconds: 99999 })(), "capture-loop-alive");
});
test("SYNTHETIC: an older loop that does not write pollMs is judged by the configured default interval", async () => {
  const dir = await make(); assert.equal(JSON.parse(fs.readFileSync(path.join(storeFiles(dir).svc, "status.json"))).pollMs, null, "a cycle run directly has no loop interval");
  only(checker(dir, { staleAfterSeconds: 99999, pollSecondsDefault: 60, now: () => T0 + 200_000 })(), "capture-loop-alive");
  assert.equal(checker(dir, { staleAfterSeconds: 99999, pollSecondsDefault: 300, now: () => T0 + 200_000 })().ok, true);
});
test("SYNTHETIC: a record older than the stale threshold fails", async () => {
  const dir = await make(); const f = storeFiles(dir); editJson(path.join(f.svc, "status.json"), s => { s.pollMs = 3600_000; }); const r = checker(dir, { staleAfterSeconds: 100, now: () => T0 + 200_000 })(); only(r, "record-fresh"); assert.match(by(r)["record-fresh"].detail, /built 200 s ago, allowed 100 s/);
});
test("SYNTHETIC: a failed last cycle, a receipt flag, and a backup alarm each fail the check; an informational flag does not", async () => {
  const dir = await make(); const f = storeFiles(dir); const status = path.join(f.svc, "status.json"), record = path.join(f.svc, "record.json");
  const keep = { s: fs.readFileSync(status, "utf8"), r: fs.readFileSync(record, "utf8") }; const reset = () => { fs.writeFileSync(status, keep.s); fs.writeFileSync(record, keep.r); };
  editJson(status, s => { s.lastError = { at: BUILT_AT, message: "getProgramAccounts on x: HTTP 503" }; }); const e = checker(dir)(); only(e, "no-error-or-alarm"); assert.equal(by(e)["no-error-or-alarm"].detail, "last cycle failed: listing the receipts: the RPC answered HTTP 503"); reset();
  editJson(record, r => { r.seasons[0].flags.push({ kind: "changed-after-final", detail: "x", info: false }); }); const fl = checker(dir)(); only(fl, "no-error-or-alarm"); assert.match(by(fl)["no-error-or-alarm"].detail, /1 receipt flag/); reset();
  editJson(record, r => { r.seasons[0].flags.push({ kind: "bond-released", detail: "x", info: true }); }); assert.equal(checker(dir)().ok, true, "an informational flag is not an alarm"); reset();
  editJson(status, s => { s.backup = { configured: true, alarms: [{ kind: "backup-mismatch" }] }; }); only(checker(dir)(), "no-error-or-alarm");
});
test("SYNTHETIC: the ledger check: a changed line, a ledger shorter than status.json, a head that is not the hash at that line, and a ledger AHEAD of status.json", async () => {
  const dir = await make(); const f = storeFiles(dir); const ledger = path.join(f.svc, "ledger.jsonl"), status = path.join(f.svc, "status.json"); const keep = { l: fs.readFileSync(ledger, "utf8"), s: fs.readFileSync(status, "utf8") };
  const lines = keep.l.trim().split("\n"); assert.ok(lines.length >= 3, "the real ledger has lines");
  fs.writeFileSync(ledger, keep.l.replace(/"at":"[^"]+"/, '"at":"2000-01-01T00:00:00.000Z"')); const changed = checker(dir)(); only(changed, "ledger-matches-status"); assert.match(by(changed)["ledger-matches-status"].detail, /does not verify/);
  fs.writeFileSync(ledger, lines.slice(0, -1).join("\n") + "\n"); const shorter = checker(dir)(); only(shorter, "ledger-matches-status"); assert.match(by(shorter)["ledger-matches-status"].detail, /status.json reports \d+ ledger lines, the file has/);
  fs.writeFileSync(ledger, keep.l); editJson(status, s => { s.ledger.head = "f".repeat(64); }); const wrong = checker(dir)(); only(wrong, "ledger-matches-status"); assert.match(by(wrong)["ledger-matches-status"].detail, /not the head status.json reports/);
  fs.writeFileSync(status, keep.s); const lg = new Ledger(ledger, {}); lg.append({ type: "heartbeat" }); const ahead = checker(dir)(); assert.equal(ahead.ok, true, JSON.stringify(ahead.checks)); assert.match(by(ahead)["ledger-matches-status"].detail, /1 newer line\(s\) not yet in status.json/);
});
test("the volume check: too little free space fails, an unreadable volume fails", async () => {
  const dir = await make(); const low = checker(dir, { statfs: () => ({ bavail: 100n, bsize: 4096n }) })(); only(low, "volume-free-space"); assert.equal(by(low)["volume-free-space"].detail, "less than 64 MB free");
  assert.equal(checker(dir, { statfs: () => ({ bavail: 10n ** 9n, bsize: 4096n }) })().ok, true);
  only(checker(dir, { statfs: () => { throw Object.assign(new Error("x"), { code: "EIO" }); } })(), "volume-free-space");
});
test("the store check: a missing or corrupt record, a missing status, and no configured store all fail", async () => {
  const dir = await make(); const f = storeFiles(dir); const rec = path.join(f.svc, "record.json"), st = path.join(f.svc, "status.json"); const keep = fs.readFileSync(rec);
  fs.writeFileSync(rec, "{not json"); const bad = checker(dir)(); assert.equal(bad.ok, false); assert.equal(by(bad)["store-readable"].ok, false); assert.match(by(bad)["store-readable"].detail, /record.json/);
  fs.writeFileSync(rec, keep); fs.rmSync(st); const noStatus = checker(dir)(); assert.equal(noStatus.ok, false); assert.match(by(noStatus)["store-readable"].detail, /status.json: ENOENT/);
  const empty = checker(tmp())(); assert.equal(empty.ok, false); assert.equal(by(empty)["store-readable"].ok, false);
  const none = createHealth({ dir: null, genesis: DEVNET_GENESIS, program: PROGRAM_ID })(); assert.equal(none.ok, false); assert.equal(none.checks[0].name, "store-configured");
});
test("GET /healthz answers 200 for a healthy store and 503, naming the failing check, for each failure; /health stays a plain liveness answer; the check makes no network call", async () => {
  const dir = await make(); const f = storeFiles(dir); let calls = 0; const net = async () => { calls++; throw new Error("the health check must not call the network"); };
  const app = createApp({ recordOnly: true, programId: PROGRAM_ID, fetchImpl: net, health: checker(dir) }); const base = await listen(app); app.unref();
  try {
    let r = await fetch(base + "/healthz"); let j = await r.json(); assert.equal(r.status, 200); assert.equal(j.ok, true); assert.equal(j.checks.length, 6); assert.equal(r.headers.get("cache-control"), "no-store");
    editJson(path.join(f.svc, "status.json"), s => { s.lastError = { at: BUILT_AT, message: "boom" }; }); r = await fetch(base + "/healthz"); j = await r.json(); assert.equal(r.status, 503); assert.equal(j.ok, false); assert.deepEqual(j.checks.filter(c => !c.ok).map(c => c.name), ["no-error-or-alarm"]);
    assert.equal((await fetch(base + "/health")).status, 200); assert.equal(calls, 0);
  } finally { await new Promise(r => app.close(r)); }
  const bare = createApp({ recordOnly: true, programId: PROGRAM_ID }); const b2 = await listen(bare); bare.unref(); try { assert.equal((await fetch(b2 + "/healthz")).status, 404); } finally { await new Promise(r => bare.close(r)); }
});

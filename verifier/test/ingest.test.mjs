// The capture loop over REAL recorded devnet responses (test/fixtures). Where a test needs something that did not happen on devnet (a changed byte, a second delegation, a killed process) it alters a copy and says SYNTHETIC.
import test from "node:test"; import assert from "node:assert/strict"; import fs from "fs"; import os from "os"; import path from "path"; import { fileURLToPath } from "url"; import { spawn } from "child_process";
import { Ingest } from "../lib/ingest.mjs"; import { buildRecord } from "../lib/builder.mjs"; import { Store, verifyStore, whoAmI } from "../lib/store.mjs"; import { readLedger } from "../lib/ledger.mjs"; import { RateLimited } from "../lib/chain.mjs";
import { PROGRAM_ID, DEVNET_GENESIS, poolAddress } from "../lib/chain.mjs"; import { replay, withRecordedRegistries } from "./recorded.mjs";
const _made = []; process.on("exit", () => { for (const d of _made) fs.rmSync(d, { recursive: true, force: true }); }); /* every temporary folder this file makes is removed when its process ends */
const here = path.dirname(fileURLToPath(import.meta.url)); const load = n => withRecordedRegistries(JSON.parse(fs.readFileSync(path.join(here, "fixtures", `devnet-${n}.json`))));
const ALL = load("all"); const STAGE = Object.fromEntries(["provisional", "provisional-republished", "final", "bond-released"].map(n => [n, load(n)]));
const tmp = () => (() => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-test-")); _made.push(d); return d; })(); const clone = x => JSON.parse(JSON.stringify(x));
const root = dir => path.join(dir, DEVNET_GENESIS, PROGRAM_ID);
/** a source that counts what the loop asks of it */
function spy(source) { const calls = { receiptsOwnedBy: 0, account: [], signatures: [], transaction: [] }; const s = { host: source.host, calls, genesisHash: () => source.genesisHash(), slot: () => source.slot(),
  async receiptsOwnedBy(o) { calls.receiptsOwnedBy++; return source.receiptsOwnedBy(o); }, async account(a) { calls.account.push(a); return source.account(a); }, async signatures(a, b, u) { calls.signatures.push({ address: a, before: b, until: u }); return source.signatures(a, b, u); }, async transaction(g) { calls.transaction.push(g); return source.transaction(g); } };
  s.reset = () => { calls.receiptsOwnedBy = 0; calls.account.length = calls.signatures.length = calls.transaction.length = 0; }; return s; }
const open = async (source, dir, o = {}) => new Ingest(source, { dir, ...o }).open();
// the clock moves between two builds, so the moments a first copy was saved or a flag first seen are blanked; everything else is compared exactly
const strip = r => { const c = clone(r); for (const k of ["builtAt", "currentTo", "service", "ledger", "counts", "newFlags", "archive", "registriesAt"]) delete c[k]; const blank = v => { if (Array.isArray(v)) v.forEach(blank); else if (v && typeof v === "object") for (const k of Object.keys(v)) { if (k === "savedAt" || k === "firstSeenAt") v[k] = "T"; else blank(v[k]); } }; blank(c); return c; };
const finalAddress = () => Object.keys(ALL.accounts).find(a => ALL.accounts[a] && ALL.accounts[a].data.length > 3000 && ALL.listed[PROGRAM_ID].includes(a));
const edit = (tape, address, f) => { const d = Buffer.from(tape.accounts[address].data, "base64"); f(d); tape.accounts[address].data = d.toString("base64"); };

test("the first cycle makes the same record as the one-shot builder", async () => {
  const a = await open(spy(replay(ALL)), tmp()); const r1 = (await a.cycle()).record; a.close(); const r2 = await buildRecord(replay(ALL), { archiveDir: tmp() });
  assert.deepEqual(strip(r1), strip(r2)); assert.deepEqual(r1.counts, r2.counts); assert.equal(r1.archive.sha256, r2.archive.sha256); assert.equal(r1.archive.recordSha256, r2.archive.recordSha256); assert.equal(r1.counts.final, 28); assert.equal(r1.counts.legacy, 46);
});

test("every record carries the slot it is current to, a build time, the archive digests and the ledger head", async () => {
  const a = await open(spy(replay(ALL)), tmp()); const { record, slot } = await a.cycle(); a.close();
  const listSlots = [PROGRAM_ID, "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"].map(o => Math.max(...ALL.listed[o].map(x => ALL.accounts[x].slot))); assert.equal(record.currentTo.slot, Math.min(...listSlots)); assert.equal(slot, record.currentTo.slot);
  assert.match(record.builtAt, /^\d{4}-\d\d-\d\dT/); assert.match(record.archive.sha256, /^[0-9a-f]{64}$/); assert.match(record.archive.recordSha256, /^[0-9a-f]{64}$/); assert.equal(record.archive.copies, 28);
  assert.ok(record.ledger.entries >= 29 && /^[0-9a-f]{64}$/.test(record.ledger.head)); assert.equal(record.service.thisCycle.sweep, true); assert.equal(record.service.sweepIntervalMs, 15 * 60_000);
  const st = JSON.parse(fs.readFileSync(path.join(root(a.dir), "_service", "status.json"))); assert.equal(st.state, "ok"); assert.equal(st.currentTo.slot, record.currentTo.slot); assert.equal(st.archive.sha256, record.archive.sha256); assert.equal(st.lastError, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root(a.dir), "_service", "record.json"))).archive, record.archive);
});

test("an unchanged poll asks for the two listings and nothing else", async () => {
  const s = spy(replay(ALL)); const a = await open(s, tmp()); await a.cycle(); s.reset(); const r = await a.cycle(); a.close();
  assert.deepEqual([r.processed, r.skipped, r.sweep], [0, 75, false]); assert.deepEqual([s.calls.receiptsOwnedBy, s.calls.account.length, s.calls.signatures.length, s.calls.transaction.length], [2, 0, 0, 0]); assert.equal(r.record.counts.firstCopiesSavedNow, 0);
});

test("a changed account is the only one processed, and a change to a closed receipt is flagged, never taken", async () => {
  const dir = tmp(); let a = await open(spy(replay(ALL)), dir); await a.cycle(); const before = a.store.ledger.n; a.close();
  const addr = finalAddress(); const tape = clone(ALL); edit(tape, addr, d => { d[224 + 72] ^= 3; }); /* SYNTHETIC: one rank byte */
  const s = spy(replay(tape)); a = await open(s, dir); const r = await a.cycle(); a.close();
  assert.deepEqual([r.processed, r.skipped], [1, 74]); assert.deepEqual([...new Set(s.calls.signatures.map(x => x.address))].sort(), [addr, poolAddress(BigInt(JSON.parse(fs.readFileSync(path.join(root(dir), addr, "first-final.json"))).season), PROGRAM_ID)].sort(), "its own history and its pool, nothing else"); assert.deepEqual(r.newFlags.map(f => f.kind), ["record-changed"]);
  const season = r.record.seasons.find(x => x.address === addr); assert.deepEqual(season.entries, JSON.parse(JSON.stringify(replayRecord().seasons.find(x => x.address === addr).entries)), "the record still reads the first copy");
  const l = readLedger(path.join(root(dir), "_service", "ledger.jsonl")); assert.ok(l.ok); assert.ok(l.entries.slice(before).some(e => e.type === "flag" && e.kind === "record-changed" && e.address === addr));
  // put the bytes back: the account changed again, so it is processed again, and the flag is still there and is not raised twice
  a = await open(spy(replay(ALL)), dir); const back = await a.cycle(); a.close(); assert.equal(back.processed, 1); assert.deepEqual(back.newFlags, []); assert.ok(back.record.seasons.find(x => x.address === addr).flags.some(f => f.kind === "record-changed" && !f.info));
});
let rec; function replayRecord() { return rec; } rec = await (async () => { const a = await open(spy(replay(ALL)), tmp()); const r = (await a.cycle()).record; a.close(); return r; })();

test("one real receipt followed through provisional, final and bond released, one cycle at a time", async () => {
  const dir = tmp(); const address = STAGE.provisional.address; const run = async n => { const a = await open(spy(replay(STAGE[n])), dir); const r = await a.cycle(); a.close(); return r; };
  let r = await run("provisional"); assert.equal(r.record.seasons[0].status, "provisional"); assert.equal(r.record.archive.copies, 0);
  r = await run("provisional-republished"); assert.equal(r.processed, 1); assert.equal(r.record.seasons[0].facts.publishedEntries, 5); assert.deepEqual(r.record.seasons[0].flags, []);
  r = await run("final"); assert.equal(r.record.seasons[0].status, "final"); assert.equal(r.newFirstCopies, 1); const sha = r.record.seasons[0].copy.sha256;
  r = await run("bond-released"); assert.deepEqual(r.record.seasons[0].flags.map(f => [f.kind, f.info]), [["bond-released", true]]); assert.equal(r.record.seasons[0].copy.sha256, sha); assert.equal(r.newFirstCopies, 0);
  r = await run("bond-released"); assert.deepEqual([r.processed, r.newFirstCopies, r.newFlags.length], [0, 0, 0]);
  const l = readLedger(path.join(root(dir), "_service", "ledger.jsonl")); assert.ok(l.ok); assert.equal(l.entries.filter(e => e.type === "first-copy" && e.address === address).length, 1, "the first copy is on the ledger exactly once");
  assert.deepEqual(l.entries.filter(e => e.type === "flag").map(e => e.kind), ["bond-released"]); assert.ok(verifyStore(dir, DEVNET_GENESIS, PROGRAM_ID).ok);
});

test("a sweep asks only for what is new in each receipt's history; a poll never reads history", async () => {
  const dir = tmp(); let a = await open(spy(replay(ALL)), dir); await a.cycle(); a.close();
  const addr = finalAddress(); const obs = JSON.parse(fs.readFileSync(path.join(root(dir), addr, "observed.json"))); assert.ok(obs.history.newest, "the newest signature seen is remembered");
  const s = spy(replay(ALL)); a = await open(s, dir, { sweepMs: 0 }); const r = await a.cycle(); a.close();
  assert.equal(r.sweep, true); assert.equal(r.processed, 75); assert.ok(s.calls.signatures.length >= 28 && s.calls.signatures.every(x => x.before === undefined)); assert.equal(s.calls.signatures.find(x => x.address === addr).until, obs.history.newest);
  assert.equal(s.calls.transaction.length, 0, "no transaction is fetched twice"); assert.equal(r.newFirstCopies, 0);
});

test("SYNTHETIC: a delegation that left the bytes as they were is seen by the sweep, not by the poll", async () => {
  const dir = tmp(); let a = await open(spy(replay(ALL)), dir); await a.cycle(); a.close();
  const addr = finalAddress(); const tape = clone(ALL); const real = tape.signatures[addr].find(s => !s.err && tape.transactions[s.signature]?.transaction.message.instructions.some(i => i.accounts.length === 9)); const again = "SYNTHETIC" + real.signature.slice(9); const slot = tape.accounts[addr].slot + 1000;
  tape.signatures[addr] = [{ ...real, signature: again, slot }, ...tape.signatures[addr]]; tape.transactions[again] = { ...tape.transactions[real.signature], slot };
  a = await open(spy(replay(tape)), dir, { sweepMs: 3600_000 }); await a.cycle({ sweep: false }); a.state.lastSweep = { at: new Date().toISOString(), slot: 1 }; const poll = await a.cycle(); assert.deepEqual([poll.sweep, poll.processed, poll.newFlags.length], [false, 0, 0], "the poll sees nothing: the bytes are the same");
  const sweep = await a.cycle({ sweep: true }); a.close(); assert.ok(sweep.newFlags.some(f => f.kind === "redelegated") || sweep.record.seasons.find(x => x.address === addr).flags.some(f => f.kind === "redelegated"), "the sweep finds it");
});

test("the sweep is due on the first cycle and then every sweepMs", async () => {
  let clock = Date.parse("2026-01-01T00:00:00Z"); const now = () => new Date(clock).toISOString(); const a = await open(spy(replay(ALL)), tmp(), { sweepMs: 10 * 60_000, now });
  assert.equal((await a.cycle()).sweep, true); clock += 5 * 60_000; assert.equal((await a.cycle()).sweep, false); clock += 5 * 60_000; assert.equal((await a.cycle()).sweep, true); clock += 60_000; assert.equal((await a.cycle()).sweep, false); a.close();
});

test("one writer at a time: a second process is refused, and a lock left by a dead process is taken over", async () => {
  const dir = tmp(); const a = await open(spy(replay(ALL)), dir); await assert.rejects(() => open(spy(replay(ALL)), dir), /another ingest process \(pid \d+/); a.close(); const b = await open(spy(replay(ALL)), dir); b.close();
  fs.writeFileSync(path.join(root(dir), "_service", "lock"), JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: "x" })); const c = await open(spy(replay(ALL)), dir); c.close();
});

// A container restarts the process at a low pid again and again. After a SIGKILL or an out-of-memory kill the lock file stays, and its pid can be the very number the next process has.
test("STALE LOCK: a leftover lock that carries our own pid is taken over, so a killed container restarts instead of crash-looping", async () => {
  const dir = tmp(); const a0 = await open(spy(replay(ALL)), dir); a0.close(); const me = whoAmI(); const lock = path.join(root(dir), "_service", "lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: "2026-01-01T00:00:00Z", host: me.host, boot: me.boot })); // what a predecessor with this same pid left behind
  const logs = []; const a = await open(spy(replay(ALL)), dir, { log: m => logs.push(m) }); assert.ok(logs.some(m => /taking over a stale lock \(its pid \d+ is our own/.test(m)), logs.join("|")); assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).pid, process.pid);
  await assert.rejects(() => open(spy(replay(ALL)), dir), /another ingest process \(pid \d+/, "while this process really holds the lock, a second writer in it is still refused"); a.close(); assert.ok(!fs.existsSync(lock), "released on close");
  // an old-format lock (no host, no boot) with our pid is stale too
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: "x" })); (await open(spy(replay(ALL)), dir)).close();
});
test("STALE LOCK: a really concurrent writer is still refused; a lock from another container or another boot is stale; a dead writer is taken over", async () => {
  const dir = tmp(); const child = spawn(process.execPath, [path.join(here, "ingest_child.mjs")], { env: { ...process.env, STORE: dir, DELAY_MS: "400" }, stdio: ["ignore", "pipe", "inherit"] }); let started = false; child.stdout.on("data", d => { if (String(d).includes("started")) started = true; });
  const t0 = Date.now(); while (!started && Date.now() - t0 < 30_000) await new Promise(r => setTimeout(r, 20)); assert.ok(started, "the child took the lock");
  try {
    await assert.rejects(() => open(spy(replay(ALL)), dir), new RegExp(`another ingest process \\(pid ${child.pid},`), "a live writer in this container is refused");
    const lock = path.join(root(dir), "_service", "lock"); const held = JSON.parse(fs.readFileSync(lock, "utf8")); assert.equal(held.pid, child.pid); assert.ok(held.host, "the lock names its container");
    const other = { ...held, host: held.host + "-previous-deployment" }; fs.writeFileSync(lock, JSON.stringify(other));
    const logs = []; const a = await open(spy(replay(ALL)), dir, { log: m => logs.push(m) }); assert.ok(logs.some(m => /written in another container/.test(m))); a.close();
    if (held.boot) { fs.writeFileSync(lock, JSON.stringify({ ...held, boot: "00000000-0000-0000-0000-000000000000" })); const l2 = []; (await open(spy(replay(ALL)), dir, { log: m => l2.push(m) })).close(); assert.ok(l2.some(m => /before the last boot/.test(m))); }
  } finally { child.kill("SIGKILL"); await new Promise(r => child.on("exit", r)); }
  const dir2 = tmp(); const c2 = spawn(process.execPath, [path.join(here, "ingest_child.mjs")], { env: { ...process.env, STORE: dir2, DELAY_MS: "400" }, stdio: ["ignore", "pipe", "inherit"] }); let up = false; c2.stdout.on("data", d => { if (String(d).includes("started")) up = true; });
  const t1 = Date.now(); while (!up && Date.now() - t1 < 30_000) await new Promise(r => setTimeout(r, 20)); c2.kill("SIGKILL"); await new Promise(r => c2.on("exit", r));
  assert.ok(fs.existsSync(path.join(root(dir2), "_service", "lock")), "a SIGKILL leaves its lock behind"); (await open(spy(replay(ALL)), dir2)).close();
});

// A source whose genesisHash fails in a chosen way for the first n asks, then answers from the recording. Everything it serves after that is the recorded devnet data.
function failingStart(n, fail) { const base = replay(ALL); const asked = { genesis: 0, other: 0 }; const wrap = f => async (...a) => { asked.other++; return f.apply(base, a); };
  return { asked, source: { ...base, host: "t", genesisHash: async () => { if (asked.genesis++ < n) return fail(); return base.genesisHash(); }, slot: wrap(base.slot), receiptsOwnedBy: wrap(base.receiptsOwnedBy), account: wrap(base.account), accounts: wrap(base.accounts), signatures: wrap(base.signatures), transaction: wrap(base.transaction) } }; }
const svc = (dir, f) => path.join(root(dir), "_service", f); const statusOf = dir => JSON.parse(fs.readFileSync(svc(dir, "status.json")));

test("STARTUP: open() sends nothing to the RPC; a failing genesis check leaves the record on disk untouched, says why in the status, captures nothing, and recovers", async () => {
  const dir = tmp(); const first = await open(replay(ALL), dir); await first.cycle(); first.close(); const recordBefore = fs.readFileSync(svc(dir, "record.json")); const copies = verifyStore(dir, DEVNET_GENESIS, PROGRAM_ID).copies;
  const t = failingStart(3, () => { throw new Error("getGenesisHash on rpc.example: HTTP 401, not JSON"); }); const a = await open(t.source, dir); assert.deepEqual(t.asked, { genesis: 0, other: 0 }, "opening the store asked the RPC nothing");
  for (let i = 1; i <= 3; i++) { await assert.rejects(() => a.cycle(), /HTTP 401/); const st = statusOf(dir); assert.equal(st.state, "degraded"); assert.match(st.lastError.message, /HTTP 401/); assert.equal(t.asked.genesis, i); }
  assert.equal(t.asked.other, 0, "nothing else was read from a cluster that was never checked"); assert.ok(fs.readFileSync(svc(dir, "record.json")).equals(recordBefore), "the last known record is byte for byte as it was"); assert.equal(verifyStore(dir, DEVNET_GENESIS, PROGRAM_ID).copies, copies);
  await a.cycle(); assert.equal(statusOf(dir).state, "ok"); assert.equal(statusOf(dir).lastError, null); assert.equal(t.asked.genesis, 4); await a.cycle(); assert.equal(t.asked.genesis, 4, "once verified, the cluster is not asked again by this process"); a.close();
});
test("STARTUP: the loop itself retries, after an ordinary failure and after a rate limit, and captures once the RPC answers", async () => {
  for (const [what, fail] of [["an outage", () => { throw new Error("getGenesisHash on t: no usable answer (TypeError)"); }], ["a 429", () => { throw new RateLimited("t", Date.now() + 50, "HTTP 429"); }]]) {
    const dir = tmp(); const t = failingStart(2, fail); const a = await open(t.source, dir); const stop = new AbortController(); const logs = []; a.log = m => logs.push(m); let result;
    await a.run({ pollMs: 20, signal: stop.signal, onCycle: r => { result = r; stop.abort(); } }); a.close();
    assert.ok(result, what); assert.equal(t.asked.genesis, 3, `${what}: two failures, then the answer`); assert.equal(result.record.archive.copies, 28); assert.equal(logs.filter(l => /retrying in|rate limited: waiting/.test(l)).length, 2, logs.join("|"));
  }
});
test("STARTUP: an RPC for another cluster still captures nothing, however often it is retried, and --once still fails", async () => {
  const dir = tmp(); const t = failingStart(99, () => "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"); const a = await open(t.source, dir);
  for (let i = 0; i < 3; i++) await assert.rejects(() => a.cycle(), /this RPC serves cluster 4uhc\w+, not the expected/);
  assert.equal(t.asked.genesis, 3, "a wrong answer is never remembered as verified"); assert.equal(t.asked.other, 0); assert.equal(verifyStore(dir, DEVNET_GENESIS, PROGRAM_ID).copies, 0); assert.ok(!fs.existsSync(svc(dir, "record.json"))); assert.match(statusOf(dir).lastError.message, /serves cluster/);
  await assert.rejects(() => a.run({ once: true }), /serves cluster/); a.close();
});

test("SYNTHETIC: a process killed in the middle of a cycle loses nothing and duplicates nothing", async () => {
  const dir = tmp(); const child = spawn(process.execPath, [path.join(here, "ingest_child.mjs")], { env: { ...process.env, STORE: dir, DELAY_MS: "25" }, stdio: ["ignore", "pipe", "inherit"] });
  const copies = () => { try { return fs.readdirSync(root(dir)).filter(f => fs.existsSync(path.join(root(dir), f, "first-final.json"))).length; } catch { return 0; } };
  const t0 = Date.now(); while (copies() < 4 && Date.now() - t0 < 60_000) await new Promise(r => setTimeout(r, 20)); const during = copies(); child.kill("SIGKILL"); await new Promise(r => child.on("exit", r)); assert.ok(during >= 4 && during < 28, `killed with ${during} of 28 first copies saved`);
  const a = await open(spy(replay(ALL)), dir); const r = await a.cycle(); a.close();
  assert.equal(r.record.archive.copies, 28); assert.deepEqual(strip(r.record), strip(rec)); const v = verifyStore(dir, DEVNET_GENESIS, PROGRAM_ID); assert.ok(v.ok, v.problems.join("; "));
  const l = readLedger(path.join(root(dir), "_service", "ledger.jsonl")); const per = {}; for (const e of l.entries) if (e.type === "first-copy") per[e.address] = (per[e.address] ?? 0) + 1; assert.equal(Object.keys(per).length, 28); assert.ok(Object.values(per).every(n => n === 1), "each first copy is on the ledger once");
});

test("a rate limit stops the cycle, is reported in the status, and the loop sends nothing until the time it names", async () => {
  const base = replay(ALL); let blocked = 0; const until = Date.now() + 700; let sent = 0;
  const source = { ...base, host: "t", genesisHash: () => base.genesisHash(), slot: () => base.slot(), receiptsOwnedBy: async o => { if (Date.now() < until) { blocked++; throw new RateLimited("t", until, "HTTP 429"); } sent++; return base.receiptsOwnedBy(o); }, account: a => base.account(a), signatures: (...x) => base.signatures(...x), transaction: g => base.transaction(g) };
  const a = await open(source, tmp()); const ctl = new AbortController(); const cycles = []; const done = a.run({ pollMs: 50, signal: ctl.signal, onCycle: r => { cycles.push(r); ctl.abort(); } }); await done;
  assert.equal(blocked, 1, "one refused attempt, then the loop waited for the time it was given"); assert.ok(sent >= 2 && cycles.length === 1); assert.ok(Date.now() >= until);
  const st = JSON.parse(fs.readFileSync(path.join(root(a.dir), "_service", "status.json"))); assert.ok(["ok", "backup-alarm"].includes(st.state)); a.close();
});

test("any other failure leaves the last good record in place, says so in the status, and backs off", async () => {
  const base = replay(ALL); let fail = true; const source = { ...base, host: "t", genesisHash: () => base.genesisHash(), slot: () => base.slot(), receiptsOwnedBy: async o => { if (fail) throw new Error("upstream 502"); return base.receiptsOwnedBy(o); }, account: a => base.account(a), signatures: (...x) => base.signatures(...x), transaction: g => base.transaction(g) };
  const dir = tmp(); const a = await open(source, dir); await assert.rejects(() => a.cycle(), /upstream 502/); let st = JSON.parse(fs.readFileSync(path.join(root(dir), "_service", "status.json"))); assert.equal(st.state, "degraded"); assert.match(st.lastError.message, /502/); assert.equal(fs.existsSync(path.join(root(dir), "_service", "record.json")), false);
  fail = false; await a.cycle(); st = JSON.parse(fs.readFileSync(path.join(root(dir), "_service", "status.json"))); assert.equal(st.state, "ok"); assert.equal(st.lastError, null); a.close();
});

test("SYNTHETIC: a first copy written without its ledger line (killed in between) gets one, marked recovered, and nothing is duplicated", async () => {
  const dir = tmp(); const arch = new (await import("../lib/archive.mjs")).Archive(dir, DEVNET_GENESIS, PROGRAM_ID); const addr = finalAddress(); /* no ledger attached: this is the state a kill between the two writes leaves */
  arch.saveFirst(addr, { account: { owner: PROGRAM_ID, lamports: 1, slot: 7, data: Buffer.from(ALL.accounts[addr].data, "base64") }, season: "x", observedAt: "t" }); assert.equal(verifyStore(dir, DEVNET_GENESIS, PROGRAM_ID).ok, false);
  const a = await open(spy(replay(ALL)), dir); const l = readLedger(path.join(root(dir), "_service", "ledger.jsonl")); const mine = l.entries.filter(e => e.type === "first-copy" && e.address === addr); assert.equal(mine.length, 1); assert.equal(mine[0].recovered, true);
  const r = await a.cycle(); a.close(); assert.equal(r.record.archive.copies, 28); assert.equal(readLedger(path.join(root(dir), "_service", "ledger.jsonl")).entries.filter(e => e.type === "first-copy" && e.address === addr).length, 1); assert.ok(verifyStore(dir, DEVNET_GENESIS, PROGRAM_ID).ok);
});

test("SYNTHETIC: an archived receipt that drops out of the listing is looked up, flagged missing once, and stays in the record from its first copy", async () => {
  const dir = tmp(); let a = await open(spy(replay(ALL)), dir); await a.cycle(); a.close(); const addr = finalAddress(); const tape = clone(ALL); tape.listed[PROGRAM_ID] = tape.listed[PROGRAM_ID].filter(x => x !== addr); tape.accounts[addr] = null;
  const s = spy(replay(tape)); a = await open(s, dir); const r = await a.cycle(); assert.deepEqual(s.calls.account, [addr], "one direct lookup, for that address only"); assert.deepEqual(r.newFlags.map(f => f.kind), ["account-missing"]); assert.equal(r.record.seasons.find(x => x.address === addr).status, "final");
  s.reset(); const again = await a.cycle(); a.close(); assert.deepEqual([again.processed, s.calls.account.length, again.newFlags.length], [0, 0, 0], "and then it is remembered as absent, not asked for every poll");
});

test("a line goes on the ledger once a day even when nothing happened, so that 'nothing changed' is itself recorded", async () => {
  let clock = Date.parse("2026-01-01T00:00:00Z"); const now = () => new Date(clock).toISOString(); const a = await open(spy(replay(ALL)), tmp(), { sweepMs: 60_000, heartbeatMs: 3600_000, now }); await a.cycle(); const beats = () => readLedger(path.join(a.store.svc, "ledger.jsonl")).entries.filter(e => e.type === "heartbeat").length;
  assert.equal(beats(), 0); clock += 1800_000; await a.cycle(); assert.equal(beats(), 0); clock += 1900_000; await a.cycle(); assert.equal(beats(), 1); clock += 120_000; await a.cycle(); assert.equal(beats(), 1); a.close();
});

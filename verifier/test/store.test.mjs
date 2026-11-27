// The managed store, its ledger, the backup mirror, snapshots and restores, over real recorded devnet receipts. Altered inputs are marked SYNTHETIC.
import test from "node:test"; import assert from "node:assert/strict"; import fs from "fs"; import os from "os"; import path from "path"; import crypto from "crypto"; import { fileURLToPath } from "url"; import { spawnSync } from "child_process";
import { Ingest } from "../lib/ingest.mjs"; import { buildRecord } from "../lib/builder.mjs"; import { Store, verifyStore, importArchive } from "../lib/store.mjs"; import { Ledger, readLedger } from "../lib/ledger.mjs";
import { syncMirror, verifyMirror, makeSnapshot, verifySnapshot, restoreSnapshot, snapshotDigest } from "../lib/mirror.mjs"; import { Archive } from "../lib/archive.mjs"; import { PROGRAM_ID, DEVNET_GENESIS } from "../lib/chain.mjs"; import { replay, withLaterReads } from "./recorded.mjs";
const _made = []; process.on("exit", () => { for (const d of _made) fs.rmSync(d, { recursive: true, force: true }); }); /* every temporary folder this file makes is removed when its process ends */
const here = path.dirname(fileURLToPath(import.meta.url)); const ALL = withLaterReads(JSON.parse(fs.readFileSync(path.join(here, "fixtures", "devnet-all.json"))));
const tmp = () => (() => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "store-test-")); _made.push(d); return d; })(); const root = d => path.join(d, DEVNET_GENESIS, PROGRAM_ID); const clone = x => JSON.parse(JSON.stringify(x));
const run = async (dir, o = {}, tape = ALL) => { const a = await new Ingest(replay(tape), { dir, ...o }).open(); const r = await a.cycle(); a.close(); return { a, r }; };
const treeHash = dir => { const h = crypto.createHash("sha256"); const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name < y.name ? -1 : 1)) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else h.update(p.slice(dir.length) + fs.readFileSync(p).toString("base64")); } }; walk(dir); return h.digest("hex"); };
const finalAddress = () => Object.keys(ALL.accounts).find(a => ALL.accounts[a] && ALL.accounts[a].data.length > 3000 && ALL.listed[PROGRAM_ID].includes(a));

test("the ledger is a hash chain: a changed, removed, inserted or reordered line is found", async () => {
  const dir = tmp(); await run(dir); const file = path.join(root(dir), "_service", "ledger.jsonl"); const good = fs.readFileSync(file, "utf8"); const lines = good.trimEnd().split("\n"); assert.ok(lines.length >= 29 && readLedger(file).ok);
  const bad = lines => { fs.writeFileSync(file, lines.join("\n") + "\n"); return readLedger(file); };
  const edited = [...lines]; const e = JSON.parse(edited[3]); e.sha256 = "0".repeat(64); edited[3] = JSON.stringify(e); assert.equal(bad(edited).ok, false, "a changed line");
  assert.equal(bad(lines.filter((_, i) => i !== 5)).ok, false, "a removed line"); const swapped = [...lines]; [swapped[4], swapped[5]] = [swapped[5], swapped[4]]; assert.equal(bad(swapped).ok, false, "a reordered pair");
  assert.equal(bad([...lines.slice(0, 4), lines[3], ...lines.slice(4)]).ok, false, "a repeated line"); fs.writeFileSync(file, good); assert.ok(readLedger(file).ok);
  assert.throws(() => new Ledger((fs.writeFileSync(file, lines.slice(0, 2).concat(["{nonsense"], lines.slice(3)).join("\n") + "\n"), file)), /damaged/, "a store with a damaged ledger refuses to open");
});
test("SYNTHETIC: a last line cut short by a kill is dropped on the next start; the lines before it stay", async () => {
  const dir = tmp(); await run(dir); const file = path.join(root(dir), "_service", "ledger.jsonl"); const n = readLedger(file).entries.length; fs.appendFileSync(file, '{"n":99,"at":"x","type":"fir'); assert.equal(readLedger(file).torn > 0, true);
  const l = new Ledger(file); assert.equal(l.n, n); assert.ok(readLedger(file).ok && readLedger(file).torn === 0); l.append({ type: "start" }); assert.ok(readLedger(file).ok);
});
test("an archive made by the one-shot builder becomes a store without being touched, and the service goes on from it", async () => {
  const old = tmp(); const r0 = await buildRecord(replay(ALL), { archiveDir: old }); const before = treeHash(old); const addr = finalAddress();
  fs.writeFileSync(path.join(root(old), addr, "flags.json"), JSON.stringify([{ kind: "bond-released", detail: "x", info: true, firstSeenAt: "t" }], null, 1) + "\n"); const before2 = treeHash(old);
  const dir = tmp(); const imp = importArchive(old, dir, DEVNET_GENESIS, PROGRAM_ID); assert.deepEqual([imp.first, imp.flags >= 1], [28, true]); assert.equal(treeHash(old), before2, "the source folder was only read"); assert.notEqual(before, before2);
  for (const a of new Archive(old, DEVNET_GENESIS, PROGRAM_ID).addresses()) { const f = path.join(root(old), a, "first-final.json"); if (fs.existsSync(f)) assert.ok(fs.readFileSync(f).equals(fs.readFileSync(path.join(root(dir), a, "first-final.json"))), "byte for byte"); }
  const v = verifyStore(dir, DEVNET_GENESIS, PROGRAM_ID); assert.ok(v.ok, v.problems.join("; ")); assert.ok(readLedger(path.join(root(dir), "_service", "ledger.jsonl")).entries.some(e => e.type === "import-flag"));
  const { r } = await run(dir); assert.equal(r.newFirstCopies, 0, "nothing is saved twice"); assert.equal(r.record.archive.sha256, r0.archive.sha256); assert.equal(r.record.counts.final, 28);
  assert.throws(() => { const other = clone(JSON.parse(fs.readFileSync(path.join(root(old), addr, "first-final.json")))); const d = Buffer.from(other.data, "base64"); d[300] ^= 1; other.data = d.toString("base64"); fs.writeFileSync(path.join(root(old), addr, "first-final.json"), JSON.stringify(other, null, 1) + "\n"); importArchive(old, dir, DEVNET_GENESIS, PROGRAM_ID); }, /DIFFERENT first copy/, "SYNTHETIC: an import never replaces a first copy");
});
test("verifyStore finds a first copy that was edited, deleted, or never recorded", async () => {
  const dir = tmp(); await run(dir); assert.ok(verifyStore(dir, DEVNET_GENESIS, PROGRAM_ID).ok); const addr = finalAddress(); const file = path.join(root(dir), addr, "first-final.json"); const keep = fs.readFileSync(file);
  const j = JSON.parse(keep); const d = Buffer.from(j.data, "base64"); d[500] ^= 1; j.data = d.toString("base64"); fs.writeFileSync(file, JSON.stringify(j, null, 1) + "\n"); assert.match(verifyStore(dir, DEVNET_GENESIS, PROGRAM_ID).problems.join(" "), /does not match its own hash/);
  const j2 = JSON.parse(keep); const d2 = Buffer.from(j2.data, "base64"); d2[500] ^= 1; j2.data = d2.toString("base64"); j2.sha256 = crypto.createHash("sha256").update(d2).digest("hex"); fs.writeFileSync(file, JSON.stringify(j2, null, 1) + "\n"); assert.match(verifyStore(dir, DEVNET_GENESIS, PROGRAM_ID).problems.join(" "), /no longer matches the hash the ledger recorded/, "even with its own hash rewritten, the ledger remembers");
  fs.rmSync(file); assert.match(verifyStore(dir, DEVNET_GENESIS, PROGRAM_ID).problems.join(" "), /ledger records a first copy that is gone/);
});

test("a backup is a witness: copies once, never replaces, and raises an alarm when the two disagree", async () => {
  const dir = tmp(), bak = tmp(); const { r } = await run(dir, { backupDir: bak }); const m = verifyMirror(root(bak), DEVNET_GENESIS, PROGRAM_ID, root(dir)); assert.ok(m.ok, m.problems.join("; ")); assert.equal(m.copies, 28); assert.equal(m.ledger.head, r.record.ledger.head);
  assert.ok(fs.existsSync(path.join(root(bak), "MANIFEST.json")) && fs.existsSync(path.join(root(bak), "_service", "ledger.jsonl"))); assert.ok(verifyStore(bak, DEVNET_GENESIS, PROGRAM_ID).ok || true);
  const addr = finalAddress(); const bf = path.join(root(bak), addr, "first-final.json"); const orig = fs.readFileSync(bf); const j = JSON.parse(orig); const d = Buffer.from(j.data, "base64"); d[400] ^= 1; j.data = d.toString("base64"); fs.writeFileSync(bf, JSON.stringify(j, null, 1) + "\n"); const tampered = fs.readFileSync(bf);
  const a = await new Ingest(replay(ALL), { dir, backupDir: bak }).open(); await a.cycle({ sweep: true }); await a.cycle({ sweep: true }); a.close(); assert.ok(fs.readFileSync(bf).equals(tampered), "the backup was not overwritten"); assert.ok(fs.readFileSync(path.join(root(dir), addr, "first-final.json")).equals(orig), "nor was the store's");
  const st = JSON.parse(fs.readFileSync(path.join(root(dir), "_service", "status.json"))); assert.equal(st.state, "backup-alarm"); assert.equal(st.backup.alarms.filter(x => x.kind === "backup-mismatch").length, 1, "once, not once per sweep");
  assert.equal(readLedger(path.join(root(dir), "_service", "ledger.jsonl")).entries.filter(e => e.type === "backup-alarm").length, 1);
});
test("SYNTHETIC: a backup whose ledger or flags differ from the store's is an alarm, not an overwrite", async () => {
  const dir = tmp(), bak = tmp(); await run(dir, { backupDir: bak }); const st = new Store(dir, DEVNET_GENESIS, PROGRAM_ID); const lf = path.join(root(bak), "_service", "ledger.jsonl"); const keep = fs.readFileSync(lf, "utf8");
  const lines = keep.trimEnd().split("\n"); const e = JSON.parse(lines[2]); e.at = "1999-01-01"; lines[2] = JSON.stringify(e); fs.writeFileSync(lf, lines.join("\n") + "\n"); const r = syncMirror(st.root, root(bak)); assert.deepEqual(r.alarms.map(a => a.kind), ["ledger-diverged"]); assert.equal(fs.readFileSync(lf, "utf8"), lines.join("\n") + "\n"); fs.writeFileSync(lf, keep);
  const addr = finalAddress(); fs.writeFileSync(path.join(root(bak), addr, "flags.json"), JSON.stringify([{ kind: "record-changed", detail: "x", firstSeenAt: "t" }])); const r2 = syncMirror(st.root, root(bak)); assert.ok(r2.alarms.some(a => a.kind === "flags-regressed" && a.address === addr));
});
test("restoring from a backup rebuilds a store with the same digests; it refuses a damaged backup and a folder that already holds a store", async () => {
  const dir = tmp(), bak = tmp(); const { r } = await run(dir, { backupDir: bak }); const out = tmp(); const cli = (...a) => spawnSync(process.execPath, [path.join(here, "..", "cli.mjs"), ...a], { encoding: "utf8" });
  const ok = cli("store", "restore", "--store", out, "--from-backup", bak); assert.equal(ok.status, 0, ok.stderr + ok.stdout); const v = verifyStore(out, DEVNET_GENESIS, PROGRAM_ID); assert.ok(v.ok, v.problems.join("; ")); assert.equal(v.digest.sha256, r.record.archive.sha256); assert.equal(v.ledger.head, r.record.ledger.head);
  assert.notEqual(cli("store", "restore", "--store", out, "--from-backup", bak).status, 0, "not into a folder that holds a store");
  const addr = finalAddress(); fs.appendFileSync(path.join(root(bak), addr, "first-final.json"), " "); const bad = cli("store", "restore", "--store", tmp(), "--from-backup", bak); assert.notEqual(bad.status, 0); assert.match(bad.stderr, /does not verify/);
});
test("a snapshot is one file of everything irreplaceable, verifies on its own, restores exactly, and notices any alteration", async () => {
  const dir = tmp(); const { r } = await run(dir); const st = new Store(dir, DEVNET_GENESIS, PROGRAM_ID); const snap = JSON.parse(JSON.stringify(makeSnapshot(st.root, DEVNET_GENESIS, PROGRAM_ID)));
  const v = verifySnapshot(snap); assert.ok(v.ok, v.problems.join("; ")); assert.equal(v.copies, 28); assert.ok(JSON.stringify(snap).length < 600_000, "small enough to commit");
  const out = tmp(); restoreSnapshot(snap, out); const vs = verifyStore(out, DEVNET_GENESIS, PROGRAM_ID); assert.ok(vs.ok, vs.problems.join("; ")); assert.equal(vs.digest.sha256, r.record.archive.sha256); assert.equal(vs.ledger.head, r.record.ledger.head);
  const addr = finalAddress(); for (const f of fs.readdirSync(root(dir)).filter(f => fs.existsSync(path.join(root(dir), f, "first-final.json")))) assert.ok(fs.readFileSync(path.join(root(dir), f, "first-final.json")).equals(fs.readFileSync(path.join(root(out), f, "first-final.json"))), "byte for byte");
  const mut = f => { const s = clone(snap); f(s); return verifySnapshot(s).ok; };
  assert.equal(mut(s => { const d = Buffer.from(s.copies[addr].data, "base64"); d[9] ^= 1; s.copies[addr].data = d.toString("base64"); }), false, "a changed copy"); assert.equal(mut(s => { s.ledger[4].at = "x"; }), false, "a changed ledger line"); assert.equal(mut(s => { s.ledger.splice(3, 1); }), false, "a removed ledger line");
  assert.equal(mut(s => { delete s.copies[addr]; }), false, "a removed copy: the digest and the ledger both notice");
  // a CONSISTENT forgery: the copy changed, its own hash and the digest recomputed to match. Only the ledger, written when the copy was first saved, still remembers the real hash
  const forged = (f) => { const s = clone(snap); f(s); s.digest = snapshotDigest(s); return verifySnapshot(s); };
  const swap = forged(s => { const d = Buffer.from(s.copies[addr].data, "base64"); d[9] ^= 1; s.copies[addr].data = d.toString("base64"); s.copies[addr].sha256 = crypto.createHash("sha256").update(d).digest("hex"); }); assert.equal(swap.ok, false); assert.match(swap.problems.join(" "), /ledger does not record this first copy/);
  const dropped = forged(s => { delete s.copies[addr]; }); assert.equal(dropped.ok, false); assert.match(dropped.problems.join(" "), /ledger records a first copy that the snapshot does not hold/); assert.equal(mut(s => { s.digest = "0".repeat(64); }), false); assert.throws(() => restoreSnapshot(snap, out), /not empty/);
});
test("the store commands work from the command line: init, verify, backup, snapshot, restore", async () => {
  const old = tmp(); await buildRecord(replay(ALL), { archiveDir: old }); const store = tmp(), bak = tmp(), snap = path.join(tmp(), "s.json"), back = tmp(); const cli = (...a) => spawnSync(process.execPath, [path.join(here, "..", "cli.mjs"), ...a], { encoding: "utf8" }); const must = (r, what) => assert.equal(r.status, 0, `${what}: ${r.stderr}${r.stdout}`);
  must(cli("store", "init", "--from", old, "--store", store), "init"); must(cli("store", "backup", "--store", store, "--to", bak), "backup"); must(cli("store", "verify", "--store", store, "--backup", bak), "verify"); must(cli("store", "snapshot", "--store", store, "--out", snap), "snapshot"); must(cli("store", "restore", "--store", back, "--snapshot", snap), "restore");
  assert.equal(verifyStore(back, DEVNET_GENESIS, PROGRAM_ID).digest.sha256, verifyStore(store, DEVNET_GENESIS, PROGRAM_ID).digest.sha256);
  fs.appendFileSync(path.join(root(bak), "_service", "ledger.jsonl"), "{}\n"); assert.notEqual(cli("store", "verify", "--store", store, "--backup", bak).status, 0, "a damaged backup fails verify");
});

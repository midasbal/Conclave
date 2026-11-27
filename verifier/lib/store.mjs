// The managed store: the archive (first final copies, flags, observations: lib/archive.mjs) plus what the service adds around it.
//   <dir>/<genesis>/<program>/<address>/first-final.json    written once, never replaced (the archive)
//   <dir>/<genesis>/<program>/<address>/flags.json          sticky flags (the archive)
//   <dir>/<genesis>/<program>/<address>/observed.json       history already read, delegation records seen while delegated (the archive)
//   <dir>/<genesis>/<program>/_service/ledger.jsonl         hash-chained log of everything the archive did
//   <dir>/<genesis>/<program>/_service/state.json           fingerprints of the accounts last processed, sweep and poll times
//   <dir>/<genesis>/<program>/_service/entries/<address>.json   what each address was last decided to be (a cache: it can be rebuilt)
//   <dir>/<genesis>/<program>/_service/record.json, status.json   the current record and the service's own health
//   <dir>/<genesis>/<program>/_service/lock                 which process is writing
// Only the first copies, flags, observations and the ledger are irreplaceable. Everything under entries/ and the record can be rebuilt from them and base.
import fs from "fs"; import path from "path"; import crypto from "crypto";
import { Archive } from "./archive.mjs"; import { Ledger, readLedger } from "./ledger.mjs"; import { sha256 } from "./chain.mjs";

const atomic = (file, text) => { const tmp = `${file}.${crypto.randomBytes(5).toString("hex")}.tmp`; const fd = fs.openSync(tmp, "wx"); try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(tmp, file); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

export class Store {
  constructor(dir, genesis, program, { now = () => new Date().toISOString(), log = () => {} } = {}) {
    this.now = now; this.log = log; this.archive = new Archive(dir, genesis, program); this.root = this.archive.root; this.svc = path.join(this.root, "_service"); this.entriesDir = path.join(this.svc, "entries");
    fs.mkdirSync(this.entriesDir, { recursive: true }); this.ledger = new Ledger(path.join(this.svc, "ledger.jsonl"), { now, log }); this.archive.ledger = this.ledger; this.locked = false; this.cache = new Map();
  }
  get lockFile() { return path.join(this.svc, "lock"); }
  /** one writer at a time. A lock left by a process that is gone is taken over; one held by a live process is refused */
  lock() {
    for (let i = 0; i < 2; i++) {
      try { const fd = fs.openSync(this.lockFile, "wx"); fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: this.now() })); fs.closeSync(fd); this.locked = true; return; }
      catch (e) { if (e.code !== "EEXIST") throw e; let held; try { held = JSON.parse(fs.readFileSync(this.lockFile, "utf8")); } catch { held = null; }
        if (held?.pid && alive(held.pid)) throw new Error(`another ingest process (pid ${held.pid}, since ${held.startedAt}) is writing this store`);
        this.log(`lock: taking over a lock left by a process that is gone (pid ${held?.pid ?? "unknown"})`); fs.rmSync(this.lockFile, { force: true }); }
    }
    throw new Error("could not take the store lock");
  }
  unlock() { if (this.locked) { fs.rmSync(this.lockFile, { force: true }); this.locked = false; } }
  readState() { try { return JSON.parse(fs.readFileSync(path.join(this.svc, "state.json"), "utf8")); } catch (e) { if (e.code === "ENOENT") return { version: 1, fingerprints: {}, cycles: 0 }; throw e; } }
  writeState(s) { atomic(path.join(this.svc, "state.json"), JSON.stringify(s, null, 1) + "\n"); }
  entry(address) { if (this.cache.has(address)) return this.cache.get(address); try { const e = JSON.parse(fs.readFileSync(path.join(this.entriesDir, address + ".json"), "utf8")); this.cache.set(address, e); return e; } catch (e) { if (e.code === "ENOENT") return null; throw e; } }
  saveEntry(address, descriptor) { atomic(path.join(this.entriesDir, address + ".json"), JSON.stringify(descriptor) + "\n"); this.cache.set(address, descriptor); }
  entryAddresses() { return fs.readdirSync(this.entriesDir).filter(f => f.endsWith(".json")).map(f => f.slice(0, -5)).sort(); }
  writeService(name, value) { atomic(path.join(this.svc, name), JSON.stringify(value, null, 1) + "\n"); }
  /** a first copy on disk that the ledger does not know (a process killed between writing the file and the ledger line) gets a ledger line, marked as recovered */
  reconcileLedger() {
    const known = new Map(this.ledger.entries.filter(e => e.type === "first-copy" || e.type === "import-first-copy").map(e => [e.address, e.sha256])); let added = 0;
    for (const address of this.archive.addresses()) { const f = this.archive.first(address); if (!f || f.damaged || known.has(address)) continue; this.ledger.append({ type: "first-copy", recovered: true, address, season: f.season, sha256: f.sha256, finalizedSlot: f.finalizedSlot ?? null, observedAt: f.observedAt }); added++; }
    if (added) this.log(`ledger: ${added} first copies were on disk without a ledger line (a process was killed in between); lines added, marked recovered`);
    return added;
  }
}

/** an existing archive (the 4B folder) becomes a store: its files are copied (never moved, never changed), verified byte for byte, and the ledger records what was imported */
export function importArchive(fromDir, toDir, genesis, program, { now = () => new Date().toISOString() } = {}) {
  const src = new Archive(fromDir, genesis, program), store = new Store(toDir, genesis, program, { now }); const done = { first: 0, flags: 0, observed: 0, skipped: [] };
  for (const address of src.addresses()) {
    const d = src.dirOf(address); const t = store.archive.dirOf(address); fs.mkdirSync(t, { recursive: true });
    for (const name of ["first-final.json", "flags.json", "observed.json"]) { const from = path.join(d, name), to = path.join(t, name); if (!fs.existsSync(from)) continue;
      if (fs.existsSync(to)) { if (!fs.readFileSync(to).equals(fs.readFileSync(from))) { if (name === "first-final.json") throw new Error(`${address}: the store already holds a DIFFERENT first copy than the one being imported`); } continue; }
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); if (!fs.readFileSync(to).equals(fs.readFileSync(from))) throw new Error(`${address}/${name}: copy differs from its source`);
      if (name === "first-final.json") done.first++; else if (name === "flags.json") done.flags++; else done.observed++; }
    const f = store.archive.first(address); if (f && !f.damaged && !store.ledger.entries.some(e => e.address === address && (e.type === "first-copy" || e.type === "import-first-copy"))) store.ledger.append({ type: "import-first-copy", address, season: f.season, sha256: f.sha256, finalizedSlot: f.finalizedSlot ?? null, observedAt: f.observedAt });
    for (const fl of store.archive.flags(address)) if (!store.ledger.entries.some(e => e.type === "import-flag" && e.address === address && e.kind === fl.kind && e.detail === fl.detail)) store.ledger.append({ type: "import-flag", address, kind: fl.kind, detail: fl.detail, info: !!fl.info });
  }
  return { ...done, store };
}

/** integrity of a store: every first copy matches its own hash, the ledger chain is unbroken, and the two agree about which first copies exist and what they hash to */
export function verifyStore(dir, genesis, program) {
  const archive = new Archive(dir, genesis, program); const problems = []; const lg = readLedger(path.join(archive.root, "_service", "ledger.jsonl"));
  if (!lg.ok) problems.push(`ledger: ${lg.problem}`); if (lg.torn) problems.push(`ledger: a last line was cut short (${lg.torn} bytes); it is dropped on the next start`);
  const ledgerFirst = new Map(); for (const e of lg.entries) if (e.type === "first-copy" || e.type === "import-first-copy") { if (ledgerFirst.has(e.address) && ledgerFirst.get(e.address) !== e.sha256) problems.push(`ledger: two different first copies recorded for ${e.address}`); ledgerFirst.set(e.address, e.sha256); }
  let copies = 0;
  for (const address of archive.addresses()) { const f = archive.first(address); if (!f) continue; if (f.damaged) { problems.push(`${address}: ${f.damaged}`); continue; } copies++;
    if (!ledgerFirst.has(address)) problems.push(`${address}: a first copy with no ledger line`); else if (ledgerFirst.get(address) !== f.sha256) problems.push(`${address}: the first copy no longer matches the hash the ledger recorded`); }
  for (const address of ledgerFirst.keys()) if (!archive.first(address)) problems.push(`${address}: the ledger records a first copy that is gone`);
  return { ok: problems.length === 0, problems, copies, ledger: { entries: lg.entries.length, head: lg.head }, digest: archive.digest() };
}
export { atomic as atomicWrite };

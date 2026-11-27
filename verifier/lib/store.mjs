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
import fs from "fs"; import os from "os"; import path from "path"; import crypto from "crypto";
import { Archive } from "./archive.mjs"; import { Ledger, readLedger } from "./ledger.mjs"; import { sha256 } from "./chain.mjs";

const atomic = (file, text) => { const tmp = `${file}.${crypto.randomBytes(5).toString("hex")}.tmp`; const fd = fs.openSync(tmp, "wx"); try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(tmp, file); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
/** who is writing, as far as this machine can tell: the container (its host name) and the boot (the kernel boot id). A pid alone cannot say: in a container our own process runs at a low pid, and a lock left by a killed predecessor can carry the very same number */
export const whoAmI = () => { let boot = ""; try { boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch { /* not Linux: the host name alone is used */ } return { host: os.hostname(), boot }; };
/** lock files this process holds right now: a second open of the same store inside one process is a genuine concurrent writer, whatever its pid */
const heldHere = new Set();

export class Store {
  constructor(dir, genesis, program, { now = () => new Date().toISOString(), log = () => {} } = {}) {
    this.now = now; this.log = log; this.archive = new Archive(dir, genesis, program); this.root = this.archive.root; this.svc = path.join(this.root, "_service"); this.entriesDir = path.join(this.svc, "entries");
    fs.mkdirSync(this.entriesDir, { recursive: true }); this.ledger = new Ledger(path.join(this.svc, "ledger.jsonl"), { now, log }); this.archive.ledger = this.ledger; this.locked = false; this.cache = new Map();
  }
  get lockFile() { return path.join(this.svc, "lock"); }
  /** one writer at a time. A lock is stale, and taken over, when its writer cannot be the one running now: the process is gone; or it carries OUR pid but this process did not take it (a predecessor killed by SIGKILL or the out-of-memory killer in a container, where processes start at low pids and the same number comes round again); or it was written by another container or another boot. A lock held by a live process of this container, or by this process itself, is refused.
   *  What this does not do: tell a live writer in a DIFFERENT container from a dead one. Two live containers on one volume are prevented by the platform (Railway lets one deployment mount a service's volume at a time), not by this lock. */
  lock() {
    const me = whoAmI();
    for (let i = 0; i < 2; i++) {
      try { const fd = fs.openSync(this.lockFile, "wx"); fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: this.now(), host: me.host, boot: me.boot })); fs.closeSync(fd); this.locked = true; heldHere.add(this.lockFile); return; }
      catch (e) { if (e.code !== "EEXIST") throw e; let held; try { held = JSON.parse(fs.readFileSync(this.lockFile, "utf8")); } catch { held = null; }
        const refuse = () => { throw new Error(`another ingest process (pid ${held.pid}, since ${held.startedAt}) is writing this store`); };
        let why = null;
        if (!held?.pid) why = "unreadable";
        else if (heldHere.has(this.lockFile)) refuse(); // this very process already holds it: a second writer, whatever the number says
        else if (held.host && held.host !== me.host) why = `written in another container (${held.host})`;
        else if (held.boot && me.boot && held.boot !== me.boot) why = "written before the last boot";
        else if (held.pid === process.pid) why = `its pid ${held.pid} is our own, and this process never took it (the process that did was killed)`;
        else if (alive(held.pid)) refuse();
        else why = `its process (pid ${held.pid}) is gone`;
        this.log(`lock: taking over a stale lock (${why})`); fs.rmSync(this.lockFile, { force: true }); }
    }
    throw new Error("could not take the store lock");
  }
  unlock() { if (this.locked) { fs.rmSync(this.lockFile, { force: true }); this.locked = false; heldHere.delete(this.lockFile); } }
  readState() { try { return JSON.parse(fs.readFileSync(path.join(this.svc, "state.json"), "utf8")); } catch (e) { if (e.code === "ENOENT") return { version: 1, fingerprints: {}, cycles: 0 }; throw e; } }
  writeState(s) { atomic(path.join(this.svc, "state.json"), JSON.stringify(s, null, 1) + "\n"); }
  entry(address) { if (this.cache.has(address)) return this.cache.get(address); try { const e = JSON.parse(fs.readFileSync(path.join(this.entriesDir, address + ".json"), "utf8")); this.cache.set(address, e); return e; } catch (e) { if (e.code === "ENOENT") return null; throw e; } }
  saveEntry(address, descriptor) { atomic(path.join(this.entriesDir, address + ".json"), JSON.stringify(descriptor) + "\n"); this.cache.set(address, descriptor); }
  entryAddresses() { return fs.readdirSync(this.entriesDir).filter(f => f.endsWith(".json")).map(f => f.slice(0, -5)).sort(); }
  writeService(name, value) { atomic(path.join(this.svc, name), JSON.stringify(value, null, 1) + "\n"); }
  /** a first copy on disk that the ledger does not know (a process killed between writing the file and the ledger line) gets a ledger line, marked as recovered */
  reconcileLedger() {
    const known = new Map(this.ledger.entries.filter(e => e.type === "first-copy" || e.type === "import-first-copy").map(e => [e.address, e.sha256])); let added = 0;
    for (const address of this.archive.addresses()) { if (known.has(address)) continue; let f; try { f = this.archive.first(address); } catch { continue; /* it cannot be read now: processing that receipt reports it */ } if (!f || f.damaged) continue; this.ledger.append({ type: "first-copy", recovered: true, address, season: f.season, sha256: f.sha256, finalizedSlot: f.finalizedSlot ?? null, observedAt: f.observedAt }); added++; }
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

// The capture loop. One cycle:
//   fast poll   two paged listings of the receipts on base (the program's and the delegation program's). An account whose fingerprint (owner, lamports, bytes) is unchanged costs nothing more. Only changed ones are
//               processed: delegation record, NEW signatures only (`until` the newest already seen), classification, first final copy, flags, validator. Cheap enough to run every minute.
//   full sweep  every `sweepMs`, and on the first cycle: every known address is processed again, and the history of every one is asked for what is new. This is what catches what a fingerprint cannot, such as an
//               account delegated and returned between two polls with the same bytes, and anything a poll missed.
// Both run the SAME per-address code as the one-shot builder (lib/builder.mjs processAddress), so the record is the same record. Nothing here ever replaces a first copy or clears a flag.
// Reads are paced by the source (lib/chain.mjs). When it reports a rate limit the loop waits until the time it names and sends nothing meanwhile.
import fs from "fs"; import path from "path";
import { PROGRAM_ID, DELEGATION_PROGRAM_ID, DEVNET_GENESIS, sha256 } from "./chain.mjs";
import { processAddress, assembleRecord, newContext } from "./builder.mjs";
import { Store } from "./store.mjs"; import { syncMirror } from "./mirror.mjs"; import { readRegistryStatuses } from "./enrich.mjs";

const fingerprint = a => a ? sha256(Buffer.from(a.owner), Buffer.from("|"), Buffer.from(String(a.lamports)), Buffer.from("|"), a.data).toString("hex") : "absent";
const abortableSleep = (ms, signal) => new Promise(res => { const t = setTimeout(res, ms); signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true }); });

export class Ingest {
  constructor(source, { dir, backupDir = null, publishTo = null, program = PROGRAM_ID, genesis = DEVNET_GENESIS, sweepMs = 15 * 60_000, heartbeatMs = 24 * 3600_000, now = () => new Date().toISOString(), log = () => {} }) {
    Object.assign(this, { source, dir, backupDir, publishTo, program, genesis, sweepMs, heartbeatMs, now, log }); this.last = null; this.error = null; this.backupInfo = { configured: !!backupDir, lastSyncAt: null, alarms: [] }; this.lastSyncHead = null; this.startedAt = null;
  }
  async open() {
    const cluster = await this.source.genesisHash(); if (cluster !== this.genesis) throw new Error(`this RPC serves cluster ${cluster}, not the expected ${this.genesis}`);
    this.store = new Store(this.dir, this.genesis, this.program, { now: this.now, log: this.log }); this.store.lock(); this.store.reconcileLedger(); this.state = this.store.readState(); this.startedAt = this.now();
    if (!this.state.lastHeartbeatAt) this.state.lastHeartbeatAt = this.now(); this.store.ledger.append({ type: "start", pid: process.pid, genesis: this.genesis, program: this.program, sweepMs: this.sweepMs }); return this;
  }
  close() { this.store?.unlock(); }

  /** one cycle. `sweep: true` forces a full sweep. Returns what it did. Throws RateLimited (state is saved, nothing is lost) or any other error */
  async cycle({ sweep = false } = {}) {
    const t0 = Date.now(), at = this.now(), { store, state, source, program } = this; const archive = store.archive; const ctx = newContext(source, archive, { program, now: this.now });
    const listed = new Map(), slots = []; const sweepDue = sweep || !state.lastSweep || Date.parse(at) - Date.parse(state.lastSweep.at) >= this.sweepMs;
    let processed = 0, skipped = 0, looked = 0, known = [];
    try { // the listing is inside the handler too: when it is the listing that fails, the status must still say so
      for (const owner of [program, DELEGATION_PROGRAM_ID]) { const got = await source.receiptsOwnedBy(owner); if (got.contextSlot != null) slots.push(got.contextSlot); for (const a of got) listed.set(a.address, a); }
      known = [...new Set([...Object.keys(state.fingerprints), ...archive.addresses(), ...listed.keys()])].sort();
      for (const address of known) {
        let account = listed.get(address);
        if (account === undefined) { // not listed: either it was never a receipt, or it has gone or changed hands. Look it up directly, once; "absent" is then remembered until the next sweep
          if (!sweepDue && state.fingerprints[address] === "absent") { skipped++; continue; }
          const a = await source.account(address); looked++; account = a ? { address, ...a } : null; }
        const fp = fingerprint(account);
        if (!sweepDue && state.fingerprints[address] === fp && store.entry(address)) { skipped++; continue; }
        const d = await processAddress(ctx, address, account); store.saveEntry(address, d); state.fingerprints[address] = fp; store.writeState(state); processed++;
      }
    } catch (e) { state.cycles = (state.cycles ?? 0) + 1; store.writeState(state); this.error = { at, message: e.message, rateLimited: e.name === "RateLimited" ? e.retryAt : null }; this.writeStatus({ state: e.name === "RateLimited" ? "rate-limited" : "degraded", at, processed, skipped }); throw e; }
    const slot = slots.length ? Math.min(...slots) : null; state.lastPoll = { at, slot }; if (sweepDue) state.lastSweep = { at, slot }; state.cycles = (state.cycles ?? 0) + 1;
    // a line in the ledger once a day even when nothing happened, so that "nothing changed since" is itself on the record
    if (sweepDue && Date.parse(at) - Date.parse(state.lastHeartbeatAt) >= this.heartbeatMs) { state.lastHeartbeatAt = at; store.ledger.append({ type: "heartbeat", slot, copies: archive.digest().copies }); }
    store.writeState(state);
    const descriptors = known.map(a => store.entry(a)).filter(Boolean);
    // which strategies are closed: every sweep for all of them, and at once for any strategy not seen before
    const ids = [...new Set(descriptors.filter(d => d.kind === "season").flatMap(d => d.season.entries.map(e => e.strategyId)))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    state.registries ??= {}; const want = sweepDue ? ids : ids.filter(id => !state.registries[id]);
    if (want.length) { try { Object.assign(state.registries, await readRegistryStatuses(source, program, want)); state.registriesAt = { at, slot }; store.writeState(state); } catch (e) { if (e.name === "RateLimited") { this.error = { at, message: e.message, rateLimited: e.retryAt }; this.writeStatus({ state: "rate-limited", at, processed, skipped }); } throw e; } }
    const registries = Object.fromEntries(ids.map(id => [id, state.registries[id]]).filter(([, v]) => v));
    const record = assembleRecord(descriptors, { archive, genesis: this.genesis, program, now: this.now, source, ctx, currentTo: { slot, at }, registries, registriesAt: state.registriesAt ?? null,
      extra: { service: { cycle: state.cycles, lastSweep: state.lastSweep, sweepIntervalMs: this.sweepMs, thisCycle: { sweep: sweepDue, processed, skipped, lookedUp: looked, ms: Date.now() - t0 } } } });
    store.writeService("record.json", record); if (this.publishTo) { fs.mkdirSync(path.dirname(this.publishTo), { recursive: true }); const tmp = this.publishTo + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(record, null, 1) + "\n"); fs.renameSync(tmp, this.publishTo); }
    this.last = record; this.error = null;
    await this.mirror(sweepDue || ctx.firstCopies > 0 || ctx.newFlags.length > 0 || store.ledger.head !== this.lastSyncHead);
    this.writeStatus({ state: this.backupInfo.alarms.length ? "backup-alarm" : "ok", at, processed, skipped, sweep: sweepDue, newFirstCopies: ctx.firstCopies, newFlags: ctx.newFlags.length, ms: Date.now() - t0 });
    return { processed, skipped, lookedUp: looked, sweep: sweepDue, newFirstCopies: ctx.firstCopies, newFlags: ctx.newFlags, slot, record };
  }

  async mirror(due) {
    if (!this.backupDir || !due) return; const to = path.join(this.backupDir, this.genesis, this.program);
    const r = syncMirror(this.store.root, to, { now: this.now, extra: ["record.json"] }); this.backupInfo.lastSyncAt = this.now(); this.lastSyncHead = this.store.ledger.head;
    for (const a of r.alarms) { const key = a.kind + "|" + (a.address ?? "") + "|" + a.detail; if (!this.backupInfo.alarms.some(x => x.key === key)) { this.backupInfo.alarms.push({ key, ...a, at: this.now() }); this.store.ledger.append({ type: "backup-alarm", kind: a.kind, address: a.address ?? null, detail: a.detail }); this.log(`BACKUP ALARM ${a.kind} ${a.address ?? ""}: ${a.detail}`); } }
    this.lastSyncHead = this.store.ledger.head;
  }
  writeStatus(extra) {
    const s = this.state; this.store.writeService("status.json", { pid: process.pid, startedAt: this.startedAt, updatedAt: this.now(), ...extra, currentTo: s.lastPoll ?? null, lastSweep: s.lastSweep ?? null, nextSweepAt: s.lastSweep ? new Date(Date.parse(s.lastSweep.at) + this.sweepMs).toISOString() : null,
      lastError: this.error, backup: this.backupInfo, archive: this.store.archive.digest(), ledger: this.store.ledger.summary(), cycles: s.cycles ?? 0 });
  }

  /** the loop. Returns when `signal` aborts (or after one cycle with `once`). A rate limit waits until the time the endpoint named; any other failure backs off, up to five minutes, and tries again: the record stays at its last good state and the status says it is stale */
  async run({ pollMs = 60_000, once = false, signal, onCycle = () => {} } = {}) {
    let failures = 0;
    while (!signal?.aborted) {
      let wait = pollMs;
      try { const r = await this.cycle(); failures = 0; onCycle(r); }
      catch (e) { failures++; if (once) throw e; if (e.name === "RateLimited") { wait = Math.max(pollMs, e.retryAt - Date.now() + 1000); this.log(`rate limited: waiting ${Math.round(wait / 1000)} s`); } else { wait = Math.min(5 * 60_000, pollMs * 2 ** Math.min(failures, 5)); this.log(`cycle failed (${e.message}); retrying in ${Math.round(wait / 1000)} s`); } }
      if (once) break; await abortableSleep(wait, signal);
    }
  }
}

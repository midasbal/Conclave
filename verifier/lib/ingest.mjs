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

/** after this many receipts in a row fail, the rest of the cycle stops asking for histories and pools (the endpoint is not answering them) but still captures first copies */
const FAILURES_BEFORE_CAPTURE_ONLY = 3;
/** stands in the fingerprint of a receipt whose reads failed: it matches nothing, so the receipt is processed again by the next cycle, whether that is a poll or a sweep */
const RETRY = "retry";
const fingerprint = a => a ? sha256(Buffer.from(a.owner), Buffer.from("|"), Buffer.from(String(a.lamports)), Buffer.from("|"), a.data).toString("hex") : "absent";
const abortableSleep = (ms, signal) => new Promise(res => { const t = setTimeout(res, ms); signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true }); });

/** names the step a failure happened in, so the status says what could not be done and not only what the disk answered */
const step = (what, f) => { try { return f(); } catch (e) { throw new Error(`${what}: ${e.message}`); } };
/** the status must be writable even when a first copy cannot be read, which is exactly when it is needed */
const digestOrNull = archive => { try { return archive.digest(); } catch { return null; } };

export class Ingest {
  constructor(source, { dir, backupDir = null, publishTo = null, program = PROGRAM_ID, genesis = DEVNET_GENESIS, sweepMs = 15 * 60_000, heartbeatMs = 24 * 3600_000, now = () => new Date().toISOString(), log = () => {} }) {
    Object.assign(this, { source, dir, backupDir, publishTo, program, genesis, sweepMs, heartbeatMs, now, log }); this.last = null; this.error = null; this.backupInfo = { configured: !!backupDir, lastSyncAt: null, alarms: [] }; this.lastSyncHead = null; this.startedAt = null;
  }
  /** takes the store. It reads and writes the disk only and sends nothing: an RPC that is down, rate limiting or refusing the key must not stop the process, because the record on disk can still be served while the loop retries */
  async open() {
    this.clusterVerified = false;
    this.store = new Store(this.dir, this.genesis, this.program, { now: this.now, log: this.log }); this.store.lock(); this.store.reconcileLedger(); this.state = this.store.readState(); this.startedAt = this.now();
    if (!this.state.lastHeartbeatAt) this.state.lastHeartbeatAt = this.now(); this.store.ledger.append({ type: "start", pid: process.pid, genesis: this.genesis, program: this.program, sweepMs: this.sweepMs }); return this;
  }
  close() { this.store?.unlock(); }

  /** the RPC must serve the cluster this store is for. Asked once per process, by the first cycle that gets an answer, and BEFORE anything else is read: nothing is captured from a cluster that has not been checked */
  async verifyCluster() {
    if (this.clusterVerified) return; const cluster = await this.source.genesisHash(); if (cluster !== this.genesis) throw new Error(`this RPC serves cluster ${cluster}, not the expected ${this.genesis}`);
    this.clusterVerified = true;
  }

  /** one cycle. `sweep: true` forces a full sweep. Returns what it did. Throws RateLimited (state is saved, nothing is lost) or any other error.
   *  Whatever fails, at any step, the status says so with the reason before the error leaves here, and a cycle that could not read something publishes nothing: the record stays as it was. */
  async cycle({ sweep = false } = {}) {
    const t0 = Date.now(), at = this.now(), { store, state, source, program } = this; const archive = store.archive; const ctx = newContext(source, archive, { program, now: this.now });
    const listed = new Map(), slots = []; const sweepDue = sweep || !state.lastSweep || Date.parse(at) - Date.parse(state.lastSweep.at) >= this.sweepMs;
    let processed = 0, skipped = 0, looked = 0, known = [];
    state.cycles = (state.cycles ?? 0) + 1;
    try {
      // a first copy whose ledger line could not be written (the disk refused it) gets its line now, not only at the next start
      this.phase = null; store.reconcileLedger();
      this.phase = "checking the RPC's cluster"; await this.verifyCluster();
      this.phase = "listing the receipts";
      for (const owner of [program, DELEGATION_PROGRAM_ID]) { const got = await source.receiptsOwnedBy(owner); if (got.contextSlot != null) slots.push(got.contextSlot); for (const a of got) listed.set(a.address, a); }
      known = [...new Set([...Object.keys(state.fingerprints), ...archive.addresses(), ...listed.keys()])].sort();
      this.phase = "processing the receipts"; const failures = []; let inARow = 0;
      for (const address of known) {
        try {
          let account = listed.get(address);
          if (account === undefined) { // not listed: either it was never a receipt, or it has gone or changed hands. Look it up directly, once; "absent" is then remembered until the next sweep
            if (!sweepDue && state.fingerprints[address] === "absent") { skipped++; continue; }
            const a = await source.account(address); looked++; account = a ? { address, ...a } : null; }
          const fp = fingerprint(account);
          if (!sweepDue && state.fingerprints[address] === fp && store.entry(address)) { skipped++; continue; }
          const d = await processAddress(ctx, address, account); processed++;
          if (d.failed) { failures.push(...d.failed); state.fingerprints[address] = RETRY; inARow++; } // what was last decided about it stays as it was
          else { store.saveEntry(address, d); state.fingerprints[address] = fp; inARow = 0; }
          store.writeState(state);
        } catch (e) { // one receipt that cannot be processed does not stop the others being captured. A rate limit does stop the cycle: nothing more may be sent
          if (e.name === "RateLimited") throw e; failures.push(`processing ${address}: ${e.message}`); state.fingerprints[address] = RETRY; inARow++;
        }
        if (inARow >= FAILURES_BEFORE_CAPTURE_ONLY && !ctx.skipReads) ctx.skipReads = `${FAILURES_BEFORE_CAPTURE_ONLY} receipts in a row failed`;
      }
      const slot = slots.length ? Math.min(...slots) : null; if (sweepDue) state.lastSweep = { at, slot };
      // a line in the ledger once a day even when nothing happened, so that "nothing changed since" is itself on the record
      if (sweepDue && Date.parse(at) - Date.parse(state.lastHeartbeatAt) >= this.heartbeatMs) { state.lastHeartbeatAt = at; store.ledger.append({ type: "heartbeat", slot, copies: archive.digest().copies }); }
      store.writeState(state);
      const descriptors = known.map(a => store.entry(a)).filter(Boolean);
      // which strategies are closed: every sweep for all of them, and at once for any strategy not seen before
      const ids = [...new Set(descriptors.filter(d => d.kind === "season").flatMap(d => d.season.entries.map(e => e.strategyId)))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
      // a read that failed is remembered and asked again until it succeeds: this cycle has already counted its sweep, so without this the next poll would skip the read and report success
      state.registries ??= {}; const want = sweepDue ? ids : ids.filter(id => !state.registries[id] || state.registryRetry?.includes(id));
      this.phase = "reading the strategy registries";
      if (want.length) {
        try { Object.assign(state.registries, await readRegistryStatuses(source, program, want, { strict: true })); state.registriesAt = { at, slot }; delete state.registryRetry; store.writeState(state); }
        catch (e) { state.registryRetry = want; store.writeState(state); throw e; }
      }
      // anything that could not be read: say so and publish nothing. Every first copy this cycle could save has been saved, and the registries above are not asked for again
      if (failures.length) throw new Error(failures.length === 1 ? failures[0] : `${failures[0]} (and ${failures.length - 1} more read failure(s) in this cycle)`);
      this.phase = "writing the record";
      const registries = Object.fromEntries(ids.map(id => [id, state.registries[id]]).filter(([, v]) => v));
      const record = assembleRecord(descriptors, { archive, genesis: this.genesis, program, now: this.now, source, ctx, currentTo: { slot, at }, registries, registriesAt: state.registriesAt ?? null,
        extra: { service: { cycle: state.cycles, lastSweep: state.lastSweep, sweepIntervalMs: this.sweepMs, thisCycle: { sweep: sweepDue, processed, skipped, lookedUp: looked, ms: Date.now() - t0 } } } });
      step("writing the record", () => store.writeService("record.json", record));
      if (this.publishTo) step("writing the published copy of the record (--out)", () => { fs.mkdirSync(path.dirname(this.publishTo), { recursive: true }); const tmp = this.publishTo + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(record, null, 1) + "\n"); fs.renameSync(tmp, this.publishTo); });
      state.lastPoll = { at, slot }; store.writeState(state);
      this.last = record; this.error = null;
      // the mirror does not make the record wrong, so its failure raises the backup alarm and does not fail the cycle
      await this.mirrorOrAlarm(sweepDue || ctx.firstCopies > 0 || ctx.newFlags.length > 0 || store.ledger.head !== this.lastSyncHead);
      this.writeStatus({ state: this.backupInfo.alarms.length ? "backup-alarm" : "ok", at, processed, skipped, sweep: sweepDue, newFirstCopies: ctx.firstCopies, newFlags: ctx.newFlags.length, ms: Date.now() - t0 });
      return { processed, skipped, lookedUp: looked, sweep: sweepDue, newFirstCopies: ctx.firstCopies, newFlags: ctx.newFlags, slot, record };
    } catch (e) { this.failed(e, { at, processed, skipped }); throw e; }
  }

  /** records why a cycle failed. Each write is attempted on its own: a disk that refuses one must not keep the reason out of the other. If the status cannot be written either, only its age can tell (and the free-space check) */
  failed(e, { at, processed, skipped }) {
    this.error = { at, message: e.message, rateLimited: e.name === "RateLimited" ? e.retryAt : null, phase: this.phase };
    try { this.store.writeState(this.state); } catch (w) { this.log(`could not save the state after a failed cycle: ${w.message}`); }
    try { this.writeStatus({ state: e.name === "RateLimited" ? "rate-limited" : "degraded", at, processed, skipped }); } catch (w) { this.log(`could not write the status after a failed cycle: ${w.message}`); }
  }

  /** a mirror that cannot be written raises an alarm the status and the health check show. It stays until a later sync succeeds, and a failed sync is due again on the very next cycle. Alarms about what a sync FOUND (a copy that differs) are never cleared */
  async mirrorOrAlarm(due) {
    if (!this.backupDir || !(due || this.mirrorFailed)) return; const KEY = "backup-sync-failed";
    try { await this.mirror(true); this.mirrorFailed = false; this.backupInfo.alarms = this.backupInfo.alarms.filter(a => a.key !== KEY); }
    catch (e) {
      const first = !this.mirrorFailed; this.mirrorFailed = true; const detail = `the backup mirror could not be synced: ${e.message}`;
      this.backupInfo.alarms = [...this.backupInfo.alarms.filter(a => a.key !== KEY), { key: KEY, kind: KEY, address: null, detail, at: this.now() }];
      this.log(`BACKUP ALARM ${KEY}: ${e.message}`); if (first) try { this.store.ledger.append({ type: "backup-alarm", kind: KEY, address: null, detail }); } catch (w) { this.log(`could not put the alarm on the ledger: ${w.message}`); }
    }
  }

  async mirror(due) {
    if (!this.backupDir || !due) return; const to = path.join(this.backupDir, this.genesis, this.program);
    const r = syncMirror(this.store.root, to, { now: this.now, extra: ["record.json"] }); this.backupInfo.lastSyncAt = this.now(); this.lastSyncHead = this.store.ledger.head;
    for (const a of r.alarms) { const key = a.kind + "|" + (a.address ?? "") + "|" + a.detail; if (!this.backupInfo.alarms.some(x => x.key === key)) { this.backupInfo.alarms.push({ key, ...a, at: this.now() }); this.store.ledger.append({ type: "backup-alarm", kind: a.kind, address: a.address ?? null, detail: a.detail }); this.log(`BACKUP ALARM ${a.kind} ${a.address ?? ""}: ${a.detail}`); } }
    this.lastSyncHead = this.store.ledger.head;
  }
  writeStatus(extra) {
    const s = this.state; this.store.writeService("status.json", { pid: process.pid, startedAt: this.startedAt, updatedAt: this.now(), pollMs: this.pollMs ?? null, ...extra, currentTo: s.lastPoll ?? null, lastSweep: s.lastSweep ?? null, nextSweepAt: s.lastSweep ? new Date(Date.parse(s.lastSweep.at) + this.sweepMs).toISOString() : null,
      lastError: this.error, backup: this.backupInfo, archive: digestOrNull(this.store.archive), ledger: this.store.ledger.summary(), cycles: s.cycles ?? 0 });
  }

  /** the loop. Returns when `signal` aborts (or after one cycle with `once`). A rate limit waits until the time the endpoint named; any other failure backs off, up to five minutes, and tries again: the record stays at its last good state and the status says it is stale */
  async run({ pollMs = 60_000, once = false, signal, onCycle = () => {} } = {}) {
    let failures = 0; this.pollMs = pollMs; // the status says how often it expects to be updated, so a health check can tell a late loop from a slow one
    while (!signal?.aborted) {
      let wait = pollMs;
      try { const r = await this.cycle(); failures = 0; onCycle(r); }
      catch (e) { failures++; if (once) throw e; if (e.name === "RateLimited") { wait = Math.max(pollMs, e.retryAt - Date.now() + 1000); this.log(`rate limited: waiting ${Math.round(wait / 1000)} s (${e.message})`); } else { wait = Math.min(5 * 60_000, pollMs * 2 ** Math.min(failures, 5)); this.log(`cycle failed (${e.message}); retrying in ${Math.round(wait / 1000)} s`); } }
      if (once) break; await abortableSleep(wait, signal);
    }
  }
}

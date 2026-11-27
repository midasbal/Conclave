// A health check that can say "no". /v1/status always answers 200 and describes the trouble; this answers 200 only when every condition below holds, and 503 with each check named otherwise.
// It reads the store the capture loop writes and the volume it sits on. It never touches the network, the rollup or the chain, so a call costs no RPC credit, and it never writes.
import fs from "node:fs"; import path from "node:path";
import { readLedger, LEDGER_START } from "../../verifier/lib/ledger.mjs";

const readJson = f => JSON.parse(fs.readFileSync(f, "utf8"));

/**
 * dir, genesis, program: where the store is. staleAfterSeconds: the record may be this old. pollSecondsDefault: the poll interval to assume when status.json does not say (an older loop).
 * minFreeBytes: the volume must have at least this much free. now, statfs: injectable, for tests.
 * The capture loop must have written status.json within two poll intervals plus a minute: one missed cycle is a slow RPC, two is a loop that is not running.
 */
export function createHealth({ dir, genesis, program, staleAfterSeconds = 900, pollSecondsDefault = 300, minFreeBytes = 64 * 1024 * 1024, now = () => Date.now(), statfs = fs.statfsSync }) {
  let ledgerCache = null; // the ledger is verified link by link; it is re-verified only when the file changes
  const ledgerOf = file => { const st = fs.statSync(file); if (ledgerCache && ledgerCache.mtimeMs === st.mtimeMs && ledgerCache.size === st.size) return ledgerCache.value; const value = readLedger(file); ledgerCache = { mtimeMs: st.mtimeMs, size: st.size, value }; return value; };

  return function check() {
    const checks = []; const add = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); return !!ok; };
    if (!dir) { add("store-configured", false, "no store directory is configured"); return { ok: false, checks }; }
    const svc = path.join(dir, genesis, program, "_service"); let record = null, status = null;

    // 1. the store is readable: the record and the status parse, and the record is a version this server reads
    let readable = true;
    try { record = readJson(path.join(svc, "record.json")); } catch (e) { readable = false; add("store-readable", false, `record.json: ${e.code ?? "unreadable"}`); }
    try { status = readJson(path.join(svc, "status.json")); } catch (e) { if (readable) add("store-readable", false, `status.json: ${e.code ?? "unreadable"}`); readable = false; }
    if (readable) add("store-readable", true, "record.json and status.json parse");

    // 2. the capture loop is alive: it wrote its status recently, and it has not stopped
    if (status) {
      const pollMs = Number.isFinite(status.pollMs) && status.pollMs > 0 ? status.pollMs : pollSecondsDefault * 1000; const allowedMs = 2 * pollMs + 60_000; const ageMs = now() - Date.parse(status.updatedAt);
      add("capture-loop-alive", Number.isFinite(ageMs) && ageMs <= allowedMs && status.state !== "stopped", status.state === "stopped" ? "the capture loop reports that it stopped" : `status written ${Math.round(ageMs / 1000)} s ago, allowed ${Math.round(allowedMs / 1000)} s (two poll intervals of ${Math.round(pollMs / 1000)} s plus a minute)`);
    } else add("capture-loop-alive", false, "no status");

    // 3. the record is fresh
    if (record) { const age = Math.round((now() - Date.parse(record.builtAt)) / 1000); add("record-fresh", Number.isFinite(age) && age <= staleAfterSeconds, `built ${age} s ago, allowed ${staleAfterSeconds} s`); } else add("record-fresh", false, "no record");

    // 4. no error and no alarm: the last cycle did not fail, no receipt carries a flag that is not merely informational, and the backup (if configured) raised nothing
    if (status && record) {
      const flags = (record.seasons ?? []).reduce((n, s) => n + (s.flags ?? []).filter(f => !f.info).length, 0); const backupAlarms = (status.backup?.alarms ?? []).length;
      add("no-error-or-alarm", !status.lastError && flags === 0 && backupAlarms === 0, status.lastError ? `last cycle failed: ${String(status.lastError.message).slice(0, 160)}` : flags || backupAlarms ? `${flags} receipt flag(s), ${backupAlarms} backup alarm(s)` : "the last cycle succeeded; no flags, no alarms");
    } else add("no-error-or-alarm", false, "no status or record to read it from");

    // 5. the ledger agrees with status.json: the chain verifies, and the head status.json reports is the hash of that many lines in. The ledger may be AHEAD of status.json (a line is appended before the cycle that wrote it ends); it may never be behind or different.
    try {
      const l = ledgerOf(path.join(svc, "ledger.jsonl")); const n = status?.ledger?.entries; const head = status?.ledger?.head;
      if (!l.ok) add("ledger-matches-status", false, `ledger does not verify: ${l.problem}`);
      else if (!status?.ledger || !Number.isInteger(n)) add("ledger-matches-status", false, "status.json does not report a ledger head");
      else if (n > l.entries.length) add("ledger-matches-status", false, `status.json reports ${n} ledger lines, the file has ${l.entries.length}`);
      else { const at = n === 0 ? LEDGER_START : l.entries[n - 1].hash; add("ledger-matches-status", at === head, at === head ? `head matches at line ${n}${l.entries.length > n ? ` (${l.entries.length - n} newer line(s) not yet in status.json)` : ""}` : `the hash at line ${n} is not the head status.json reports`); }
    } catch (e) { add("ledger-matches-status", false, `ledger: ${e.code ?? e.message}`); }

    // 6. the volume has free space
    try { const f = statfs(dir); const free = Number(f.bavail) * Number(f.bsize); add("volume-free-space", free >= minFreeBytes, `${Math.floor(free / 1048576)} MB free, at least ${Math.floor(minFreeBytes / 1048576)} MB required`); } catch (e) { add("volume-free-space", false, `could not read the volume: ${e.code ?? e.message}`); }

    return { ok: checks.every(c => c.ok), checks };
  };
}

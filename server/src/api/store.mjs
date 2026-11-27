// Reads the record the capture loop (verifier/lib/ingest.mjs) writes. The API reads the STORE, never the chain: a request costs one stat of two files unless the loop has written a new record.
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
export const SUPPORTED_RECORD_VERSION = 2;
const readJson = f => JSON.parse(fs.readFileSync(f, "utf8"));
export class RecordStore {
  constructor({ dir = null, genesis, program, staleAfterSeconds = 300, now = () => Date.now() }) { Object.assign(this, { dir, genesis, program, staleAfterSeconds, now }); this.cache = null; this.statusCache = null; }
  get configured() { return !!this.dir; }
  get svc() { return path.join(this.dir, this.genesis, this.program, "_service"); }
  /** { record, version } or { problem } */
  load() {
    if (!this.dir) return { problem: "store_not_configured" };
    const f = path.join(this.svc, "record.json"); let st; try { st = fs.statSync(f); } catch { return { problem: "store_empty" }; }
    if (this.cache && this.cache.mtimeMs === st.mtimeMs && this.cache.size === st.size) return this.cache.value;
    let record; try { record = readJson(f); } catch { return { problem: "store_unreadable" }; }
    const value = record.version !== SUPPORTED_RECORD_VERSION ? { problem: "store_format" } : { record, seasonById: new Map(record.seasons.map(s => [s.season, s])), etagSeed: crypto.createHash("sha256").update(`${st.mtimeMs}:${st.size}`).digest("hex").slice(0, 16) };
    this.cache = { mtimeMs: st.mtimeMs, size: st.size, value }; return value;
  }
  status() { try { return readJson(path.join(this.svc, "status.json")); } catch { return null; } }
}
/** the counting rules in force: read from a file the operator controls, never from a request */
export class RulesSource {
  constructor(file = null) { this.file = file; this.cache = null; }
  get() {
    if (!this.file) return { configured: false, rules: { name: null, note: null, trustedCreators: [], trustedValidators: [], countVoidedFinals: true } };
    const st = fs.statSync(this.file); if (this.cache && this.cache.m === st.mtimeMs) return this.cache.v;
    const raw = readJson(this.file); const v = { configured: true, rules: raw }; this.cache = { m: st.mtimeMs, v }; return v;
  }
}

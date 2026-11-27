// An append-only, hash-chained log of what the archive has done: every first copy saved, every flag raised, every sweep, every backup problem. Each line carries the hash of the line before it, so a
// line cannot be removed, changed or reordered without breaking every hash after it. The last hash (`head`) commits to the whole history: publish it, or compare it with a backup's.
// Like the archive, this protects against changes made AFTER a line was written. Someone who can rewrite the whole file can rebuild the chain: keep the head somewhere they cannot reach.
import fs from "fs"; import path from "path"; import crypto from "crypto";
export const LEDGER_START = "0".repeat(64);
const sortKeys = v => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v;
const hashOf = (prev, body) => crypto.createHash("sha256").update(prev + "\n" + JSON.stringify(sortKeys(body))).digest("hex");

/** reads and verifies a ledger file. A last line that was cut short (a process killed while writing it, so never acknowledged) is reported as `torn`, not as damage. Anything else wrong is damage */
export function readLedger(file) {
  let text; try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return { ok: true, entries: [], head: LEDGER_START, torn: 0, bytes: 0 }; throw e; }
  const lines = text.split("\n"); const endsClean = text === "" || text.endsWith("\n"); if (endsClean) lines.pop();
  const entries = []; let prev = LEDGER_START, torn = 0;
  for (const [i, line] of lines.entries()) {
    let e; try { e = JSON.parse(line); } catch { if (i === lines.length - 1 && !endsClean) { torn = line.length; break; } return { ok: false, problem: `line ${i + 1} is not JSON`, entries, head: prev }; }
    const { prev: p, hash, ...body } = e;
    if (p !== prev || hash !== hashOf(prev, body) || body.n !== i + 1) return { ok: false, problem: `line ${i + 1} does not follow from the one before it (changed, removed or reordered)`, entries, head: prev };
    entries.push(e); prev = hash;
  }
  return { ok: true, entries, head: prev, torn, bytes: text.length - torn };
}

export class Ledger {
  constructor(file, { now = () => new Date().toISOString(), log = () => {} } = {}) {
    this.file = file; this.now = now; fs.mkdirSync(path.dirname(file), { recursive: true });
    const r = readLedger(file); if (!r.ok) throw new Error(`the ledger ${file} is damaged: ${r.problem}`);
    if (r.torn) { fs.truncateSync(file, r.bytes); log(`ledger: dropped a last line that was cut short (${r.torn} bytes), never acknowledged`); }
    this.n = r.entries.length; this.head = r.head; this.entries = r.entries;
  }
  append(event) {
    const body = { n: this.n + 1, at: this.now(), ...event }; const hash = hashOf(this.head, body); const line = JSON.stringify({ ...body, prev: this.head, hash }) + "\n";
    const fd = fs.openSync(this.file, "a"); try { fs.writeSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.n++; this.head = hash; const e = JSON.parse(line); this.entries.push(e); return e;
  }
  summary() { return { entries: this.n, head: this.head }; }
}

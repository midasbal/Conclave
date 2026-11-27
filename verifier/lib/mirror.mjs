// Backup and restore. The first final copies cannot be rebuilt from the chain, so the store is mirrored to a second place with rules that make the mirror a witness, not just a copy:
//   first-final.json   copied once, never replaced; if the two ever differ that is an alarm, and neither is touched
//   ledger.jsonl       the mirror's must be a prefix of the store's; if it is not, the two histories have diverged: an alarm, and nothing is overwritten
//   flags.json         sticky: the mirror must never hold a flag the store lacks
//   observed.json      replaced (it is a cache of reads, plus the delegation records seen while delegated)
// `snapshot` writes the same irreplaceable material as ONE file (public data, no secrets) that can be committed to the repository or kept offsite. `restore` rebuilds a store from a mirror or a snapshot and checks it.
import fs from "fs"; import path from "path"; import crypto from "crypto";
import { Archive } from "./archive.mjs"; import { readLedger, LEDGER_START } from "./ledger.mjs"; import { sha256 } from "./chain.mjs"; import { atomicWrite } from "./store.mjs";

const sha = b => sha256(b).toString("hex"); const readIf = f => { try { return fs.readFileSync(f); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
const linkOnce = (to, bytes) => { fs.mkdirSync(path.dirname(to), { recursive: true }); const tmp = `${to}.${crypto.randomBytes(5).toString("hex")}.tmp`; fs.writeFileSync(tmp, bytes, { flag: "wx" }); try { fs.linkSync(tmp, to); } finally { fs.unlinkSync(tmp); } };
const replace = (to, bytes) => { fs.mkdirSync(path.dirname(to), { recursive: true }); atomicWrite(to, bytes.toString("utf8")); };

/** primaryRoot and backupRoot are <dir>/<genesis>/<program> of each. Returns what was copied and every alarm */
export function syncMirror(primaryRoot, backupRoot, { now = () => new Date().toISOString(), extra = [] } = {}) {
  const alarms = [], copied = []; const files = {};
  for (const address of fs.readdirSync(primaryRoot).filter(f => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(f)).sort()) {
    const from = path.join(primaryRoot, address), to = path.join(backupRoot, address);
    const ff = readIf(path.join(from, "first-final.json")); if (ff) { const have = readIf(path.join(to, "first-final.json")); if (!have) { linkOnce(path.join(to, "first-final.json"), ff); copied.push(`${address}/first-final.json`); } else if (!have.equals(ff)) alarms.push({ kind: "backup-mismatch", address, detail: "the first final copy in the backup differs from the store's; neither was touched" }); }
    const fl = readIf(path.join(from, "flags.json")); const bfl = readIf(path.join(to, "flags.json"));
    if (bfl) { const mine = new Set((fl ? JSON.parse(fl) : []).map(x => x.kind + "\n" + x.detail)); const lost = JSON.parse(bfl).filter(x => !mine.has(x.kind + "\n" + x.detail)); if (lost.length) alarms.push({ kind: "flags-regressed", address, detail: `the backup holds ${lost.length} flag(s) the store no longer has: ${lost.map(x => x.kind).join(", ")}` }); }
    if (fl && !(bfl && bfl.equals(fl)) && !alarms.some(a => a.address === address && a.kind === "flags-regressed")) { replace(path.join(to, "flags.json"), fl); copied.push(`${address}/flags.json`); }
    const ob = readIf(path.join(from, "observed.json")); if (ob && !(readIf(path.join(to, "observed.json"))?.equals(ob))) { replace(path.join(to, "observed.json"), ob); copied.push(`${address}/observed.json`); }
  }
  const led = readIf(path.join(primaryRoot, "_service", "ledger.jsonl")), bled = readIf(path.join(backupRoot, "_service", "ledger.jsonl"));
  if (led) { if (bled && !led.subarray(0, bled.length).equals(bled)) alarms.push({ kind: "ledger-diverged", detail: "the backup's ledger is not a prefix of the store's: the two histories differ, and nothing was overwritten" }); else if (!bled || bled.length !== led.length) { replace(path.join(backupRoot, "_service", "ledger.jsonl"), led); copied.push("_service/ledger.jsonl"); } }
  for (const name of extra) { const b = readIf(path.join(primaryRoot, "_service", name)); if (b) { replace(path.join(backupRoot, "_service", name), b); } }
  // what the mirror holds, hashed
  const walk = (dir, rel = "") => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const r = rel ? rel + "/" + e.name : e.name; if (e.isDirectory()) walk(path.join(dir, e.name), r); else if (/^(first-final|flags|observed)\.json$|^ledger\.jsonl$/.test(e.name)) files[r] = sha(fs.readFileSync(path.join(dir, e.name))); } };
  if (fs.existsSync(backupRoot)) walk(backupRoot);
  const lg = readLedger(path.join(backupRoot, "_service", "ledger.jsonl")); const body = { version: 1, syncedAt: now(), ledger: { entries: lg.entries.length, head: lg.head }, files };
  const manifest = { ...body, digest: sha(Buffer.from(Object.entries(files).sort().map(([k, v]) => `${k} ${v}`).join("\n"))) }; if (fs.existsSync(backupRoot)) replace(path.join(backupRoot, "MANIFEST.json"), Buffer.from(JSON.stringify(manifest, null, 1) + "\n"));
  return { copied, alarms, manifest };
}

/** the mirror checked on its own: every file against the manifest, every first copy against its own hash, the ledger chain. Optionally against the store as well */
export function verifyMirror(backupRoot, genesis, program, primaryRoot = null) {
  const problems = []; const m = readIf(path.join(backupRoot, "MANIFEST.json")); if (!m) return { ok: false, problems: ["no MANIFEST.json: this is not a synced backup"] };
  const manifest = JSON.parse(m);
  for (const [rel, h] of Object.entries(manifest.files)) { const b = readIf(path.join(backupRoot, rel)); if (!b) problems.push(`${rel}: listed in the manifest but missing`); else if (sha(b) !== h) problems.push(`${rel}: changed since the manifest was written`); }
  const lg = readLedger(path.join(backupRoot, "_service", "ledger.jsonl")); if (!lg.ok) problems.push(`ledger: ${lg.problem}`); else if (lg.head !== manifest.ledger.head) problems.push("ledger: its head is not the one in the manifest");
  const arch = new Archive(path.dirname(path.dirname(backupRoot)), genesis, program); let copies = 0; for (const a of arch.addresses()) { const f = arch.first(a); if (f?.damaged) problems.push(`${a}: ${f.damaged}`); else if (f) copies++; }
  if (primaryRoot) { const pl = readIf(path.join(primaryRoot, "_service", "ledger.jsonl")), bl = readIf(path.join(backupRoot, "_service", "ledger.jsonl")); if (pl && bl && !pl.subarray(0, bl.length).equals(bl)) problems.push("ledger: the backup's is not a prefix of the store's"); }
  return { ok: problems.length === 0, problems, copies, ledger: manifest.ledger, syncedAt: manifest.syncedAt };
}

/** every irreplaceable file of a store, as one JSON value. Public data only: first copies, flags, observations and the ledger */
export function makeSnapshot(storeRoot, genesis, program, { now = () => new Date().toISOString() } = {}) {
  const arch = new Archive(path.dirname(path.dirname(storeRoot)), genesis, program); const copies = {}, flags = {}, observed = {};
  for (const a of arch.addresses()) { const ff = readIf(path.join(arch.dirOf(a), "first-final.json")); if (ff) copies[a] = JSON.parse(ff); const fl = readIf(path.join(arch.dirOf(a), "flags.json")); if (fl) flags[a] = JSON.parse(fl); const ob = readIf(path.join(arch.dirOf(a), "observed.json")); if (ob) observed[a] = JSON.parse(ob); }
  const lg = readLedger(path.join(storeRoot, "_service", "ledger.jsonl")); if (!lg.ok) throw new Error("the ledger is damaged: " + lg.problem);
  const body = { type: "conclave-record-snapshot", version: 1, genesis, program, takenAt: now(), ledger: lg.entries, copies, flags, observed };
  return { ...body, digest: snapshotDigest(body) };
}
export const snapshotDigest = b => sha(Buffer.from(JSON.stringify([b.genesis, b.program, Object.keys(b.copies).sort().map(a => [a, b.copies[a].sha256]), b.ledger.at(-1)?.hash ?? LEDGER_START])));
/** a snapshot read back and checked: every copy against its own hash, the ledger chain, and the digest */
export function verifySnapshot(s) {
  const problems = []; if (s?.type !== "conclave-record-snapshot") return { ok: false, problems: ["not a snapshot"] };
  for (const [a, c] of Object.entries(s.copies)) if (sha(Buffer.from(c.data, "base64")) !== c.sha256 || c.address !== a || c.genesis !== s.genesis || c.program !== s.program) problems.push(`${a}: the first copy does not match its own hash, address, cluster or program`);
  let prev = LEDGER_START; for (const [i, e] of s.ledger.entries()) { const { prev: p, hash, ...body } = e; const h = sha(Buffer.from(prev + "\n" + JSON.stringify(sortKeys(body)))); if (p !== prev || hash !== h || body.n !== i + 1) { problems.push(`ledger line ${i + 1} does not follow from the one before it`); break; } prev = hash; }
  // the ledger and the copies must agree both ways: a copy the ledger never recorded (or recorded with another hash) is not trusted, and neither is a snapshot that has lost a copy the ledger remembers
  const known = new Map(s.ledger.filter(e => e.type === "first-copy" || e.type === "import-first-copy").map(e => [e.address, e.sha256])); for (const [a, c] of Object.entries(s.copies)) if (known.get(a) !== c.sha256) problems.push(`${a}: the ledger does not record this first copy`);
  for (const a of known.keys()) if (!s.copies[a]) problems.push(`${a}: the ledger records a first copy that the snapshot does not hold`);
  if (s.digest !== snapshotDigest(s)) problems.push("the digest does not match the content");
  return { ok: problems.length === 0, problems, copies: Object.keys(s.copies).length, ledgerEntries: s.ledger.length };
}
const sortKeys = v => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v;
/** rebuilds a store from a snapshot into a folder that holds no store yet. The result is verified before it is reported */
export function restoreSnapshot(s, dir) {
  const v = verifySnapshot(s); if (!v.ok) throw new Error("the snapshot does not verify: " + v.problems.join("; "));
  const root = path.join(dir, s.genesis, s.program); if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error(`${root} is not empty: restore only into a folder with no store`);
  for (const [a, c] of Object.entries(s.copies)) linkOnce(path.join(root, a, "first-final.json"), Buffer.from(JSON.stringify(c, null, 1) + "\n"));
  for (const [a, f] of Object.entries(s.flags)) replace(path.join(root, a, "flags.json"), Buffer.from(JSON.stringify(f, null, 1) + "\n"));
  for (const [a, o] of Object.entries(s.observed)) replace(path.join(root, a, "observed.json"), Buffer.from(JSON.stringify(o, null, 1) + "\n"));
  fs.mkdirSync(path.join(root, "_service"), { recursive: true }); fs.writeFileSync(path.join(root, "_service", "ledger.jsonl"), s.ledger.map(e => JSON.stringify(e) + "\n").join(""), { flag: "wx" });
  return { root, copies: v.copies, ledgerEntries: v.ledgerEntries };
}

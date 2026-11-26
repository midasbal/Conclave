// Custody of what opens a sealed strategy's commitment: the key file, the portable encrypted recovery bundle, and the check that must pass before this client will close a strategy.
// Pure functions over bytes and files: no chain, no keys, no logging, so all of it is tested offline. See docs/CUSTODY.md.
import crypto from "crypto"; import fs from "fs"; import path from "path"; import util from "util"; import { fileURLToPath } from "url"; import bs58 from "bs58";
import { codeCommit, parseSealedAccount } from "./artifact.mjs";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const must = (c, m) => { if (!c) throw new Error(m); };
const sha = b => crypto.createHash("sha256").update(b).digest();

// ================================ files that must never be lost ================================
function fsyncDir(dir) { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
/** Write a file so that after a crash at any point it holds either its old content or the whole new content: temp file (0600), fsync, then rename (or link, which never overwrites), fsync of the directory. */
export function writeDurable(file, data, { noClobber = false } = {}) {
  const dir = path.dirname(file); const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  try { const fd = fs.openSync(tmp, "wx", 0o600); try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (noClobber) fs.linkSync(tmp, file); else fs.renameSync(tmp, file); fsyncDir(dir); }
  finally { fs.rmSync(tmp, { force: true }); }
}
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** one writer at a time. A lock left by a killed process is NOT stolen (two waiters could both steal it): it is reported, and a person removes it. */
function withLock(file, fn, waitMs = 15_000) {
  const lock = file + ".lock"; const t0 = Date.now(); let fd;
  for (;;) { try { fd = fs.openSync(lock, "wx", 0o600); break; } catch (e) { if (e.code !== "EEXIST") throw e; if (Date.now() - t0 > waitMs) throw new Error(`the key file is locked (${lock}). If no other Conclave process is running, remove that file and retry. Nothing was written.`); pause(20); } }
  try { return fn(); } finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
}
/** the key file's records. A file that exists and cannot be parsed is an error, never an empty list (an empty list would be written back over it) */
export function readRecords(file) { let t; try { t = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  let a; try { a = JSON.parse(t); } catch { throw new Error(`the key file ${file} is not readable JSON; it has not been touched`); } must(Array.isArray(a), `the key file ${file} is not a list; it has not been touched`); return a; }
const secretOf = r => `${r.id}:${r.salt}:${r.code}`;
function replaceRecords(file, next) { writeDurable(file, JSON.stringify(next, null, 1)); const back = new Set(readRecords(file).map(secretOf)); must(next.every(r => back.has(secretOf(r))), "the key file does not read back as written"); }
/** rewrite the whole key file. Refuses any rewrite that would drop or change a secret it already holds. */
export function writeRecords(file, next) { return withLock(file, () => { const keep = new Set(next.map(secretOf)); const lost = readRecords(file).filter(r => !keep.has(secretOf(r)));
  must(lost.length === 0, `refusing to rewrite the key file: it would drop or change the secret of strategy ${lost.map(r => r.id).join(", ")}`); replaceRecords(file, next); }); }
/** add one strategy's record, durably, and read it back. Returns once it is on disk. */
export function addRecord(file, rec) { must(rec && rec.id && /^[0-9a-f]{64}$/.test(rec.salt) && /^([0-9a-f]{2})+$/.test(rec.code), "a key-file record needs an id, a 32-byte salt and the code");
  return withLock(file, () => { const all = readRecords(file); const had = all.find(r => r.id === rec.id); if (had) { must(secretOf(had) === secretOf(rec), `the key file already holds a different secret for strategy ${rec.id}; not overwritten`); return false; } replaceRecords(file, [...all, rec]); return true; }); }

// ================================ the recovery bundle ================================
export const BUNDLE_FORMAT = "conclave-recovery-bundle", BUNDLE_VERSION = 1, BUNDLE_EXT = ".cvbundle";
/** scrypt, the parameters OWASP lists for password storage (N = 2^17, r = 8, p = 1: 128 MiB per guess). Read back from each file, within fixed bounds. */
export const KDF = Object.freeze({ N: 1 << 17, r: 8, p: 1 }); const MIN_N = 1 << 15, MAX_N = 1 << 20;
export const MIN_PASSPHRASE = 12;
/** the encrypted part is padded to a multiple of this, so a file's size does not tell which strategy (or which source length) it holds */
export const PAD = 8192;
const KEYS_OF = { "": ["cipher", "ciphertext", "format", "kdf", "public", "tag", "version"], public: ["cluster", "commitment", "id", "owner", "program"], cluster: ["genesisHash", "name"], kdf: ["N", "name", "p", "r", "salt"], cipher: ["name", "nonce"] };
const canonical = v => v && typeof v === "object" && !Array.isArray(v) ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}" : JSON.stringify(v);
const aad = b => Buffer.from(canonical({ format: b.format, version: b.version, public: b.public, kdf: b.kdf, cipher: b.cipher }));
function passBytes(p) { must(typeof p === "string" && p.normalize("NFKC").length >= MIN_PASSPHRASE, `the passphrase must be at least ${MIN_PASSPHRASE} characters`); return Buffer.from(p.normalize("NFKC"), "utf8"); }
const deriveKey = (passphrase, salt, { N, r, p }) => crypto.scryptSync(passBytes(passphrase), salt, 32, { N, r, p, maxmem: 256 * N * r });
const isKey = s => { try { return typeof s === "string" && bs58.decode(s).length === 32; } catch { return false; } };

/** Encrypt one strategy's opening. fields: { program, cluster: { name, genesisHash }, id, owner, salt, code, source?, name?, vmPins? }. Returns the file's bytes. */
export function sealBundle({ program, cluster, id, owner, salt, code, source = null, name = null, vmPins = null }, passphrase) {
  salt = Buffer.from(salt); code = Buffer.from(code); must(salt.length === 32 && code.length >= 4, "a bundle needs a 32-byte salt and the bytecode"); must(isKey(program) && isKey(owner) && /^\d{1,20}$/.test(String(id)) && cluster?.name && cluster?.genesisHash, "a bundle needs the program, cluster, id and owner");
  const body = Buffer.from(JSON.stringify({ salt: salt.toString("hex"), code: code.toString("hex"), source, name, ruleset: code[0], vmPins }), "utf8"); const plain = Buffer.alloc(Math.ceil((4 + body.length) / PAD) * PAD); plain.writeUInt32LE(body.length, 0); body.copy(plain, 4);
  const out = { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, public: { program, cluster: { name: cluster.name, genesisHash: cluster.genesisHash }, id: String(id), owner, commitment: codeCommit(salt, code).toString("hex") }, kdf: { name: "scrypt", ...KDF, salt: crypto.randomBytes(16).toString("hex") }, cipher: { name: "aes-256-gcm", nonce: crypto.randomBytes(12).toString("hex") } };
  const key = deriveKey(passphrase, Buffer.from(out.kdf.salt, "hex"), out.kdf); const c = crypto.createCipheriv("aes-256-gcm", key, Buffer.from(out.cipher.nonce, "hex"), { authTagLength: 16 }); c.setAAD(aad(out));
  out.ciphertext = Buffer.concat([c.update(plain), c.final()]).toString("base64"); out.tag = c.getAuthTag().toString("hex"); key.fill(0); plain.fill(0); return Buffer.from(JSON.stringify(out, null, 1) + "\n");
}
/** Decrypt and authenticate. Throws unless the whole file is intact, the passphrase is right, and the salt and code inside open the commitment in the header.
 *  The returned object's secrets (salt, code, source) are not enumerable: printing or serialising it shows only the public header. */
export function openBundle(bytes, passphrase) {
  let b; try { b = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { throw new Error("not a recovery bundle (not readable JSON)"); }
  const shape = (o, k) => must(o && typeof o === "object" && Object.keys(o).sort().join() === KEYS_OF[k].join(), `not a recovery bundle (unexpected fields in ${k || "the file"})`);
  shape(b, ""); must(b.format === BUNDLE_FORMAT && b.version === BUNDLE_VERSION, "not a recovery bundle, or a version this client does not read"); shape(b.public, "public"); shape(b.public.cluster, "cluster"); shape(b.kdf, "kdf"); shape(b.cipher, "cipher");
  must(b.kdf.name === "scrypt" && b.cipher.name === "aes-256-gcm", "unknown key derivation or cipher");
  // the cost parameters come from the file, so they are bounded BEFORE any work: a hostile file cannot ask for unbounded memory, or for a cheap derivation
  must(Number.isInteger(b.kdf.N) && b.kdf.N >= MIN_N && b.kdf.N <= MAX_N && (b.kdf.N & (b.kdf.N - 1)) === 0 && b.kdf.r === 8 && b.kdf.p === 1, "key derivation parameters out of bounds");
  must(/^[0-9a-f]{32}$/.test(b.kdf.salt) && /^[0-9a-f]{24}$/.test(b.cipher.nonce) && /^[0-9a-f]{32}$/.test(b.tag), "malformed bundle header");
  const key = deriveKey(passphrase, Buffer.from(b.kdf.salt, "hex"), b.kdf); let plain;
  try { const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(b.cipher.nonce, "hex"), { authTagLength: 16 }); d.setAAD(aad(b)); d.setAuthTag(Buffer.from(b.tag, "hex")); plain = Buffer.concat([d.update(Buffer.from(b.ciphertext, "base64")), d.final()]); }
  catch { throw new Error("cannot open the bundle: wrong passphrase, or the file was altered"); } finally { key.fill(0); }
  const n = plain.readUInt32LE(0); must(n <= plain.length - 4, "malformed bundle body"); const s = JSON.parse(plain.subarray(4, 4 + n).toString("utf8")); plain.fill(0);
  const salt = Buffer.from(s.salt, "hex"), code = Buffer.from(s.code, "hex"); must(codeCommit(salt, code).toString("hex") === b.public.commitment, "the salt and code in the bundle do not open its commitment");
  const opened = { public: Object.freeze({ ...b.public }), name: s.name, ruleset: s.ruleset, vmPins: s.vmPins };
  for (const [k, v] of Object.entries({ salt, code, source: s.source })) Object.defineProperty(opened, k, { value: v, enumerable: false });
  opened[util.inspect.custom] = () => `RecoveryBundle(strategy ${b.public.id})`; return opened;
}
/** a bundle (even encrypted) is never written inside the repository, where a commit could carry it away. Symlinks are resolved first. */
export function assertOutsideRepo(file) { let d = path.dirname(path.resolve(file)); const tail = [path.basename(file)]; while (!fs.existsSync(d)) { tail.unshift(path.basename(d)); d = path.dirname(d); }
  const rel = path.relative(fs.realpathSync(REPO), path.join(fs.realpathSync(d), ...tail)); must(rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel), `refusing to write a recovery bundle inside the repository: ${file}`); }
const sameOpening = (a, f) => a.public.id === String(f.id) && a.public.owner === f.owner && a.public.program === f.program && a.public.cluster.genesisHash === f.cluster.genesisHash && a.salt.equals(Buffer.from(f.salt)) && a.code.equals(Buffer.from(f.code));
/** Write a bundle, then read it back FROM DISK and open it. An existing file is never overwritten: it is accepted if it already opens to the same strategy, refused otherwise. */
export function writeBundle(file, fields, passphrase) {
  assertOutsideRepo(file); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const reread = () => openBundle(fs.readFileSync(file), passphrase);
  const existing = () => { let o; try { o = reread(); } catch (e) { throw new Error(`${file} already exists and was NOT overwritten (${e.message})`); } must(sameOpening(o, fields), `${file} already exists, holds something else, and was NOT overwritten`); return { file, reused: true, opened: o }; };
  if (fs.existsSync(file)) return existing();
  try { writeDurable(file, sealBundle(fields, passphrase), { noClobber: true }); } catch (e) { if (e.code === "EEXIST") return existing(); throw e; }
  const o = reread(); must(sameOpening(o, fields), "the bundle read back from disk does not match what was written"); return { file, reused: false, opened: o };
}
/** the named checks of an opened bundle against what is expected (from the chain). Only the fields given are checked. */
export function checkOpening(opened, expect) { const p = opened.public; const rows = [["program", p.program], ["genesisHash", p.cluster.genesisHash], ["id", p.id], ["owner", p.owner], ["commitment", p.commitment]];
  return rows.filter(([k]) => expect[k] !== undefined).map(([k, v]) => ({ name: `the bundle's ${k} is the expected one`, ok: v === String(expect[k]) })); }

// ================================ from the sealed account, and before a close ================================
/** what the sealed account holds, accepted only if its own salt and code open its own commitment */
export function fromSealedAccount(data) { const s = parseSealedAccount(data); must(s.salt.length === 32 && s.code.length === s.len, "short sealed account"); must(codeCommit(s.salt, s.code).equals(s.commitment), "the sealed account's salt and code do not open its commitment");
  return { id: s.id.toString(), owner: bs58.encode(s.owner), salt: Buffer.from(s.salt), code: Buffer.from(s.code), commitment: Buffer.from(s.commitment) }; }
const M_REG = 0x5245_4753;
export function parseRegistry(d) { must(d && d.length >= 128 && d.readUInt32LE(0) === M_REG, "not an open registry account"); return { owner: bs58.encode(d.subarray(8, 40)), id: d.readBigUInt64LE(40).toString(), commitment: Buffer.from(d.subarray(48, 80)) }; }
const TICKETS = new WeakMap();
/** The ticket without which this client will not build a CloseStrategy. It is issued only after a bundle has been read from disk, opened with the passphrase, and shown to be THIS strategy:
 *  the same program, cluster, id and owner, and a commitment equal to the one in the sealed account and in the registry (so the bundle's salt and code are the sealed ones). */
export function issueCloseTicket({ file, passphrase, program, genesisHash, id, owner, sealedData, registryData }) {
  const bytes = fs.readFileSync(file); const o = openBundle(bytes, passphrase); const s = fromSealedAccount(sealedData); const r = parseRegistry(registryData); const want = { program, genesisHash, id: String(id), owner, commitment: s.commitment.toString("hex") };
  const checks = [...checkOpening(o, want), { name: "the sealed account is this id and owner", ok: s.id === String(id) && s.owner === owner }, { name: "the registry is this id, owner and commitment", ok: r.id === String(id) && r.owner === owner && r.commitment.equals(s.commitment) }, { name: "the bundle's salt and bytecode are the sealed ones", ok: o.salt.equals(s.salt) && o.code.equals(s.code) }];
  const bad = checks.filter(c => !c.ok); must(bad.length === 0, `the recovery bundle does not cover this strategy, so it will not be closed: ${bad.map(c => c.name).join("; ")} failed`);
  const ticket = Object.freeze({ file: path.resolve(file), id: String(id), owner }); TICKETS.set(ticket, { program, id: String(id), owner, file: path.resolve(file), digest: sha(bytes).toString("hex") }); return ticket;
}
/** throws unless the ticket is a real one for this exact strategy and the bundle file it was issued for is still there, byte for byte */
export function assertCloseTicket(ticket, { program, id, owner }) {
  const t = ticket && TICKETS.get(ticket); must(t, "no verified recovery bundle: closing wipes the sealed salt and code, so this client builds CloseStrategy only after a bundle has been written, reopened and checked against the commitment");
  must(t.program === program && t.id === String(id) && t.owner === owner, "that recovery bundle was verified for a different strategy");
  let now; try { now = sha(fs.readFileSync(t.file)).toString("hex"); } catch { throw new Error(`the verified recovery bundle is gone: ${t.file}`); } must(now === t.digest, `the recovery bundle changed after it was verified: ${t.file}`);
}
/** write the bundle from the sealed account (or accept an existing one that matches), reopen it from disk, verify it against the chain data, and issue the ticket */
export function exportForClose({ file, passphrase, program, cluster, id, owner, sealedData, registryData, source = null, name = null, vmPins = null }) {
  const s = fromSealedAccount(sealedData); must(s.id === String(id) && s.owner === owner, "the sealed account is not this strategy of this owner");
  writeBundle(file, { program, cluster, id: s.id, owner: s.owner, salt: s.salt, code: s.code, source, name, vmPins }, passphrase);
  return issueCloseTicket({ file, passphrase, program, genesisHash: cluster.genesisHash, id, owner, sealedData, registryData });
}

// ================================ passphrases ================================
const B32 = "abcdefghijkmnpqrstuvwxyz23456789";
/** 160 random bits as eight groups of four characters */
export function newPassphrase() { const b = crypto.randomBytes(32); return Array.from({ length: 8 }, (_, g) => Array.from({ length: 4 }, (_, i) => B32[b[g * 4 + i] & 31]).join("")).join("-"); }
/** a passphrase kept in a file: refused if anyone but the owner can read it */
export function passphraseFromFile(file) { const m = fs.statSync(file).mode & 0o077; must(m === 0, `the passphrase file ${file} is readable by others; chmod 600 it`); return fs.readFileSync(file, "utf8").replace(/\r?\n$/, ""); }

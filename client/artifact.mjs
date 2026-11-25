// The sealed artifact: what an authored strategy becomes when it is sealed. Pure functions only (no chain, no keys, no logging), so the secret handling can be tested offline.
//
//   private record (one per strategy, kept in strategies.json next to the keys, mode 0600, never in the repo):
//     id, owner, name, salt (32 bytes hex, THE secret), code (bytecode hex), artifact { v, format, ruleset, source_sha256, code_sha256, work, division, division_index }
//   public (the registry entry on base): owner, id, and ONLY the salted commitment sha256("CNCL-CODE-v1", salt, code).
//
// Why the hashes below are private: source_sha256 and code_sha256 are UNSALTED hashes of the strategy. Anyone who published one could hash the known preset strategies and recognise it.
// The salted commitment is the only derivative that may be public. Nothing in this module prints; callers must not log salt, code or either hash (log commitment, id, division, work).
import crypto from "crypto";
export const ARTIFACT_V = 1; export const DIVISIONS = [16, 32, 64]; const DOM_CODE = Buffer.from("CNCL-CODE-v1");
const sha = b => crypto.createHash("sha256").update(b).digest();
/** the commitment the program recomputes at Seal: sha256("CNCL-CODE-v1" || salt || code) */
export const codeCommit = (salt, code) => sha(Buffer.concat([DOM_CODE, Buffer.from(salt), Buffer.from(code)]));
export const newSalt = () => crypto.randomBytes(32);
const hx = b => Buffer.from(b).toString("hex");
export const STRAT_MAGIC = 0x5354_5254; // M_STRAT in program/src/lib.rs, pinned by tests/svm/tests/authored.rs
const must = (c, m) => { if (!c) throw new Error(m); };

/** Assemble authored source with the author tool (A = await load() from client/author.mjs) and build the private artifact. Throws with the assembler's listing on any error. */
export function buildArtifact(src, A, { name } = {}) {
  const a = A.assemble(src); if (!a.ok) throw new Error("source does not assemble:\n" + A.listing(src));
  const code = Buffer.from(a.bytecode, "hex"); const w = a.work;
  // independent recomputation of everything the assembler reports: the artifact is only as good as these agreeing
  must(hx(sha(code)) === a.code_sha256, "assembler code hash disagrees with sha256(bytecode)"); must(hx(sha(Buffer.from(a.canonical, "utf8"))) === a.source_sha256, "assembler source hash disagrees with sha256(canonical source)");
  must(code.length === 4 + 4 * a.ops.length && code[1] === a.ops.length, "bytecode header disagrees with the op count"); must(w === a.ops.reduce((s, o) => s + o.work, 0), "total work disagrees with the per-op breakdown");
  const idx = DIVISIONS.findIndex(d => w <= d); must(idx >= 0, `work ${w} is over the cap`); must(a.division === DIVISIONS[idx], "assembler division disagrees with the work cost");
  return { v: ARTIFACT_V, format: a.format, ruleset: a.ruleset, name: name ?? a.name ?? "unnamed", source_sha256: a.source_sha256, code_sha256: a.code_sha256, work: w, division: a.division, division_index: idx, code };
}
/** the artifact metadata stored with the strategy (what flows.register merges into the strategies.json entry) */
export const artifactMeta = artifact => ({ artifact: { v: artifact.v, format: artifact.format, ruleset: artifact.ruleset, source_sha256: artifact.source_sha256, code_sha256: artifact.code_sha256, work: artifact.work, division: artifact.division, division_index: artifact.division_index } });
/** the record strategies.json holds (same shape as before, with the artifact metadata added): the ONLY place the salt is kept */
export function sealedRecord({ id, owner, name, salt, artifact }) {
  return { id: String(id), owner, name, salt: hx(salt), code: hx(artifact.code), artifact: { v: artifact.v, format: artifact.format, ruleset: artifact.ruleset, source_sha256: artifact.source_sha256, code_sha256: artifact.code_sha256, work: artifact.work, division: artifact.division, division_index: artifact.division_index } };
}
/** what may be shown or logged about a sealed strategy: no salt, no code, no hash of the code */
export const publicView = ({ id, owner, commitment, artifact }) => ({ id: String(id), owner, commitment: hx(commitment), ruleset: artifact.ruleset, division: artifact.division, work: artifact.work });

/** Local proof that what was sealed is what was authored. `opened` is what the owner reads back: { code, salt, commitment } (bytes). Returns named checks; every one must be true. */
export function proveSourceEqualsSealed(src, A, opened) {
  const re = A.assemble(src); const code2 = re.ok ? Buffer.from(re.bytecode, "hex") : Buffer.alloc(0); const sealed = Buffer.from(opened.code);
  const checks = [
    ["the source assembles again to the same bytecode that was sealed", re.ok && Buffer.compare(code2, sealed) === 0],
    ["sha256(sealed bytecode) equals the artifact's code hash", re.ok && hx(sha(sealed)) === re.code_sha256],
    ["the commitment opens: sha256(domain, stored salt, sealed code) equals the registry commitment", Buffer.compare(codeCommit(opened.salt, sealed), Buffer.from(opened.commitment)) === 0],
    ["the sealed code disassembles and reassembles to itself", (() => { const d = A.disassemble(sealed); const r = A.assemble(d); return r.ok && r.bytecode === hx(sealed); })()],
    ["the sealed code is canonical and within the work cap", (() => { const r = A.assemble(A.disassemble(sealed)); return r.ok && r.work <= 64; })()],
  ];
  return { ok: checks.every(c => c[1]), checks: checks.map(([name, ok]) => ({ name, ok })) };
}
/** parse the owner's view of a sealed strategy account (layout mirror of program/src/lib.rs: 0 magic | 4 len u16 | 8 owner | 40 id | 48 commitment | 104 salt | 136 code) */
export function parseSealedAccount(d) { must(d && d.length >= 136 && d.readUInt32LE(0) === STRAT_MAGIC, "not a sealed strategy account"); const len = d.readUInt16LE(4); return { len, owner: d.subarray(8, 40), id: d.readBigUInt64LE(40), commitment: d.subarray(48, 80), salt: d.subarray(104, 136), code: d.subarray(136, 136 + len) }; }
/** registry hygiene: the public account may carry the id, the owner and the salted commitment and nothing from which the code, or an unsalted hash of it, can be recognised. Returns named checks. */
export function registryChecks(regData, { code, salt, commitment }) {
  // every 8-byte window of the code that is not a run of one repeated byte (those occur in any zero-padded record)
  const windows = (c, n) => { const out = []; for (let i = 0; i + n <= c.length; i++) { const w = c.subarray(i, i + n); if (new Set(w).size > 2) out.push(w); } return out; };
  const found = needle => needle.length > 0 && regData.includes(Buffer.from(needle)); const h = b => sha(b);
  const unsalted = [["bare sha256(code)", h(code)], ["sha256(domain || code)", h(Buffer.concat([DOM_CODE, code]))], ["sha256(domain || 32 zero bytes || code)", h(Buffer.concat([DOM_CODE, Buffer.alloc(32), code]))], ["sha256(code || domain)", h(Buffer.concat([code, DOM_CODE]))]];
  return [["the registry holds the salted commitment", regData.subarray(48, 80).equals(Buffer.from(commitment))],
    ["the registry does not hold the code (or any 8-byte window of it)", !found(code) && !windows(code, 8).some(w => found(w))],
    ["the registry does not hold the salt", !found(salt)], ...unsalted.map(([n, v]) => [`the registry does not hold ${n}`, !found(v)]),
    ["the commitment is not any unsalted hash of the code", !unsalted.some(([, v]) => v.equals(Buffer.from(commitment)))]].map(([name, ok]) => ({ name, ok }));
}

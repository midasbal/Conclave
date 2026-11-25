// The sealed artifact, offline and keyless: salted commitment, source-equals-sealed proof, registry hygiene, strategies.json custody, salt discipline. Real crypto, the real WASM assembler, no chain.
//   node --test tests/artifact.test.mjs      (needs: cargo build --release --target wasm32-unknown-unknown -p conclave-author)
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto"; import { fileURLToPath } from "node:url";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// lib.mjs reads key files at import unless told otherwise: point it at a throwaway key folder and a throwaway signer
const KEYS = fs.mkdtempSync(path.join(os.tmpdir(), "ca-keys-")); process.env.CONCLAVE_KEYS = KEYS; process.env.CONCLAVE_PROGRAM_ID = "HZ3b6zexePfH5cXT5qaKKHfA8B29xwBGGYgu84WgMdne";
const kp = (await import(path.join(root, "client/node_modules/@solana/web3.js/lib/index.cjs.js"))).default.Keypair.generate(); process.env.CONCLAVE_SIGNER = JSON.stringify(Array.from(kp.secretKey));
const L = await import(path.join(root, "client/lib.mjs")); const art = await import(path.join(root, "client/artifact.mjs")); const { load } = await import(path.join(root, "client/author.mjs"));
const A = await load(); const srcOf = n => fs.readFileSync(path.join(root, "strategies", n + ".cvs"), "utf8"); const names = fs.readdirSync(path.join(root, "strategies")).filter(f => f.endsWith(".cvs")).map(f => f.slice(0, -4)).sort();
const regData = (id, owner, commitment, extra = {}) => { const d = Buffer.alloc(128); d.writeUInt32LE(0x5245_4753, 0); Buffer.from(owner).copy(d, 8); d.writeBigUInt64LE(BigInt(id), 40); Buffer.from(commitment).copy(d, 48); d.writeUInt32LE(0xffffffff, 84); return d; };
const captured = []; const origLog = console.log, origErr = console.error, origWrite = process.stdout.write.bind(process.stdout); // salt discipline: capture everything printed while the artifact code runs

test("the salted commitment matches an independent implementation, the program's rule and lib.codeCommit", () => {
  const salt = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)); const code = Buffer.from("0204000002000400150000040a0000001f000000", "hex");
  assert.equal(art.codeCommit(salt, code).toString("hex"), "4544b19d44eaa24e89c4d24087eab0f88bacd07d9a3f6b2b0749c74edae2dab4", "known answer computed with Python hashlib");
  assert.equal(art.codeCommit(salt, code).toString("hex"), L.codeCommit(salt, code).toString("hex"), "the artifact and the client library commit identically");
  const other = Buffer.from(salt); other[0] ^= 1; assert.notEqual(art.codeCommit(other, code).toString("hex"), art.codeCommit(salt, code).toString("hex")); assert.notEqual(art.codeCommit(salt, Buffer.concat([code, Buffer.from([0])])).toString("hex"), art.codeCommit(salt, code).toString("hex")); });

test("every example builds an artifact whose work, division and hashes are recomputed independently", () => {
  const want = { at_the_cap: [64, 64, 2], breakout_with_stop: [40, 64, 2], calm_trend: [6, 16, 0], ema_cross: [7, 16, 0], mean_reversion: [31, 32, 1], momentum: [4, 16, 0] };
  for (const n of names) { const a = art.buildArtifact(srcOf(n), A); assert.deepEqual([a.work, a.division, a.division_index], want[n], n); assert.equal(a.ruleset, 2); assert.equal(a.format, 1); assert.equal(art.DIVISIONS[a.division_index], a.division);
    assert.equal(crypto.createHash("sha256").update(a.code).digest("hex"), a.code_sha256); assert.equal(a.code.length, 4 + 4 * a.code[1]); } });
test("an over-cap or malformed source builds no artifact", () => { const over = "conclave-strategy 1 ruleset 2\nz = zw 32\nw = wsum 12\n" + "x = sig T5\n".repeat(12) + "pos x\n"; assert.throws(() => art.buildArtifact(over, A), /does not assemble[\s\S]*over the cap of 64/); assert.throws(() => art.buildArtifact("nonsense", A), /does not assemble/); assert.throws(() => art.buildArtifact("conclave-strategy 1 ruleset 3\nnop\n", A), /ruleset 3/); });

test("source equals sealed: the proof passes for what was authored and fails for anything else", () => {
  for (const n of names) { const a = art.buildArtifact(srcOf(n), A); const salt = art.newSalt(); const commitment = art.codeCommit(salt, a.code); const proof = art.proveSourceEqualsSealed(srcOf(n), A, { code: a.code, salt, commitment }); assert.ok(proof.ok, `${n}: ${JSON.stringify(proof.checks.filter(c => !c.ok))}`); assert.equal(proof.checks.length, 5); }
  const a = art.buildArtifact(srcOf("momentum"), A); const salt = art.newSalt(); const commitment = art.codeCommit(salt, a.code); const bad = (o, why) => assert.equal(art.proveSourceEqualsSealed(srcOf("momentum"), A, o).ok, false, why);
  const tampered = Buffer.from(a.code); tampered[8 + 3] ^= 1; bad({ code: tampered, salt, commitment }, "one flipped bit in the sealed code"); bad({ code: a.code, salt: art.newSalt(), commitment }, "the wrong salt does not open the commitment"); bad({ code: a.code, salt, commitment: art.codeCommit(salt, tampered) }, "a commitment to different code");
  assert.equal(art.proveSourceEqualsSealed(srcOf("calm_trend"), A, { code: a.code, salt, commitment }).ok, false, "a different source than the one sealed"); });

test("the sealed record keeps the salt and the code in strategies.json and nothing public carries them", () => {
  const a = art.buildArtifact(srcOf("mean_reversion"), A); const salt = art.newSalt(); const commitment = art.codeCommit(salt, a.code); const rec = art.sealedRecord({ id: 123n, owner: 3, name: "n", salt, artifact: a });
  assert.deepEqual(Object.keys(rec).sort(), ["artifact", "code", "id", "name", "owner", "salt"], "same shape as before with the artifact added"); assert.equal(rec.salt, salt.toString("hex")); assert.equal(rec.code, a.code.toString("hex")); assert.equal(rec.artifact.division, 32); assert.equal(rec.artifact.division_index, 1);
  assert.deepEqual(rec.artifact, art.artifactMeta(a).artifact);
  const pub = JSON.stringify(art.publicView({ id: 123n, owner: "o", commitment, artifact: a })); for (const secret of [salt.toString("hex"), a.code.toString("hex"), a.code_sha256, a.source_sha256]) assert.ok(!pub.includes(secret), "public view carries no salt, code or unsalted hash"); assert.ok(pub.includes(commitment.toString("hex")));
  // custody: strategies.json is written 0600 in the key folder, via the same saveStrats the flows use
  L.saveStrats([rec]); const f = path.join(KEYS, "strategies.json"); assert.equal((fs.statSync(f).mode & 0o777).toString(8), "600"); assert.deepEqual(L.loadStrats(), [rec]); assert.ok(path.relative(root, f).startsWith(".."), "the key folder is outside the repository (path.relative, not a string prefix: conclave-keys is a sibling of conclave)"); assert.ok(!path.relative(root, path.join(path.dirname(root), "conclave-keys", "x")).startsWith("..") === false); });

test("registry hygiene: only id, owner and the salted commitment; the checks have teeth", () => {
  const a = art.buildArtifact(srcOf("breakout_with_stop"), A); const salt = art.newSalt(); const commitment = art.codeCommit(salt, a.code); const owner = crypto.randomBytes(32); const good = regData(7, owner, commitment);
  const res = art.registryChecks(good, { code: a.code, salt, commitment }); assert.ok(res.every(c => c.ok), "FAILED: " + JSON.stringify(res.filter(c => !c.ok))); assert.equal(res.length, 8);
  const dirty = (mut, name) => { const d = Buffer.from(good); mut(d); const r = art.registryChecks(d, { code: a.code, salt, commitment }); assert.ok(r.some(c => !c.ok), name + " must be caught"); };
  const sha = b => crypto.createHash("sha256").update(b).digest(); const DOM = Buffer.from("CNCL-CODE-v1");
  dirty(d => sha(a.code).copy(d, 80), "bare sha256(code)"); dirty(d => sha(Buffer.concat([DOM, a.code])).copy(d, 80), "unsalted domain hash"); dirty(d => sha(Buffer.concat([DOM, Buffer.alloc(32), a.code])).copy(d, 80), "zero-salted hash"); dirty(d => salt.copy(d, 80), "the salt"); dirty(d => a.code.subarray(8, 24).copy(d, 96), "a slice of the code");
  dirty(d => sha(a.code).copy(d, 48), "an unsalted hash used AS the commitment"); });

test("preparing and describing an artifact prints nothing, and no printed or public form contains the salt", () => {
  const out = []; console.log = (...x) => out.push(x.join(" ")); console.error = (...x) => out.push(x.join(" ")); process.stdout.write = (c, ...r) => { out.push(String(c)); return true; };
  let salt, a, commitment; try { a = art.buildArtifact(srcOf("momentum"), A); salt = art.newSalt(); commitment = art.codeCommit(salt, a.code); art.sealedRecord({ id: 1n, owner: 0, name: "x", salt, artifact: a }); art.publicView({ id: 1n, owner: "o", commitment, artifact: a }); art.proveSourceEqualsSealed(srcOf("momentum"), A, { code: a.code, salt, commitment }); art.registryChecks(regData(1, Buffer.alloc(32), commitment), { code: a.code, salt, commitment }); }
  finally { console.log = origLog; console.error = origErr; process.stdout.write = origWrite; } assert.deepEqual(out, [], "the artifact functions never print"); });

test("the scripts that touch the chain never log the secret fields", () => {
  // static guard on every printed template string: an interpolation may not reference the salt, the code, its bytecode or an unsalted hash (lengths are fine)
  const secret = /\b(salt|source_sha256|code_sha256|bytecode)\b|\.code\b(?!\.length)|\bcode\b(?!\.length)|opened\.(code|salt)|reg\.salt/; let scanned = 0;
  for (const f of ["client/artifact.mjs", "client/seal_authored.mjs"]) { const lines = fs.readFileSync(path.join(root, f), "utf8").split("\n"); lines.forEach((l, i) => { if (!/\blog\(|\bcheck\(|console\.(log|error|warn)/.test(l)) return; scanned++;
    for (const m of l.matchAll(/\$\{([^}]*)\}/g)) assert.ok(!secret.test(m[1]), `${f}:${i + 1} interpolates a secret field into printed text: ${m[0]}`);
    // plain arguments of log()/console.* that are bare identifiers must not be secret either
    for (const m of l.matchAll(/\blog\(([^`"')]*)\)/g)) assert.ok(!secret.test(m[1]), `${f}:${i + 1} logs a secret value: ${m[0]}`); }); }
  assert.ok(scanned >= 10, "the guard actually looked at the logging lines");
  // and it has teeth: the same scan flags a deliberately bad line
  assert.ok(secret.test("reg.salt.toString(\"hex\")") && secret.test("artifact.code_sha256") && secret.test("opened.code") && !secret.test("artifact.code.length")); });

test("the owner-side parser reads a sealed account laid out like the program writes it, and refuses anything else", () => {
  const code = Buffer.from("0204000002000400150000040a0000001f000000", "hex"); const salt = art.newSalt(); const commitment = art.codeCommit(salt, code); const d = Buffer.alloc(136 + 260); d.writeUInt32LE(art.STRAT_MAGIC, 0); d.writeUInt16LE(code.length, 4); Buffer.alloc(32, 9).copy(d, 8); d.writeBigUInt64LE(77n, 40); commitment.copy(d, 48); salt.copy(d, 104); code.copy(d, 136);
  const p = art.parseSealedAccount(d); assert.equal(p.id, 77n); assert.ok(p.code.equals(code) && p.salt.equals(salt) && p.commitment.equals(commitment) && p.owner.equals(Buffer.alloc(32, 9))); assert.equal(art.STRAT_MAGIC, 0x53545254);
  const bad = Buffer.from(d); bad.writeUInt32LE(0x54535254, 0); assert.throws(() => art.parseSealedAccount(bad), /not a sealed strategy account/); assert.throws(() => art.parseSealedAccount(null), /not a sealed strategy account/); assert.throws(() => art.parseSealedAccount(Buffer.alloc(100)), /not a sealed strategy account/); });

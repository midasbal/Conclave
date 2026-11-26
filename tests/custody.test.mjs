// Salt and strategy custody, offline and keyless: real crypto, real files, real processes (one of them really killed). No chain and no stand-in for it.
// The chain-dependent half (a bundle made from the REAL program's sealed account, the close the client builds with it, and the replay after the account is gone) is tests/svm/tests/client_flows.rs.
//   node --test tests/custody.test.mjs      (needs client/node_modules)
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto"; import net from "node:net"; import { spawn } from "node:child_process"; import { fileURLToPath, pathToFileURL } from "node:url"; import util from "node:util";
const here = path.dirname(fileURLToPath(import.meta.url)); const root = path.join(here, ".."); const load = f => import(pathToFileURL(path.join(root, "client", f)));
const KEYS = fs.mkdtempSync(path.join(os.tmpdir(), "custody-keys-")); process.env.CONCLAVE_KEYS = KEYS; process.env.CONCLAVE_PROGRAM_ID = "HZ3b6zexePfH5cXT5qaKKHfA8B29xwBGGYgu84WgMdne";
const { Keypair } = (await import(pathToFileURL(path.join(root, "client/node_modules/@solana/web3.js/lib/index.cjs.js")))).default; process.env.CONCLAVE_SIGNER = JSON.stringify(Array.from(Keypair.generate().secretKey));
const C = await load("custody.mjs"); const Art = await load("artifact.mjs"); const L = await load("lib.mjs"); const F = await load("flows.mjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "custody-")); const PASS = "correct horse battery staple 42"; const sha = b => crypto.createHash("sha256").update(b).digest();
const key = () => Keypair.generate().publicKey; const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
/** a strategy with real random secrets, and the two accounts the program keeps for it, laid out as program/src/lib.rs lays them out */
function strategy({ codeLen = 24, source = "conclave-strategy 1 ruleset 2\n# private notes\n" } = {}) { const salt = crypto.randomBytes(32); const code = Buffer.concat([Buffer.from([2, (codeLen - 4) / 4, 0, 0]), crypto.randomBytes(codeLen - 4)]); const id = crypto.randomBytes(8).readBigUInt64LE(); const owner = key(); const commit = Art.codeCommit(salt, code);
  const sealed = Buffer.alloc(404); sealed.writeUInt32LE(Art.STRAT_MAGIC, 0); sealed.writeUInt16LE(code.length, 4); owner.toBuffer().copy(sealed, 8); sealed.writeBigUInt64LE(id, 40); commit.copy(sealed, 48); salt.copy(sealed, 104); code.copy(sealed, 136);
  const reg = Buffer.alloc(128); reg.writeUInt32LE(0x52454753, 0); owner.toBuffer().copy(reg, 8); reg.writeBigUInt64LE(id, 40); commit.copy(reg, 48);
  const fields = { program: process.env.CONCLAVE_PROGRAM_ID, cluster: { name: "devnet", genesisHash: GENESIS }, id: String(id), owner: owner.toBase58(), salt, code, source, name: "t" };
  return { salt, code, id, owner, commit, sealed, reg, source, fields }; }
const forms = b => [b.toString("hex"), b.toString("base64"), b.toString("latin1")];

test("a bundle round-trips, is written 0600, and its clear text carries nothing secret", () => {
  const s = strategy(); const file = path.join(tmp(), "a.cvbundle"); const r = C.writeBundle(file, s.fields, PASS); assert.equal(r.reused, false); assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
  const o = C.openBundle(fs.readFileSync(file), PASS); assert.ok(o.salt.equals(s.salt) && o.code.equals(s.code)); assert.equal(o.source, s.source); assert.equal(o.public.commitment, s.commit.toString("hex")); assert.equal(o.public.id, String(s.id)); assert.equal(o.ruleset, 2);
  const text = fs.readFileSync(file, "latin1"); for (const [what, v] of [["salt", s.salt], ["code", s.code], ["sha256(code)", sha(s.code)], ["sha256(source)", sha(Buffer.from(s.source))]]) for (const f of forms(v)) assert.ok(!text.includes(f), `the file holds the ${what} in the clear`); assert.ok(!text.includes("private notes"));
  for (const shown of [JSON.stringify(o), util.inspect(o, { depth: 5 }), `${o}`, String(Object.values(o))]) for (const v of [s.salt, s.code]) for (const f of forms(v)) assert.ok(!shown.includes(f), "printing an opened bundle shows a secret");
  assert.ok(!util.inspect(o).includes("private notes")); });

test("the key derivation and cipher are what the file says: an independent decryption with Node's own scrypt and AES-GCM recovers the same secrets", () => {
  const s = strategy(); const b = JSON.parse(C.sealBundle(s.fields, PASS)); assert.deepEqual([b.kdf.name, b.kdf.N, b.kdf.r, b.kdf.p, b.cipher.name], ["scrypt", 131072, 8, 1, "aes-256-gcm"]);
  const k = crypto.scryptSync(Buffer.from(PASS), Buffer.from(b.kdf.salt, "hex"), 32, { N: 131072, r: 8, p: 1, maxmem: 1 << 29 });
  const sorted = v => v && typeof v === "object" ? "{" + Object.keys(v).sort().map(x => JSON.stringify(x) + ":" + sorted(v[x])).join(",") + "}" : JSON.stringify(v);
  const d = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(b.cipher.nonce, "hex")); d.setAAD(Buffer.from(sorted({ format: b.format, version: b.version, public: b.public, kdf: b.kdf, cipher: b.cipher }))); d.setAuthTag(Buffer.from(b.tag, "hex"));
  const plain = Buffer.concat([d.update(Buffer.from(b.ciphertext, "base64")), d.final()]); const body = JSON.parse(plain.subarray(4, 4 + plain.readUInt32LE(0))); assert.equal(body.salt, s.salt.toString("hex")); assert.equal(body.code, s.code.toString("hex"));
  const again = JSON.parse(C.sealBundle(s.fields, PASS)); assert.notEqual(again.kdf.salt, b.kdf.salt); assert.notEqual(again.cipher.nonce, b.cipher.nonce, "every export gets a fresh salt and nonce"); });

test("the same passphrase typed in another Unicode form opens the bundle", () => { const s = strategy(); const f = C.sealBundle(s.fields, "café-passphrase-long"); assert.ok(C.openBundle(f, "café-passphrase-long").salt.equals(s.salt)); });

test("a bundle's size does not tell strategies apart", () => { const sizes = [[8, null], [24, "short\n"], [260, "x".repeat(3000)]].map(([codeLen, source]) => JSON.parse(C.sealBundle(strategy({ codeLen, source }).fields, PASS)).ciphertext.length); assert.equal(new Set(sizes).size, 1, String(sizes)); });

test("a wrong passphrase, a short one, or any alteration is refused", () => {
  const s = strategy(); const good = C.sealBundle(s.fields, PASS); assert.throws(() => C.openBundle(good, PASS + "x"), /wrong passphrase, or the file was altered/); assert.throws(() => C.sealBundle(s.fields, "short"), /at least 12/);
  const other = strategy(); const mut = (fn, why, re = /./) => { const b = JSON.parse(good); fn(b); assert.throws(() => C.openBundle(Buffer.from(JSON.stringify(b)), PASS), re, why); };
  const flip = h => (h[0] === "0" ? "1" : "0") + h.slice(1);
  for (const [k, v] of [["program", key().toBase58()], ["owner", key().toBase58()], ["id", "5"], ["commitment", other.commit.toString("hex")]]) mut(b => { b.public[k] = v; }, `public ${k} changed`, /altered/);
  mut(b => { b.public.cluster.name = "mainnet-beta"; }, "cluster changed", /altered/); mut(b => { b.tag = flip(b.tag); }, "tag", /altered/); mut(b => { b.tag = b.tag.slice(0, 8); }, "a truncated tag", /malformed/); mut(b => { const c = Buffer.from(b.ciphertext, "base64"); c[100] ^= 1; b.ciphertext = c.toString("base64"); }, "ciphertext bit", /altered/); mut(b => { b.cipher.nonce = flip(b.cipher.nonce); }, "nonce", /altered/);
  mut(b => { b.note = "unauthenticated"; }, "an extra field", /unexpected fields/); mut(b => { b.public.extra = 1; }, "an extra public field", /unexpected fields/); mut(b => { b.version = 2; }, "version", /version/);
  assert.throws(() => C.openBundle(good.subarray(0, good.length - 40), PASS), /not a recovery bundle/);
  const t0 = Date.now(); for (const N of [1 << 28, 1 << 10, 131073, "131072"]) mut(b => { b.kdf.N = N; }, `cost ${N}`, /out of bounds/); mut(b => { b.kdf.r = 1024; }, "r", /out of bounds/); assert.ok(Date.now() - t0 < 500, "hostile cost parameters are refused before any derivation"); });

test("an existing backup is never overwritten", () => {
  const s = strategy(); const dir = tmp(); const file = path.join(dir, "a.cvbundle"); C.writeBundle(file, s.fields, PASS); const bytes = fs.readFileSync(file);
  assert.equal(C.writeBundle(file, s.fields, PASS).reused, true); assert.ok(fs.readFileSync(file).equals(bytes), "the same strategy: left byte for byte");
  assert.throws(() => C.writeBundle(file, strategy().fields, PASS), /NOT overwritten/); assert.throws(() => C.writeBundle(file, s.fields, "a different passphrase"), /NOT overwritten/); fs.writeFileSync(path.join(dir, "junk.cvbundle"), "junk"); assert.throws(() => C.writeBundle(path.join(dir, "junk.cvbundle"), s.fields, PASS), /NOT overwritten/);
  assert.ok(fs.readFileSync(file).equals(bytes)); assert.deepEqual(fs.readdirSync(dir).sort(), ["a.cvbundle", "junk.cvbundle"], "no temporary file is left behind"); });

test("a bundle is never written inside the repository, also not through a symlink", () => {
  const s = strategy(); for (const p of [path.join(root, "x.cvbundle"), path.join(root, "client", "new-dir", "x.cvbundle")]) assert.throws(() => C.writeBundle(p, s.fields, PASS), /inside the repository/);
  const link = path.join(tmp(), "into-repo"); fs.symlinkSync(path.join(root, "docs"), link); assert.throws(() => C.writeBundle(path.join(link, "x.cvbundle"), s.fields, PASS), /inside the repository/); assert.ok(!fs.existsSync(path.join(root, "client", "new-dir"))); });

test("recovery from a sealed account takes only what opens its own commitment", () => {
  const s = strategy(); const got = C.fromSealedAccount(s.sealed); assert.ok(got.salt.equals(s.salt) && got.code.equals(s.code)); assert.equal(got.id, String(s.id)); assert.equal(got.owner, s.owner.toBase58());
  for (const at of [104, 136, 48]) { const bad = Buffer.from(s.sealed); bad[at + 3] ^= 1; assert.throws(() => C.fromSealedAccount(bad), /do not open its commitment/); } assert.throws(() => C.fromSealedAccount(s.reg), /not a sealed strategy/); assert.throws(() => C.fromSealedAccount(Buffer.alloc(404)), /not a sealed strategy/); });

test("export before close: no CloseStrategy without a bundle written, reopened and matching the commitment", () => {
  const s = strategy(); const c = { hub: key() }; const file = path.join(tmp(), "c.cvbundle");
  const chain = { program: s.fields.program, genesisHash: GENESIS, id: s.id, owner: s.owner.toBase58(), sealedData: s.sealed, registryData: s.reg };
  const build = (ticket, who = s.owner, id = s.id) => F.closeStrategyIx(c, who, id, ticket);
  assert.throws(() => build(undefined), /no verified recovery bundle/); assert.throws(() => build(null), /no verified recovery bundle/); assert.throws(() => build({ file, id: String(s.id), owner: s.owner.toBase58() }), /no verified recovery bundle/, "a hand-made object is not a ticket");
  assert.throws(() => C.issueCloseTicket({ ...chain, file, passphrase: PASS }), /ENOENT/, "no file, no ticket");
  C.writeBundle(file, s.fields, PASS); assert.throws(() => C.issueCloseTicket({ ...chain, file, passphrase: "not the passphrase" }), /wrong passphrase/);
  const ticket = C.issueCloseTicket({ ...chain, file, passphrase: PASS }); assert.equal(build(ticket).data[0], 24);
  assert.throws(() => build(ticket, key()), /different strategy/); assert.throws(() => build(ticket, s.owner, s.id + 1n), /different strategy/); assert.throws(() => C.assertCloseTicket(ticket, { program: key().toBase58(), id: s.id, owner: s.owner.toBase58() }), /different strategy/); assert.throws(() => build({ ...ticket }), /no verified/, "a copy of a ticket is not a ticket");
  const bytes = fs.readFileSync(file); fs.appendFileSync(file, " "); assert.throws(() => build(ticket), /changed after it was verified/); fs.rmSync(file); assert.throws(() => build(ticket), /is gone/); fs.writeFileSync(file, bytes); assert.equal(build(ticket).data[0], 24);
  // a perfectly good bundle of ANOTHER strategy, or chain data that disagrees, never gives a ticket
  const o = strategy(); const of_ = path.join(tmp(), "o.cvbundle"); C.writeBundle(of_, o.fields, PASS); assert.throws(() => C.issueCloseTicket({ ...chain, file: of_, passphrase: PASS }), /does not cover this strategy/);
  const sameIdOtherSecret = path.join(tmp(), "s.cvbundle"); C.writeBundle(sameIdOtherSecret, { ...s.fields, salt: crypto.randomBytes(32) }, PASS); assert.throws(() => C.issueCloseTicket({ ...chain, file: sameIdOtherSecret, passphrase: PASS }), /does not cover this strategy[\s\S]*commitment/);
  for (const [name, over] of [["another cluster", { genesisHash: key().toBase58() }], ["another program", { program: key().toBase58() }], ["a registry with another commitment", { registryData: o.reg }], ["an unreadable registry", { registryData: Buffer.alloc(128) }]]) assert.throws(() => C.issueCloseTicket({ ...chain, ...over, file, passphrase: PASS }), /./, name);
  const out = C.exportForClose({ file: path.join(tmp(), "e.cvbundle"), passphrase: PASS, program: chain.program, cluster: s.fields.cluster, id: s.id, owner: chain.owner, sealedData: s.sealed, registryData: s.reg }); assert.equal(build(out).data[0], 24);
  assert.ok(C.openBundle(fs.readFileSync(out.file), PASS).salt.equals(s.salt)); });

test("closeStrategy without a passphrase stops before anything is read or sent", async () => { await assert.rejects(F.closeStrategy({ players: [Keypair.generate()] }, 0, 5n), /passphrase is required/); await assert.rejects(F.closeStrategy({ players: [Keypair.generate()] }, 0, 5n, {}), /passphrase is required/); });

// ---------------------------------------- the key file ----------------------------------------
const keyfile = dir => path.join(dir, "strategies.json"); const rec = (id, salt = "cd".repeat(32)) => ({ id: String(id), owner: 0, name: "n", salt, code: "0200000000000000" });
test("no write of the key file may drop or change a secret, and an unreadable file is never replaced", () => {
  const f = keyfile(tmp()); assert.equal(C.addRecord(f, rec(1)), true); C.addRecord(f, rec(2)); assert.equal(C.addRecord(f, rec(1)), false, "the same record again changes nothing"); assert.equal((fs.statSync(f).mode & 0o777).toString(8), "600");
  assert.throws(() => C.addRecord(f, rec(1, "ee".repeat(32))), /different secret/); assert.throws(() => C.writeRecords(f, [rec(1)]), /would drop or change the secret of strategy 2/); assert.throws(() => C.writeRecords(f, [rec(1), rec(2, "ee".repeat(32))]), /would drop or change/); C.writeRecords(f, [rec(2), rec(1), rec(3)]); assert.equal(C.readRecords(f).length, 3);
  for (const junk of ["[{\"id\":\"1\"", "", "{}"]) { fs.writeFileSync(f, junk); assert.throws(() => C.addRecord(f, rec(9)), /has not been touched/); assert.equal(fs.readFileSync(f, "utf8"), junk); }
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ["strategies.json"], "no temporary or lock file is left behind"); });

test("a lock left by a dead process is reported, not stolen, and nothing is written", () => { const f = keyfile(tmp()); C.addRecord(f, rec(1)); const before = fs.readFileSync(f, "utf8"); fs.writeFileSync(f + ".lock", ""); const t0 = Date.now(); assert.throws(() => C.addRecord(f, rec(2)), /the key file is locked[\s\S]*Nothing was written/); assert.ok(Date.now() - t0 >= 14_000); assert.equal(fs.readFileSync(f, "utf8"), before); });

const child = (args, env) => spawn(process.execPath, [path.join(here, "custody_child.mjs"), ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
const exit = p => new Promise(res => { let out = ""; p.stdout.on("data", d => { out += d; }); p.stderr.on("data", d => { out += d; }); p.on("exit", (code, signal) => res({ code, signal, out })); });
test("eight real processes writing the key file at once lose nothing", async () => { const dir = tmp(); const all = await Promise.all(Array.from({ length: 8 }, (_, k) => exit(child(["add", String(k + 1)], { CONCLAVE_KEYS: dir })))); assert.ok(all.every(r => r.code === 0), all.map(r => r.out).join("\n")); assert.equal(C.readRecords(keyfile(dir)).length, 40); });

test("SAVE FIRST: when the first request of a registration leaves the process, the secret is already on disk; a process killed right then loses nothing", async () => {
  const dir = tmp(); const code = "02040000" + "00".repeat(16); let proc, atFirstRequest, requests = 0;
  // a real local TCP port standing where the RPC would be: it records what the key file holds the instant the client first speaks, then kills the client
  const srv = net.createServer(sock => { sock.once("data", () => { if (requests++ === 0) { try { atFirstRequest = C.readRecords(keyfile(dir)); } catch (e) { atFirstRequest = String(e); } proc.kill("SIGKILL"); } sock.destroy(); }); }); await new Promise(r => srv.listen(0, "127.0.0.1", r));
  proc = child(["register", code], { CONCLAVE_KEYS: dir, CONCLAVE_BASE_URL: `http://127.0.0.1:${srv.address().port}`, CONCLAVE_SOLO: "" }); const done = await exit(proc); srv.close();
  assert.equal(done.signal, "SIGKILL", "the client was killed mid-registration: " + done.out); assert.ok(requests >= 1);
  assert.ok(Array.isArray(atFirstRequest) && atFirstRequest.length === 1, "at the first network request the key file held: " + JSON.stringify(atFirstRequest && atFirstRequest.length)); const after = C.readRecords(keyfile(dir)); assert.equal(after.length, 1); const r = after[0]; assert.equal(r.code, code); assert.equal(Buffer.from(r.salt, "hex").length, 32); assert.ok(!done.out.includes(r.salt), "nothing printed the salt"); });

test("a registration that fails on an unreachable RPC keeps its record", async () => { const dir = tmp(); const port = await new Promise(r => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
  const done = await exit(child(["register", "02040000" + "00".repeat(16)], { CONCLAVE_KEYS: dir, CONCLAVE_BASE_URL: `http://127.0.0.1:${port}`, CONCLAVE_SOLO: "" })); assert.equal(done.code, 3, done.out); assert.equal(C.readRecords(keyfile(dir)).length, 1); });

test("passphrases are random, long, and a passphrase file others can read is refused", () => { const a = C.newPassphrase(), b = C.newPassphrase(); assert.match(a, /^([a-z2-9]{4}-){7}[a-z2-9]{4}$/); assert.notEqual(a, b); const f = path.join(tmp(), "p"); fs.writeFileSync(f, a + "\n", { mode: 0o600 }); assert.equal(C.passphraseFromFile(f), a); fs.chmodSync(f, 0o644); assert.throws(() => C.passphraseFromFile(f), /readable by others/); });

test("no line that prints, in the custody code, interpolates a secret", () => {
  const secret = /\b(salt|bytecode|source_sha256|code_sha256|pass|passphrase)\b|\.salt\b|\.code\b(?!\.length)|\.source\b(?!\s*\?)/; let scanned = 0; const bad = (f, l, i) => { for (const m of l.matchAll(/\$\{([^}]*)\}/g)) assert.ok(!secret.test(m[1]), `${f}:${i + 1} interpolates a secret into text: ${m[0]}`); };
  for (const f of ["client/custody.mjs", "client/custody_cli.mjs", "client/flows.mjs"]) fs.readFileSync(path.join(root, f), "utf8").split("\n").forEach((l, i) => { if (!/\blog\(|\bcheck\(|\bdie\(|\bmust\(|new Error\(|console\.(log|error|warn)|stderr\.write/.test(l)) return; scanned++; bad(f, l, i); });
  assert.ok(scanned >= 25, "the scan looked at the printing lines: " + scanned); assert.throws(() => bad("x", 'console.log(`v ${o.salt.toString("hex")}`)', 0), /interpolates a secret/); });

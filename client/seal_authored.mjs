// Seal an authored strategy on devnet through the EXISTING register and seal flows, then prove it.
//   node client/seal_authored.mjs [strategies/FILE.cvs] [owner index 0..4] [--no-division-check]
// Prints only public facts and booleans. The salt, the code and the unsalted hashes of the code are never logged (see client/artifact.mjs).
import fs from "fs"; import path from "path"; import { fileURLToPath } from "url"; import bs58 from "bs58";
import * as L from "./lib.mjs"; import * as F from "./flows.mjs"; import * as Art from "./artifact.mjs"; import { load } from "./author.mjs";
const here = path.dirname(fileURLToPath(import.meta.url)); const { O } = L; const log = L.logger(L.EV + "seal_authored.txt");
const args = process.argv.slice(2).filter(a => !a.startsWith("--")); const file = path.resolve(args[0] || path.join(here, "../strategies/mean_reversion.cvs")); const owner = +(args[1] ?? 3); const divCheck = !process.argv.includes("--no-division-check");
const checks = []; const check = (name, ok, detail = "") => { checks.push(!!ok); log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " | " + detail : ""}`); return !!ok; };
const sol = async k => (await L.base.getBalance(k)) / 1e9;

// ---- 1. the authored artifact (2a path: the real VM assembler through WASM)
const A = await load(); const src = fs.readFileSync(file, "utf8"); const artifact = Art.buildArtifact(src, A);
log(`\n== SEAL AUTHORED ${new Date().toISOString()} program ${L.PROGRAM.toBase58()} file ${path.basename(file)} owner ${owner}`);
log(`artifact: ruleset ${artifact.ruleset}, source format ${artifact.format}, ${artifact.code.length} bytes of bytecode, work ${artifact.work} of 64, division ${artifact.division} (arena division index ${artifact.division_index})`);
const payer0 = await sol(O.publicKey); log(`payer ${payer0.toFixed(4)} SOL, owner wallet ${(await sol(c0owner())).toFixed(4)} SOL`); if (payer0 < 1) { log("payer balance below 1 SOL: stopping before anything on-chain"); process.exit(2); }
function c0owner() { return L.players()[owner].publicKey; }
const c = await F.ctx(); const p = c.players[owner]; if ((await L.base.getBalance(p.publicKey)) < 120_000_000) { const t = new L.Transaction().add(L.SystemProgram.transfer({ fromPubkey: O.publicKey, toPubkey: p.publicKey, lamports: 150_000_000 })); t.feePayer = O.publicKey; await L.sendAndConfirmTransaction(L.base, t, [O]); log("owner wallet topped up to cover registry rent"); }

// ---- 2. register (public, salted commitment) and seal (TEE, owner-only), by the existing flows
// RESUME_ID (+ SEAL_SIG): re-run the checks against a strategy this script already registered and sealed, instead of registering a second one
let reg, sealed; if (process.env.RESUME_ID) { const rec = L.loadStrats().find(x => x.id === process.env.RESUME_ID); if (!rec) { log("no such strategy in strategies.json"); process.exit(2); } const salt = Buffer.from(rec.salt, "hex"); reg = { id: BigInt(rec.id), salt, commit: Art.codeCommit(salt, artifact.code), sigs: [process.env.REGISTER_SIG || null, null] }; sealed = { sig: process.env.SEAL_SIG, err: null }; log(`RESUMED strategy ${rec.id}`); }
else { reg = await F.register(c, owner, artifact.name, artifact.code, Art.artifactMeta(artifact)); sealed = await F.seal(c, owner, reg.id, reg.salt, artifact.code); }
log(`SIG base Register: ${reg.sigs[0] ?? "(resumed run)"}\nSIG base Delegate registry: ${reg.sigs[1] ?? "(resumed run)"}\nstrategy id ${reg.id}\npublic commitment ${reg.commit.toString("hex")}`); log(`SIG TEE Seal: ${sealed.sig} ${sealed.err ? "FAILED " + JSON.stringify(sealed.err) : "ok"}`);
if (!check("Seal accepted by the program (it recomputed the salted commitment against the registry)", !sealed.err)) process.exit(1);
check("the commitment the client registered is sha256(domain, salt, code) recomputed independently", Art.codeCommit(reg.salt, artifact.code).equals(reg.commit));

// ---- 3. the owner reads the sealed strategy back through the header Endpoint
const acct = L.stratPda(reg.id); const mine = await L.readAcct(c.ptok[owner], acct); check("the owner reads the sealed strategy through the header Endpoint", !!mine, String(c.ptok[owner]));
const opened = Art.parseSealedAccount(mine); check("the sealed bytes equal the authored bytecode", opened.code.equals(artifact.code)); check("the stored salt equals the salt held in strategies.json", opened.salt.equals(reg.salt) && (L.loadStrats().find(s => s.id === reg.id.toString())?.salt === reg.salt.toString("hex")));
check("the sealed account's commitment and id are the registered ones", opened.commitment.equals(reg.commit) && opened.id === reg.id);

// ---- 4. everyone else gets nothing
for (let k = 0; k < c.players.length; k++) if (k !== owner) check(`player ${k}'s token reads nothing`, (await L.readAcct(c.ptok[k], acct)) === null);
check("no token reads nothing", (await L.readAcct(L.TEE, acct)) === null); check("the arena authority's token (the payer) reads nothing", (await L.readAcct(c.URL, acct)) === null); check("the sealed account does not exist on base (it lives only in the rollup)", (await L.base.getAccountInfo(acct)) === null);
// The Seal transaction carries the code and the salt in its instruction data. The TEE answers a non-owner's getTransaction with a redacted record (signature and header only).
// Check it the strict way: in every encoding, for every non-owner, neither the salt nor the code (as hex, base64 or base58) appears anywhere, and no instruction or account key is returned.
const forms = b => [b.toString("hex"), b.toString("base64"), bs58.encode(b)]; const tx = async (ep, enc) => { const r = (await L.rpc(ep, "getTransaction", [sealed.sig, { maxSupportedTransactionVersion: 0, encoding: enc }])).result; return r ?? null; };
const body = async (ep) => { const out = []; for (const enc of ["json", "jsonParsed", "base64", "base58"]) { const r = await tx(ep, enc); out.push({ enc, r, text: JSON.stringify(r), raw: Array.isArray(r?.transaction) && typeof r.transaction[0] === "string" ? (enc === "base58" ? Buffer.from(bs58.decode(r.transaction[0])) : Buffer.from(r.transaction[0], "base64")) : Buffer.alloc(0) }); } return out; };
const holds = (views, b) => views.some(v => forms(b).some(f => v.text.includes(f)) || v.raw.includes(b)); const meta = views => views.map(v => v.r?.transaction?.message).filter(Boolean).some(m => (m.instructions?.length ?? 0) > 0 || (m.accountKeys?.length ?? 0) > 0);
const vOwner = await body(c.ptok[owner]); check("the owner can read the Seal transaction (it holds the salt and the code)", holds(vOwner, reg.salt) && holds(vOwner, artifact.code));
const who = [["anonymous caller", L.TEE], ["the arena authority (payer)", c.URL], ...c.players.map((_, k) => k).filter(k => k !== owner).map(k => [`player ${k}`, c.ptok[k]])];
for (const [name, ep] of who) { const v = await body(ep); check(`the Seal transaction as seen by ${name} is redacted: no instructions or accounts, and neither the salt nor the code in any encoding`, !holds(v, reg.salt) && !holds(v, artifact.code) && !meta(v)); }
// ---- 5. the public registry carries only the salted commitment
const regAcc = await L.base.getAccountInfo(L.regPda(reg.id)); const regData = Buffer.from(regAcc.data); log(`registry account ${L.regPda(reg.id).toBase58()} (${regData.length} bytes, owned by ${regAcc.owner.toBase58() === L.PROGRAM.toBase58() ? "the program" : "the delegation program"})`);
for (const r of Art.registryChecks(regData, { code: artifact.code, salt: reg.salt, commitment: reg.commit })) check(r.name, r.ok);
if (reg.sigs[0]) check("the public Register transaction carries the id and the commitment only", await (async () => { const t = await L.base.getTransaction(reg.sigs[0], { maxSupportedTransactionVersion: 0 }); const m = t.transaction.message; const ixs = m.compiledInstructions ?? m.instructions; const data = Buffer.concat(ixs.map(i => typeof i.data === "string" ? Buffer.from(bs58.decode(i.data)) : Buffer.from(i.data))); return !data.includes(artifact.code) && !data.includes(reg.salt) && data.includes(reg.commit); })());

// ---- 6. source equals sealed, by hash and by opening the commitment
const proof = Art.proveSourceEqualsSealed(src, A, { code: opened.code, salt: opened.salt, commitment: regData.subarray(48, 80) }); for (const x of proof.checks) check(x.name, x.ok);

// ---- 7. strategies.json custody
const rec = L.loadStrats().find(s => s.id === reg.id.toString()); const mode = (fs.statSync(path.join(L.KEYS, "strategies.json")).mode & 0o777).toString(8);
check("strategies.json holds the record with salt, code and the artifact metadata, mode 0600, outside the repository", !!rec && rec.salt === reg.salt.toString("hex") && rec.code === artifact.code.toString("hex") && rec.artifact?.division === artifact.division && rec.artifact?.ruleset === 2 && mode === "600" && path.relative(path.resolve(here, ".."), path.resolve(L.KEYS)).startsWith(".."), `mode ${mode}`);

// ---- 8. the division on the artifact and Enter (simulated, nothing is entered)
if (divCheck) {
  const idxs = [...new Set([artifact.division_index - 1, artifact.division_index].filter(i => i >= 0))];
  for (const idx of idxs) { const sid = BigInt(Date.now() % 1_000_000_000 + 13_000_000 + idx); log(`arena for division ${[16, 32, 64][idx]} (index ${idx}), season ${sid}`);
    await F.initReceipt(c, sid); const cs = await F.createSeason(c, sid, { neps: 2, fee: 0, division: idx, window: 60_000, seedTimeout: 30_000 }); if (cs.err) { check(`CreateSeason for division index ${idx}`, false, JSON.stringify(cs.err)); continue; } log(`SIG TEE CreateSeason (division index ${idx}): ${cs.sig}`);
    const sim = await F.simErr({ URL: c.ptok[owner] }, [F.enterIx(c, sid, owner, reg.id, true)], [p], 1_400_000, p.publicKey); const fits = artifact.work <= [16, 32, 64][idx];
    check(`Enter simulated against a division-${[16, 32, 64][idx]} arena: ${fits ? "accepted" : "refused with 9005"}`, fits ? sim === null : (sim || "").includes("9005"), `simulation result ${sim === null ? "ok" : sim}`);
    const cx = await L.sendTee(c.URL, [F.cancelIx(c, sid)], [O]); await L.sendTee(c.URL, [F.closeClaimsIx(c, sid)], [O]); const cl = await L.sendTee(c.URL, [F.cleanupIx(c, sid)], [O]); log(`SIG TEE Cancel (nothing entered): ${cx.sig} ${cx.err ? JSON.stringify(cx.err) : "ok"} ; SIG TEE Cleanup: ${cl.sig} ${cl.err ? JSON.stringify(cl.err) : "ok"}`);
    const cu = await L.sendTee(c.URL, [F.commitUndelegateIx([L.receiptPda(sid)])], [O]); let a; for (let t = 0; t < 60; t++) { a = await L.base.getAccountInfo(L.receiptPda(sid)); if (a && a.owner.equals(L.PROGRAM) && a.data[144] === 2) break; await L.sleep(1500); } if (a) log(`SIG base ReleaseBond: ${await L.sendBase([F.releaseBondIx(sid, O.publicKey)], [O])}`); }
}

// ---- 9. the secret never reached a file we can see: every salt in strategies.json, and this strategy's code, searched for in the repository and the evidence folder
function* walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (["node_modules", "target", ".git"].includes(e.name)) continue; const q = path.join(d, e.name); if (e.isDirectory()) yield* walk(q); else if (fs.statSync(q).size < 20_000_000) yield q; } }
const salts = L.loadStrats().map(s => s.salt).filter(Boolean); const needles = [...salts, artifact.code.toString("hex"), artifact.code_sha256, artifact.source_sha256]; let files = 0, hits = 0;
for (const f of walk(path.join(here, ".."))) { const t = fs.readFileSync(f).toString("latin1"); files++; for (const n of needles) if (t.includes(n)) { hits++; log(`LEAK: a secret value appears in ${path.relative(path.join(here, ".."), f)}`); } }
check(`no salt (${salts.length} of them), no sealed code and no unsalted hash of it appears in any of ${files} repository or evidence files`, hits === 0);
log(`== seal_authored: ${checks.filter(Boolean).length}/${checks.length} checks | payer ${(await sol(O.publicKey)).toFixed(4)} SOL`); process.exit(checks.every(Boolean) ? 0 : 1);

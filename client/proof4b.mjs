// Devnet proof of the record builder and verifier (4B). One real season is taken through provisional, final and bond-released while the builder watches from a SECOND, independent public RPC,
// then all four proof levels are run through the verifier's CLI against that receipt, with the attacks that must fail. No program change.
//   node client/proof4b.mjs <scratch dir outside the repo for challenge and reveal files>
// Reveal files hold secrets: they are written mode 0600 into that folder, never printed, and removed at the end. Salts and score salts are never logged.
import * as L from "./lib.mjs"; import * as F from "./flows.mjs"; import * as Art from "./artifact.mjs"; import * as C from "./custody.mjs"; import { load } from "./author.mjs";
import fs from "fs"; import path from "path"; import { fileURLToPath } from "url"; import { spawnSync } from "child_process";
import { rpcSource } from "../verifier/lib/chain.mjs"; import { buildRecord } from "../verifier/lib/builder.mjs"; import { signChallenge } from "../verifier/lib/proofs.mjs"; import { recorder } from "../verifier/test/recorded.mjs"; import { assertOutsideRepo } from "../verifier/lib/files.mjs";
const here = path.dirname(fileURLToPath(import.meta.url)); const root = path.join(here, ".."); const { O } = L;
const work = process.argv[2]; if (!work) { console.error("give a scratch folder"); process.exit(2); } assertOutsideRepo(path.join(work, "x")); fs.mkdirSync(work, { recursive: true, mode: 0o700 });
const log = L.logger(L.EV + "proof4b.txt"); const checks = []; const check = (n, ok, d = "") => { checks.push(!!ok); log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " | " + d : ""}`); return !!ok; };
const A = await load(); const c = await F.ctx(); const PASSFILE = path.join(L.KEYS, "bundle-passphrase.txt");
const ARCHIVE = path.join(root, "record-archive"); const RECORD_RPC = "https://api.devnet.solana.com";
const tee = async (label, ix, signers = [O]) => { const r = await L.sendTee(c.URL, [ix], signers); log(`SIG TEE ${label}: ${r.sig} ${r.err ? "FAILED " + JSON.stringify(r.err) : "ok"}`); if (r.err) { check(label, false, JSON.stringify(r.err)); process.exit(1); } return r; };
const baseData = async (sid, pred) => { for (let i = 0; i < 80; i++) { const a = await L.base.getAccountInfo(L.receiptPda(sid), "finalized"); if (a && pred(a)) return a; await L.sleep(2000); } return null; };
const tape = recorder(rpcSource(RECORD_RPC));
async function build(stage, sid) {
  const record = await buildRecord(tape, { archiveDir: ARCHIVE }); fs.writeFileSync(path.join(ARCHIVE, "record.json"), JSON.stringify(record, null, 1) + "\n");
  const s = record.seasons.find(x => x.season === sid.toString()); const address = L.receiptPda(sid).toBase58();
  // keep what the RPC said about THIS receipt at this stage, for the offline tests
  const only = { genesis: tape.tape.genesis, address, season: sid.toString(), listed: Object.fromEntries(Object.entries(tape.tape.listed).map(([k, v]) => [k, v.filter(a => a === address)])), accounts: {}, signatures: {}, transactions: {} };
  only.accounts[address] = tape.tape.accounts[address];
  const rec = (await import("../verifier/lib/chain.mjs")).delegationRecordAddress(address); if (tape.tape.accounts[rec] && tape.tape.accounts[address]?.owner !== L.PROGRAM.toBase58()) only.accounts[rec] = tape.tape.accounts[rec];
  only.signatures[address] = tape.tape.signatures[address] ?? []; for (const x of only.signatures[address]) if (x.signature in tape.tape.transactions) only.transactions[x.signature] = tape.tape.transactions[x.signature];
  fs.writeFileSync(path.join(root, "verifier", "test", "fixtures", `devnet-${stage}.json`), JSON.stringify(only) + "\n");
  log(`\nBUILD (${stage}): ${JSON.stringify(record.counts)} | this season: ${s ? `${s.status}, published ${s.facts.publishedEntries}/${s.facts.fieldSize}, validator ${s.validator.status} ${s.validator.key ?? ""} (${s.validator.sources.join("; ")}), flags ${s.flags.map(f => f.kind + (f.info ? " (info)" : "")).join(",") || "none"}` : "not listed"}`);
  return { record, s };
}
const cli = (args, env = {}) => { const r = spawnSync(process.execPath, [path.join(root, "verifier", "cli.mjs"), ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env }, timeout: 300_000 }); return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") }; };
const show = (label, r) => { log(`--- cli ${label} (exit ${r.code})`); for (const l of r.out.split("\n")) if (/^LEVEL|^  (ok|FAIL|note|receipt|entry|replayed|claimed)|^error/.test(l)) log("    " + l.trim()); };
const verify = (label, args, wantPass) => { const r = cli([...args, "--archive", ARCHIVE]); show(label, r); return check(`${label}: ${wantPass ? "verifies" : "is refused"}`, wantPass ? r.code === 0 && /: VERIFIED/.test(r.out) : r.code !== 0 && !/: VERIFIED/.test(r.out), `exit ${r.code}`); };

log(`\n== PROOF 4B ${new Date().toISOString()} program ${L.PROGRAM.toBase58()} payer ${(await L.base.getBalance(O.publicKey)) / 1e9} SOL | record RPC ${new URL(RECORD_RPC).host}, sends via ${new URL(L.BASE_URL).host}`);
const sid = BigInt(Date.now() % 1_000_000_000 + 41_000_000); const FEE = 5; const spec = [["momentum", 0], ["calm_trend", 1], ["ema_cross", 2], ["mean_reversion", 3], ["quick_fade", 4]]; await F.fundStake(c, Object.fromEntries(spec.map(s => [s[1], FEE])), log);
const field = []; for (const [name, owner] of spec) { const art = Art.buildArtifact(fs.readFileSync(path.join(root, "strategies", name + ".cvs"), "utf8"), A); if ((await L.base.getBalance(c.players[owner].publicKey)) < 60_000_000) { const t = new L.Transaction().add(L.SystemProgram.transfer({ fromPubkey: O.publicKey, toPubkey: c.players[owner].publicKey, lamports: 60_000_000 })); t.feePayer = O.publicKey; await L.sendAndConfirmTransaction(L.base, t, [O]); }
  const reg = await F.register(c, owner, name, art.code, Art.artifactMeta(art)); const s = await F.seal(c, owner, reg.id, reg.salt, art.code); if (s.err) { check("seal " + name, false, JSON.stringify(s.err)); process.exit(1); } field.push({ name, owner, id: reg.id, salt: reg.salt, code: art.code }); }
log(`season ${sid}: five strategies sealed`);
log(`SIG base InitReceipt+Delegate: ${(await F.initReceipt(c, sid)).join(" ")}`); log(`SIG base InitPool: ${await F.initPool(c, sid)}`);
const cs = await F.createSeason(c, sid, { neps: 15, fee: FEE, finals: true, division: 2, window: 150_000, seedTimeout: 60_000, grace: F.MIN_GRACE, minEntrants: 5 }); log(`SIG TEE CreateSeason: ${cs.sig} ${cs.err ? JSON.stringify(cs.err) : "ok"}`);
await F.awaitPoolReady(c, sid, field[0].owner, field[0].id); const en = await F.enter(c, sid, field.map(e => [e.owner, e.id]), log); if (!check("five entries", en.every(r => !r.err))) process.exit(1);
await tee("Lock", F.lockIx(sid)); await tee("RequestSeed", F.seedIx(sid)); const run = await F.runSeason(c, sid, {}); check("both phases ran", run.season.fail === 0 && !!run.finals && run.finals.fail === 0);

// ================ stage 1: PROVISIONAL ================
await tee("Settle, publishing three of five", F.settleIx(c, sid, field.slice(0, 3).map(e => e.id))); await tee("Commit receipt + 3 registries (still delegated)", F.commitIx([L.receiptPda(sid), ...field.slice(0, 3).map(e => L.regPda(e.id))]));
check("the committed result is on base, still held by the delegation program", !!(await baseData(sid, a => a.data[5] === 5 && a.data[6] === 3 && a.owner.equals(L.DLP))));
let b = await build("provisional", sid); check("the builder lists it as PROVISIONAL, saves no first copy, and takes the validator from the delegation record and history", b.s?.status === "provisional" && !fs.existsSync(path.join(ARCHIVE, "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", L.PROGRAM.toBase58(), L.receiptPda(sid).toBase58(), "first-final.json")) && b.s.validator.key === c.validator.toBase58() && b.s.validator.sources.length === 2, b.s?.validator.sources.join("; "));
check("provisional and final results are separate lists in all three views", field.every(e => b.record.views.strategies[e.id.toString()].provisional.length === 1 && b.record.views.strategies[e.id.toString()].final.length === 0));
verify("level 1 on the provisional receipt, without --allow-provisional", ["verify-recorded", "--season", sid.toString(), "--id", field[0].id.toString()], false);
{ const r = cli(["verify-recorded", "--season", sid.toString(), "--id", field[0].id.toString(), "--allow-provisional"]); show("level 1 provisional, allowed", r); check("and passes only when provisional is explicitly accepted, saying so", r.code === 0 && /provisional/.test(r.out)); }
for (const i of [3, 4]) await tee(`Publish entry ${i}`, F.publishIx(sid, i, field[i].id)); await tee("Commit receipt again", F.commitIx([L.receiptPda(sid)])); check("all five published on base", !!(await baseData(sid, a => a.data[6] === 5)));
b = await build("provisional-republished", sid); check("a provisional receipt changing is expected: updated, not flagged", b.s?.status === "provisional" && b.s.facts.publishedEntries === 5 && b.s.flags.length === 0);

// ================ stage 2: FINAL ================
const cm = await F.claimAll(c, sid, log); check("claims", cm.results.every(r => !r.err)); await tee("CloseClaims", F.closeClaimsIx(c, sid)); await tee("Cleanup", F.cleanupIx(c, sid)); await tee("Commit and undelegate the closed receipt", F.commitUndelegateIx([L.receiptPda(sid)]));
check("the closed receipt is back on base (finalized)", !!(await baseData(sid, a => a.owner.equals(L.PROGRAM) && a.data[144] === 2)));
b = await build("final", sid); check("now FINAL, first copy saved, no flags", b.s?.status === "final" && b.record.counts.firstCopiesSavedNow >= 1 && b.s.flags.length === 0, b.s?.copy.sha256);
const firstSha = b.s.copy.sha256;
// ================ stage 3: BOND RELEASE changes the account ================
log(`SIG base ReleaseBond: ${await L.sendBase([F.releaseBondIx(sid, O.publicKey)], [O])}`); check("released", !!(await baseData(sid, a => a.data.readBigUInt64LE(184) === 0n)));
b = await build("bond-released", sid); check("the live bytes changed; the record still carries the FIRST copy and the change is classified as the bond release, not an alarm", b.s.copy.sha256 === firstSha && b.s.current.sha256 !== firstSha && b.s.flags.map(f => f.kind).join() === "bond-released" && b.s.flags[0].info && !b.record.newFlags.some(f => !f.info));
b = await build("rebuild", sid); check("a further rebuild raises nothing new and saves nothing", b.record.counts.flagsRaisedNow === 0 && b.record.counts.firstCopiesSavedNow === 0);

// ================ the four proof levels, through the CLI ================
log("\n---- PROOF LEVELS ----"); const S = sid.toString(); const e0 = field[0], e1 = field[1]; const x0 = b.s.entries[0];
verify("level 1: recorded", ["verify-recorded", "--season", S, "--id", e0.id.toString(), "--commitment", x0.codeCommitment], true);
verify("level 1 with a wrong commitment", ["verify-recorded", "--season", S, "--id", e0.id.toString(), "--commitment", "11".repeat(32)], false);
const store = path.join(work, "issued"); const chal = n => { const f = path.join(work, `challenge-${n}.json`); const r = cli(["challenge", "--season", S, "--id", e0.id.toString(), "--asked-by", "proof4b devnet verifier", "--store", store, "--out", f, "--archive", ARCHIVE]); if (r.code !== 0) throw new Error(r.out); return JSON.parse(fs.readFileSync(f)); };
const answer = (n, ch, kp) => { const f = path.join(work, `response-${n}.json`); fs.writeFileSync(f, JSON.stringify(signChallenge(ch, kp.secretKey))); return f; };
const ch1 = chal(1); const good = answer(1, ch1, c.players[e0.owner]);
verify("level 2: the entering wallet answers a fresh challenge", ["verify-wallet", "--response", good, "--store", store], true);
verify("level 2 replayed: the same answer a second time", ["verify-wallet", "--response", good, "--store", store], false);
verify("level 2 answered by another entrant's wallet", ["verify-wallet", "--response", answer(2, chal(2), c.players[e1.owner]), "--store", store], false);
{ const ch3 = chal(3), ch4 = chal(4); const f = path.join(work, "response-5.json"); const old = signChallenge(ch3, c.players[e0.owner].secretKey); fs.writeFileSync(f, JSON.stringify({ ...old, nonce: ch4.nonce })); verify("level 2 with an old signature moved onto a new challenge", ["verify-wallet", "--response", f, "--store", store], false); }
// bundles are the owner's source for levels 3 and 4
const bundles = []; for (const e of [e0, e1]) bundles.push((await F.recoverBundle(c, e.owner, e.id, { passphrase: C.passphraseFromFile(PASSFILE), dir: path.join(work, "bundles") })).file);
const reveal = (kind, bundle, name) => { const f = path.join(work, name); const r = cli([`reveal-${kind}`, "--season", S, "--bundle", bundle, "--passphrase-file", PASSFILE, "--out", f, "--archive", ARCHIVE]); log(`--- cli reveal-${kind} (exit ${r.code}) ${r.out.trim().split("\n").pop().replace(work, "<scratch>")}`); if (r.code !== 0) throw new Error(r.out); return f; };
const totals = reveal("totals", bundles[0], "totals-0.json"); const T = JSON.parse(fs.readFileSync(totals)); const rec0 = await F.ownerRec(c, e0.owner, e0.id);
check("the revealed totals are the ones the owner's sealed account recorded, and the file holds neither the sealed salt nor the code", T.total === rec0.pnl.toString() && (stat => (stat.mode & 0o077) === 0)(fs.statSync(totals)) && !fs.readFileSync(totals, "utf8").includes(e0.salt.toString("hex")) && !fs.readFileSync(totals, "utf8").includes(e0.code.toString("hex")), `fields ${Object.keys(T).join(",")}`);
verify("level 3: totals bound by the score commitment", ["verify-totals", "--proof", totals], true);
const alter = (name, obj) => { const f = path.join(work, name); fs.writeFileSync(f, JSON.stringify(obj), { mode: 0o600 }); return f; };
verify("level 3 with the total raised by one", ["verify-totals", "--proof", alter("totals-bad.json", { ...T, total: (BigInt(T.total) + 1n).toString() })], false);
verify("level 3 moved onto another entry", ["verify-totals", "--proof", alter("totals-moved.json", { ...T, strategyId: e1.id.toString(), slot: 1 })], false);
const code = reveal("code", bundles[0], "code-0.json"); const K = JSON.parse(fs.readFileSync(code));
verify("level 4: the code opens the commitment and replays to the score commitment", ["verify-code", "--proof", code], true);
const other = JSON.parse(fs.readFileSync(reveal("code", bundles[1], "code-1.json")));
verify("level 4 with another strategy's code under this salt", ["verify-code", "--proof", alter("code-bad.json", { ...K, code: other.code })], false);
{ const r = cli(["reveal-code", "--season", S, "--bundle", bundles[0], "--passphrase-file", PASSFILE, "--out", path.join(root, "reveal.json")]); check("a reveal cannot be written inside the repository", r.code !== 0 && /inside the repository/.test(r.out) && !fs.existsSync(path.join(root, "reveal.json"))); }
// the files that reveal secrets are removed: each path is one this script made, printed before it is removed
for (const f of [totals, code, path.join(work, "code-1.json"), path.join(work, "totals-bad.json"), path.join(work, "totals-moved.json"), path.join(work, "code-bad.json")]) { log(`removing reveal file <scratch>/${path.basename(f)}`); if (!path.resolve(f).startsWith(path.resolve(work) + path.sep)) throw new Error("refusing: not in the scratch folder"); fs.unlinkSync(f); }

// ================ the policy over the real record ================
log("\n---- POLICY over the real record ----"); { const r = cli(["rank", "--record", path.join(ARCHIVE, "record.json"), "--rules", path.join(root, "verifier", "policy", "rules.example.json")]); for (const l of r.out.split("\n").filter(Boolean).slice(0, 14)) log("    " + l); check("the example rules run over the real record", r.code === 0); }
for (const e of field) { const r = await F.closeStrategy(c, e.owner, e.id, { passphrase: C.passphraseFromFile(PASSFILE) }); /* the bundle goes to the key folder, as the client does by default */ log(`retired ${e.name} ${e.id}: ${r.err ? "FAILED " + JSON.stringify(r.err) : "ok"}`); }
b = await build("after-retire", sid); check("after every strategy is closed on chain, its history is still in the record under its permanent id", field.every(e => b.record.views.strategies[e.id.toString()]?.final.length === 1));
log(`== proof4b: ${checks.filter(Boolean).length}/${checks.length} checks passed | payer ${(await L.base.getBalance(O.publicKey)) / 1e9} SOL`); process.exit(checks.every(Boolean) ? 0 : 1);

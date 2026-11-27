// Devnet proof of the capture loop (5A). The ingest daemon runs against the managed store while one real season goes through provisional, final and bond-released, and the script checks what the daemon wrote.
//   node client/proof5a.mjs <store dir> <backup dir>
// Real signatures, real TEE, real base. No program change. Salts are never logged. Strategies are disposable and are closed at the end (which makes their code public: see program/LIFECYCLE.md).
import * as L from "./lib.mjs"; import * as F from "./flows.mjs"; import * as C from "./custody.mjs";
import fs from "fs"; import path from "path"; import { fileURLToPath } from "url"; import { spawn } from "child_process";
import { readLedger } from "../verifier/lib/ledger.mjs"; import { verifyStore } from "../verifier/lib/store.mjs"; import { verifyMirror } from "../verifier/lib/mirror.mjs"; import { DEVNET_GENESIS, PROGRAM_ID, sha256 } from "../verifier/lib/chain.mjs";
const here = path.dirname(fileURLToPath(import.meta.url)); const root = path.join(here, ".."); const { O } = L;
const [STORE, BACKUP] = process.argv.slice(2); if (!STORE || !BACKUP) { console.error("give the store and backup folders"); process.exit(2); }
const log = L.logger(L.EV + "proof5a.txt"); const checks = []; const check = (n, ok, d = "") => { checks.push(!!ok); log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " | " + d : ""}`); return !!ok; };
const c = await F.ctx(); const R = path.join(STORE, DEVNET_GENESIS, PROGRAM_ID); const svc = f => JSON.parse(fs.readFileSync(path.join(R, "_service", f)));
const tee = async (label, ix, signers = [O]) => { const r = await L.sendTee(c.URL, [ix], signers); log(`SIG TEE ${label}: ${r.sig} ${r.err ? "FAILED " + JSON.stringify(r.err) : "ok"}`); if (r.err) { check(label, false, JSON.stringify(r.err)); process.exit(1); } return r; };
const sleep = L.sleep;

// ---- the daemon, as a separate process, writing to the real store
log(`\n== PROOF 5A ${new Date().toISOString()} program ${L.PROGRAM.toBase58()} store ${STORE} backup ${BACKUP}`);
const before = JSON.parse(fs.readFileSync(path.join(R, "_service", "record.json"))); log(`store before: ${before.counts.final} final, ${before.counts.provisional} provisional, ${before.archive.copies} first copies, ledger ${before.ledger.entries} lines`);
const out = fs.openSync(path.join(L.EV, "proof5a_daemon.txt"), "a");
const daemon = spawn(process.execPath, [path.join(root, "verifier", "cli.mjs"), "ingest", "--store", STORE, "--backup", BACKUP, "--rpc", "https://rpc.magicblock.app/devnet", "--poll-seconds", "10", "--sweep-minutes", "2"], { stdio: ["ignore", out, out] });
let daemonExit = null; daemon.on("exit", (code, sig) => { daemonExit = { code, sig }; });
const waitFor = async (label, pred, ms = 150_000) => { const t0 = Date.now(); for (;;) { try { const v = pred(); if (v) { log(`   observed by the daemon after ${((Date.now() - t0) / 1000).toFixed(0)} s: ${label}`); return v; } } catch {} if (Date.now() - t0 > ms) { check(`the daemon observed: ${label}`, false, `not within ${ms / 1000} s`); return null; } if (daemonExit) { check("the daemon kept running", false, JSON.stringify(daemonExit)); process.exit(1); } await sleep(3000); } };
await waitFor("the daemon's first cycle", () => svc("status.json").pid === daemon.pid && svc("status.json").state === "ok" && svc("status.json").updatedAt > new Date(Date.now() - 60_000).toISOString());

// ---- one real season
const sid = BigInt(Date.now() % 1_000_000_000 + 51_000_000); const addr = L.receiptPda(sid).toBase58(); const FEE = 2; const names = ["Mom20th", "EMAcross", "SwitchTwo"]; await F.fundStake(c, { 0: FEE, 1: FEE, 2: FEE }, log);
const field = []; for (const [i, name] of names.entries()) { const reg = await F.register(c, i, name, c.codes[name].code); const s = await F.seal(c, i, reg.id, reg.salt, c.codes[name].code); if (s.err) { check("seal " + name, false, JSON.stringify(s.err)); process.exit(1); } field.push({ name, owner: i, id: reg.id }); }
log(`season ${sid}, receipt ${addr}`); log(`SIG base InitReceipt+Delegate: ${(await F.initReceipt(c, sid)).join(" ")}`); log(`SIG base InitPool: ${await F.initPool(c, sid)}`);
const cs = await F.createSeason(c, sid, { neps: 2, fee: FEE, division: 2, window: 150_000, seedTimeout: 60_000, grace: F.MIN_GRACE, minEntrants: 3 }); log(`SIG TEE CreateSeason: ${cs.sig} ${cs.err ? JSON.stringify(cs.err) : "ok"}`);
await F.awaitPoolReady(c, sid, field[0].owner, field[0].id); const en = await F.enter(c, sid, field.map(e => [e.owner, e.id]), log); check("three entries", en.every(r => !r.err));
await tee("Lock", F.lockIx(sid)); await tee("RequestSeed", F.seedIx(sid)); const run = await F.runSeason(c, sid, {}); check("the season ran", run.season.fail === 0);
const seasonOf = () => svc("record.json").seasons.find(s => s.address === addr); const firstFile = path.join(R, addr, "first-final.json");

// ---- provisional
await tee("Settle, publishing two of three", F.settleIx(c, sid, field.slice(0, 2).map(e => e.id))); await tee("Commit the receipt (still delegated)", F.commitIx([L.receiptPda(sid), ...field.slice(0, 2).map(e => L.regPda(e.id))]));
const prov = await waitFor("the season as PROVISIONAL with two published", () => { const s = seasonOf(); return s?.status === "provisional" && s.facts.publishedEntries === 2 ? s : null; });
check("provisional: no first copy yet, the validator is observed, nothing flagged", !!prov && !fs.existsSync(firstFile) && prov.validator.status === "observed" && prov.flags.length === 0, prov ? `validator ${prov.validator.key} from ${prov.validator.sources.join("; ")}` : "");
const slotProv = svc("record.json").currentTo.slot; log(`   the record is current to slot ${slotProv}, built ${svc("record.json").builtAt}`);
await tee("Publish the third entry", F.publishIx(sid, 2, field[2].id)); await tee("Commit again", F.commitIx([L.receiptPda(sid), L.regPda(field[2].id)]));
const prov2 = await waitFor("the republished receipt (three published)", () => { const s = seasonOf(); return s?.status === "provisional" && s.facts.publishedEntries === 3 ? s : null; });
check("a provisional receipt changing is not a flag", !!prov2 && prov2.flags.length === 0 && !fs.existsSync(firstFile));

// ---- final
const cm = await F.claimAll(c, sid, log); check("claims", cm.results.every(r => !r.err)); await tee("CloseClaims", F.closeClaimsIx(c, sid)); await tee("Cleanup", F.cleanupIx(c, sid)); await tee("Commit and undelegate", F.commitUndelegateIx([L.receiptPda(sid)]));
let baseNow = null; for (let i = 0; i < 90 && !baseNow; i++) { const a = await L.base.getAccountInfo(L.receiptPda(sid), "finalized"); if (a && a.owner.equals(L.PROGRAM) && a.data[144] === 2) baseNow = a; else await sleep(2000); }
const fin = await waitFor("the season as FINAL, first copy saved", () => { const s = seasonOf(); return s?.status === "final" && fs.existsSync(firstFile) ? s : null; });
const copy = JSON.parse(fs.readFileSync(firstFile)); check("the first copy is exactly the finalized base account at the time it closed", !!baseNow && copy.sha256 === sha256(baseNow.data).toString("hex"), `finalized slot ${copy.finalizedSlot}`);
const led = () => readLedger(path.join(R, "_service", "ledger.jsonl")); check("the ledger holds that first copy exactly once", led().ok && led().entries.filter(e => e.type === "first-copy" && e.address === addr).length === 1);
check("final: no flags", !!fin && fin.flags.length === 0 && fin.copy.sha256 === copy.sha256);

// ---- bond released: the live bytes change, the record must not
const relSig = await L.sendBase([F.releaseBondIx(sid, O.publicKey)], [O]); log(`SIG base ReleaseBond: ${relSig}`);
const rel = await waitFor("the bond release as an information flag", () => { const s = seasonOf(); return s?.flags.some(f => f.kind === "bond-released") ? s : null; });
check("the record still reads the first copy; the release is information, not an alarm", !!rel && rel.copy.sha256 === copy.sha256 && rel.current.sha256 !== copy.sha256 && rel.flags.every(f => f.info));
check("and the first copy file was not touched", JSON.parse(fs.readFileSync(firstFile)).sha256 === copy.sha256);
check("the ledger holds that flag once, and still one first copy", led().entries.filter(e => e.type === "flag" && e.address === addr).length === 1 && led().entries.filter(e => e.type === "first-copy" && e.address === addr).length === 1);
// a few quiet cycles after
await sleep(35_000); const quiet = svc("status.json"); check("quiet cycles raise nothing", quiet.state === "ok" && led().entries.filter(e => e.address === addr).length === 2, `status ${quiet.state}`);

// ---- freshness and the backup
const rec = svc("record.json"); check("the record is current to a finalized slot at or beyond the one it was at while provisional", rec.currentTo.slot >= slotProv, `${slotProv} then ${rec.currentTo.slot}`);
check("the record carries the build time, both archive digests and the ledger head", !!rec.builtAt && /^[0-9a-f]{64}$/.test(rec.archive.sha256) && /^[0-9a-f]{64}$/.test(rec.archive.recordSha256) && /^[0-9a-f]{64}$/.test(rec.ledger.head) && rec.archive.copies === before.archive.copies + 1);
check("the store now holds one more first copy and one more final season", rec.counts.final === before.counts.final + 1 && rec.archive.copies === before.archive.copies + 1, `${before.counts.final} to ${rec.counts.final}`);

// ---- stop the daemon cleanly and check store and backup
daemon.kill("SIGTERM"); const t0 = Date.now(); while (!daemonExit && Date.now() - t0 < 60_000) await sleep(500); check("the daemon stopped cleanly on SIGTERM", daemonExit?.code === 0 && !fs.existsSync(path.join(R, "_service", "lock")), JSON.stringify(daemonExit));
const v = verifyStore(STORE, DEVNET_GENESIS, PROGRAM_ID); check("the store verifies: every first copy against its hash and the ledger", v.ok, v.problems.join("; ")); const m = verifyMirror(path.join(BACKUP, DEVNET_GENESIS, PROGRAM_ID), DEVNET_GENESIS, PROGRAM_ID, R);
check("the backup verifies and holds the new first copy", m.ok && fs.existsSync(path.join(BACKUP, DEVNET_GENESIS, PROGRAM_ID, addr, "first-final.json")) && m.ledger.head === v.ledger.head, m.problems.join("; "));
check("no backup alarm was raised", !led().entries.some(e => e.type === "backup-alarm"));

// ---- retire the disposable strategies
for (const e of field) { const r = await F.closeStrategy(c, e.owner, e.id, { passphrase: C.passphraseFromFile(path.join(L.KEYS, "bundle-passphrase.txt")), acknowledgeDisclosure: true /* this run's own disposable strategies */ }); log(`retired ${e.name} ${e.id}: ${r.err ? "FAILED " + JSON.stringify(r.err) : "ok"}`); }
log(`== proof5a: ${checks.filter(Boolean).length}/${checks.length} checks passed | payer ${(await L.base.getBalance(O.publicKey)) / 1e9} SOL`); process.exit(checks.every(Boolean) ? 0 : 1);

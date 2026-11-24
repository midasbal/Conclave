// Devnet canary: a minimal ruleset-v2 season through the real stack, to catch validator, SDK or program drift that would otherwise be silent (the TEE hides logs).
//   node client/canary.mjs                 uses ../../conclave-keys/canary.json (override: CANARY_KEYFILE) or the JSON key array in CANARY_KEY
// It only ever acts as the dedicated throwaway wallet. It refuses to run if that wallet is the payer or the program upgrade authority, and it never funds itself.
// Exit code: 0 all checks passed, 1 a check failed (drift or regression), 2 not runnable (unfunded, missing local tools): not a verdict on the chain.
import fs from "fs"; import path from "path"; import os from "os"; import crypto from "crypto"; import { execFileSync } from "child_process"; import { fileURLToPath } from "url";
const here = path.dirname(fileURLToPath(import.meta.url));
const keyfile = process.env.CANARY_KEYFILE || path.join(here, "..", "..", "conclave-keys", "canary.json");
const keyJson = process.env.CANARY_KEY || (fs.existsSync(keyfile) ? fs.readFileSync(keyfile, "utf8") : null);
if (!keyJson) { console.error("no canary key: set CANARY_KEY (JSON key array) or create " + keyfile); process.exit(2); }
Object.assign(process.env, { CONCLAVE_SOLO: "1", CONCLAVE_SIGNER: keyJson.trim(), CONCLAVE_PROGRAM_ID: process.env.CONCLAVE_PROGRAM_ID || "HZ3b6zexePfH5cXT5qaKKHfA8B29xwBGGYgu84WgMdne", CONCLAVE_MINT: process.env.CONCLAVE_MINT || "7UF5qBHPKLjtyHnM4KQrYhrSkFr4TfB42663zkWL7etX" });
const L = await import("./lib.mjs"); const F = await import("./flows.mjs"); const { O } = L; const codes = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(here, "canary_codes.json"), "utf8"))).map(([k, v]) => [k, Buffer.from(v, "hex")]));
const stamp = new Date().toISOString().replace(/[:.]/g, "-"); const log0 = L.logger(L.EV + "canary_" + stamp + ".txt"); const log = (...a) => log0(...a);
const checks = []; const check = (name, ok, detail = "") => { checks.push({ name, ok: !!ok }); log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " | " + detail : ""}`); return !!ok; };
const abort = (msg, code) => { log("ABORT:", msg); process.exit(code); };
log(`== CONCLAVE CANARY ${new Date().toISOString()} program ${L.PROGRAM.toBase58()} wallet ${O.publicKey.toBase58()}`);

// ---- guards: the canary must never act as the payer or the upgrade authority
const pd = await L.base.getAccountInfo(L.PROGRAM); if (!pd) abort("program account not found on base", 1);
const pdAddr = new L.PublicKey(pd.data.subarray(4, 36)); const pdAcc = await L.base.getAccountInfo(pdAddr); const authority = pdAcc.data[12] === 1 ? new L.PublicKey(pdAcc.data.subarray(13, 45)) : null;
if (authority && authority.equals(O.publicKey)) abort("the canary wallet is the program upgrade authority; refusing to run", 2);
const payerFile = path.join(here, "..", "..", "conclave-keys", "payer.json"); if (fs.existsSync(payerFile) && L.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(payerFile, "utf8")))).publicKey.equals(O.publicKey)) abort("the canary wallet is the payer; refusing to run", 2);
const MIN = 0.06 * 1e9; const bal0 = await L.base.getBalance(O.publicKey); if (bal0 < MIN) abort(`canary wallet holds ${(bal0 / 1e9).toFixed(4)} SOL, needs at least 0.06; fund ${O.publicKey.toBase58()} (the canary never funds itself)`, 2);
if (!fs.existsSync(L.LAB)) abort("target/release/conclave-lab not built (cargo build --release -p conclave-lab); the canary compares chain results to a local replay", 2);

// ---- program identity on chain (informational for the report; the hash is checked by scripts/verify-deployed.sh)
log(`program data ${pdAddr.toBase58()} upgrade authority ${authority ? authority.toBase58() : "none"} data bytes ${pdAcc.data.length - 45}`);
const c = await F.ctx(); const sid = BigInt(Date.now() % 1_000_000_000 + 7_000_000); const NEPS = 2; const hub0 = await F.hubLamports(c);
log("season", sid.toString(), "validator", c.validator.toBase58(), "hub lamports before", hub0);

// ---- A. ruleset gate still enforced by the deployed program on the live validator (over-cap: 14 x HIST = work 71)
const hostile = Buffer.from([2, 15, 0, 0, ...Array.from({ length: 14 }, () => [23, 1, 0, 0]).flat(), 31, 0, 1, 0]);
{ const r = await F.register(c, 0, "canary-overcap", hostile); const s = await F.seal(c, 0, r.id, r.salt, hostile); check("over-cap program rejected at seal with Custom 9001", s.err && JSON.stringify(s.err).includes("9001"), JSON.stringify(s.err || "ACCEPTED")); }

// ---- B. register, seal, season, enter, lock, seed, run
const names = ["Mom20th", "EMAcross", "SwitchTwo"]; const entries = [];
for (const n of names) { const r = await F.register(c, 0, n, codes[n]); entries.push({ o: 0, id: r.id, salt: r.salt, code: codes[n], commit: r.commit, name: n }); }
await F.initReceipt(c, sid); await F.initPool(c, sid);
let allSealed = true; for (const e of entries) { const r = await F.seal(c, e.o, e.id, e.salt, e.code); if (r.err) { allSealed = false; log("seal error", e.name, JSON.stringify(r.err)); } } check("3 strategies sealed in the TEE", allSealed);
const cs = await F.createSeason(c, sid, { neps: NEPS, fee: 0, maxs: 20, finals: false, division: 2 }); check("CreateSeason", !cs.err, cs.sig + (cs.err ? " " + JSON.stringify(cs.err) : ""));
// fee 0: no tokens move, so the throwaway wallet needs no token account; its (absent) ATA is passed read-only, the pool eATA is the real delegated one
const t0 = Date.now(); for (;;) { const e = await F.simErr(c, [F.enterIx(c, sid, 0, entries[0].id, true)], [O]); if (!e) break; if (Date.now() - t0 > 90_000) { check("pool token account usable within 90s", false, e); summary(); await L.sleep(5000); } await L.sleep(500); }
log(`pool token account usable after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const en = await F.enter(c, sid, entries.map(e => [e.o, e.id]), log, true); check("3 entries accepted", en.every(r => !r.err));
const outsiderArena = await L.readAcct(L.TEE, L.arenaPda(sid)); const outsiderStrat = await L.readAcct(L.TEE, L.stratPda(entries[0].id)); check("privacy: arena and sealed strategy unreadable without the owner token", outsiderArena === null && outsiderStrat === null);
const lock = await L.sendTee(c.URL, [F.lockIx(sid)], [O]); check("Lock", !lock.err, lock.sig); const seed = await L.sendTee(c.URL, [F.seedIx(sid)], [O]); check("RequestSeed (VRF)", !seed.err, seed.sig);
const d = await F.drive(c, sid, { log }); check("Advance runs to completion with no compute failures", d.ok > 0 && d.fail === 0, `${d.ok} txs in ${d.wall.toFixed(0)}s`);
const settleIx = () => { const ix = F.settleIx(c, sid, entries.map(e => [e.o])); ix.keys.forEach((k, i) => { if (i >= 6) k.isWritable = false; }); return ix; };
const settle = await L.sendTee(c.URL, [settleIx()], [O]); check("Settle", !settle.err, settle.sig + (settle.err ? " " + JSON.stringify(settle.err) : ""));
const dup = await L.sendTee(c.URL, [settleIx()], [O]); check("second Settle rejected", !!dup.err);
let pubOk = true; for (let i = 0; i < entries.length; i++) { const r = await L.sendTee(c.URL, [F.publishIx(sid, i, entries[i].id)], [O]); if (r.err) { pubOk = false; log("publish error", i, JSON.stringify(r.err)); } } check("Publish all ranks", pubOk);
const cm = await L.sendTee(c.URL, [F.commitIx([L.receiptPda(sid), ...entries.map(e => L.regPda(e.id))])], [O]); check("Commit receipt and registries to base", !cm.err, cm.sig);

// ---- C. receipt on base against the local replay, bit for bit
const rb = await F.readReceiptBase(sid, entries.length); if (!check("receipt visible on base with all ranks published", !!rb)) { summary(); }
const R = L.parseReceipt(rb); const pinsLocal = execFileSync(L.LAB, ["pins"]).toString().trim(); check("receipt pins equal the local conclave-vm pins", Buffer.from(R.pins).toString("hex") === pinsLocal, pinsLocal);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canary-")); const poolBin = path.join(tmp, "pool.bin"); const parts = [Buffer.from([entries.length & 255, entries.length >> 8])]; for (const e of entries) { const l = Buffer.alloc(2); l.writeUInt16LE(e.code.length); parts.push(l, e.code); } fs.writeFileSync(poolBin, Buffer.concat(parts));
const loc = execFileSync(L.LAB, ["season", R.seedA.toString(), R.seedB.toString(), String(NEPS), poolBin, entries.map((_, i) => i).join(",")]).toString().trim().split("\n"); const tot = loc[0].split(",").map(BigInt); fs.rmSync(tmp, { recursive: true, force: true });
let okC = 0, okI = 0; for (let i = 0; i < entries.length; i++) { const e = entries[i], re = R.entries[i]; const reg = await L.base.getAccountInfo(L.regPda(e.id)); if (Buffer.compare(re.commit, reg.data.subarray(48, 80)) === 0 && Buffer.compare(re.commit, e.commit) === 0) okC++; const rec = await F.ownerRec(c, e.o, e.id); if (rec && rec.pnl === tot[i] && rec.rank === re.rank) okI++; log(`  entry ${i} ${e.name} id ${re.id} rank ${re.rank} chain total ${rec && rec.pnl} local replay ${tot[i]}`); }
check("code commitments in the receipt equal the registry and the owner's salted commitment", okC === entries.length, `${okC}/${entries.length}`); check("owner-read totals and ranks bit-identical to the local replay from the receipt seed words", okI === entries.length, `${okI}/${entries.length}`);

// ---- D. cleanup and sponsor accounting
const cl = await L.sendTee(c.URL, [F.cleanupIx(c, sid)], [O]); check("Cleanup", !cl.err, cl.sig + (cl.err ? " " + JSON.stringify(cl.err) : ""));
// Cleanup refunds the arena (about 418k lamports). The three sealed strategy accounts stay in the rollup by design, so the hub ends lower by their rent only (observed 19,744 each).
const hub1 = await F.hubLamports(c); check("sponsor hub: arena rent refunded, loss limited to the 3 strategy accounts (at most 21,000 lamports each)", hub1 !== null && hub0 - hub1 >= 0 && hub0 - hub1 <= 3 * 21_000, `${hub0} -> ${hub1} (${hub1 - hub0})`);
// ---- E. the creator bond comes back: undelegate the closed receipt, release on base, exact amount
{ const cu = await L.sendTee(c.URL, [F.commitUndelegateIx([L.receiptPda(sid)])], [O]); check("Commit+undelegate the closed receipt", !cu.err, cu.sig + (cu.err ? " " + JSON.stringify(cu.err) : ""));
  let acc = null; for (let t = 0; t < 60; t++) { acc = await L.base.getAccountInfo(L.receiptPda(sid)); if (acc && acc.owner.equals(L.PROGRAM) && acc.data[144] === 2) break; await L.sleep(1500); }
  if (check("receipt back on base in state closed", !!acc && acc.owner.equals(L.PROGRAM))) { const RR = L.parseReceipt(acc.data); const l0 = acc.lamports; const rel = await L.sendBase([F.releaseBondIx(sid, O.publicKey)], [O]); const l1 = await L.base.getBalance(L.receiptPda(sid));
    check("bond released exactly: nothing forfeited, arena rent drawn equals reclaimed", BigInt(l0 - l1) === RR.release && RR.forfeit === 0n && RR.release === RR.bond && RR.rentDrawn === RR.rentReclaimed && RR.rentDrawn > 0n, `${rel} bond ${RR.bond} drawn ${RR.rentDrawn} reclaimed ${RR.rentReclaimed} released ${l0 - l1}`); } }
function summary() { const bad = checks.filter(x => !x.ok); L.base.getBalance(O.publicKey).then(b => { log(`== CANARY ${bad.length ? "FAILED: " + bad.map(x => x.name).join("; ") : "PASSED"} (${checks.length - bad.length}/${checks.length} checks) | wallet spent ${((bal0 - b) / 1e9).toFixed(5)} SOL, now ${(b / 1e9).toFixed(4)}`); process.exit(bad.length ? 1 : 0); }); }
summary();

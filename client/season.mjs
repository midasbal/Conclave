// One two-phase season end to end on devnet: v1 and over-cap rejection, salted registration, the season phase, the finals phase the program enters by itself, Settle (records), Claim (pays), one receipt
// verified against a local replay of BOTH phases, the fingerprint test, cleanup.
import * as L from "./lib.mjs"; import * as F from "./flows.mjs"; import { qualifiersOf, scoreRankChecks, claimsChecks, payoutChecks } from "./campaign_lib.mjs"; import fs from "fs"; import crypto from "crypto"; import { execFileSync } from "child_process"; import path from "path";
const { K, ixp, u64, O, SystemProgram } = L; const log = L.logger(L.EV + "v2_season.txt"); const c = await F.ctx(); const names = ["Mom20th", "EMAcross", "TrendSwitch", "SwitchTwo", "SwitchFade"];
const sid = BigInt(Date.now() % 1_000_000 + 5000); const NEPS = +process.env.NEPS || 15; /* at least 15 with finals */ const FEE = 10; const sol = async () => (await L.base.getBalance(O.publicKey)) / 1e9;
const checks = []; const check = (name, ok, detail = "") => { checks.push(!!ok); log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " | " + detail : ""}`); return !!ok; }; const runAll = (title, list) => { log(title); for (const x of list) check(x.name, x.ok, x.detail ?? ""); };
log("\n== CONCLAVE v2 SEASON", new Date().toISOString(), "program", L.PROGRAM.toBase58(), "season", sid.toString(), "| payer SOL", await sol());
for (const p of c.players) { const b = await L.base.getBalance(p.publicKey); if (b < 60_000_000) { const t = new L.Transaction().add(SystemProgram.transfer({ fromPubkey: O.publicKey, toPubkey: p.publicKey, lamports: 80_000_000 - b })); t.feePayer = O.publicKey; await L.sendAndConfirmTransaction(L.base, t, [O]); } }
let entries = [];
// ---- A. ruleset gates at seal time
const v1pool = fs.readFileSync(L.ROOT + "/../spike/evidence/real_pool.bin"); const v1meta = JSON.parse(fs.readFileSync(L.ROOT + "/../spike/evidence/real_pool.json")).strategies; let off = 2, v1code = null; for (let i = 0; i < v1pool.readUInt16LE(0); i++) { const l = v1pool.readUInt16LE(off); off += 2; if (v1meta[i].name === "Mom20th") v1code = v1pool.subarray(off, off + l); off += l; }
const hostile = Buffer.from([2, 15, 0, 0, ...Array.from({ length: 14 }, () => [23, 1, 0, 0]).flat(), 31, 0, 1, 0].slice(0, 4 + 15 * 4)); hostile[1] = 15; // 14 x HIST (5 each = 70) + POS: over the 64 cap
for (const [label, code, want] of [["v1-version program (Mom20th compiled under ruleset 1)", v1code, 9003], ["over-cap program (14 x HIST, work 71)", hostile, 9001]]) {
  const r = await F.register(c, 0, label, code); const s = await F.seal(c, 0, r.id, r.salt, code); const e = JSON.stringify(s.err || "");
  log(`SEAL ${label}: ${s.err ? "REJECTED " + e : "ACCEPTED (BAD)"} ${e.includes(String(want)) ? "(expected Custom " + want + ")" : "(UNEXPECTED code)"} sig ${s.sig}`); }
// ---- B. register + seal five v2 strategies with salted commitments

for (let i = 0; i < 5; i++) { const code = c.codes[names[i]].code; const r = await F.register(c, i, names[i], code); entries.push({ o: i, id: r.id, salt: r.salt, code, commit: r.commit, name: names[i] }); log(`SIG base Register ${names[i]} id ${r.id}: ${r.sigs[0]} | delegate: ${r.sigs[1]} | commitment ${r.commit.toString("hex").slice(0, 16)}...`); }
// ---- C. one season with finals (fixed format: top 3 by season rank, fresh seed, 15 episodes)
const balances = async () => { const o = {}; for (let i = 0; i < 5; i++) o[i] = await F.bal(c, i); return o; };
log("SIG base InitReceipt+delegate:", (await F.initReceipt(c, sid)).join(" ")); log("SIG base InitPool (atomic base ATA + eATA delegate):", await F.initPool(c, sid));
for (const e of entries) { const r = await F.seal(c, e.o, e.id, e.salt, e.code); log(`SIG TEE Seal ${e.name}: ${r.sig} ${r.err ? "FAILED " + JSON.stringify(r.err) : "ok"}`); }
const hubStart = await F.hubLamports(c); const before = await balances();
const cs = await F.createSeason(c, sid, { neps: NEPS, fee: FEE, finals: true, division: 2, window: 60_000, seedTimeout: 30_000, grace: F.MIN_GRACE, minEntrants: 1 }); check(`CreateSeason (neps ${NEPS}, fee ${FEE}, division 64, finals on)`, !cs.err, cs.sig + (cs.err ? " " + JSON.stringify(cs.err) : ""));
log(`pool token account usable after ${(await F.awaitPoolReady(c, sid, entries[0].o, entries[0].id)).toFixed(1)}s (condition-based)`); await F.enter(c, sid, entries.map(e => [e.o, e.id]), log); const afterEnter = await balances();
log("arena read as outsider:", (await L.readAcct(L.TEE, L.arenaPda(sid))) === null ? "null" : "NON-NULL", "| strategy 1 sealed record as outsider:", (await L.readAcct(L.TEE, L.stratPda(entries[0].id))) === null ? "null" : "NON-NULL", "| as another player:", (await L.readAcct(c.ptok[1], L.stratPda(entries[0].id))) === null ? "null" : "NON-NULL");
log("SIG Lock:", (await L.sendTee(c.URL, [F.lockIx(sid)], [O])).sig); log("SIG RequestSeed:", (await L.sendTee(c.URL, [F.seedIx(sid)], [O])).sig);
const run = await F.runSeason(c, sid, { log }); log(`season phase: ${run.season.ok} self-metered Advance txs, ${run.season.fail} failures, ${run.season.wall.toFixed(0)}s for ${NEPS * 150} ticks; first ${run.season.sigs[0]}`);
check("the program moved into the finals by itself and both phases ran with no compute failures", run.season.ok > 0 && run.season.fail === 0 && run.finals && run.finals.ok > 0 && run.finals.fail === 0, run.finals ? `finals ${run.finals.ok} txs, ${run.finals.wall.toFixed(0)}s` : "no finals ran");
const st = await L.sendTee(c.URL, [F.settleIx(c, sid, entries.map(e => e.id))], [O]); check("Settle records what each entry is owed and publishes all 5 inline", !st.err, st.sig + (st.err ? " " + JSON.stringify(st.err) : ""));
const afterSettle = await balances(); check("Settle moved no tokens", Object.keys(afterSettle).every(k => afterSettle[k] === afterEnter[k]));
log("\nbefore claiming:\n" + F.claimsTable(await F.readClaims(c, sid))); const claimed = await F.claimAll(c, sid, log); log("after claiming:\n" + F.claimsTable(claimed.after)); check("every claim succeeded", claimed.results.every(r => !r.err), `${claimed.results.length} claims`);
{ const e = claimed.after.entries.find(x => x.owed > 0n); const again = await L.sendTee(c.URL, [F.claimIx(c, sid, e.slot, new L.PublicKey(e.owner))], [O]); check("a repeat claim succeeds and pays nothing", !again.err, again.sig); }
const after = await balances();
{ const r = await L.sendTee(c.URL, [F.publishIx(sid, 0, entries[0].id)], [O]); check("a second Publish of slot 0 is refused (9120)", !!r.err && JSON.stringify(r.err).includes("9120"), JSON.stringify(r.err || "ACCEPTED")); }
const cm = await L.sendTee(c.URL, [F.commitIx([L.receiptPda(sid), ...entries.map(e => L.regPda(e.id))])], [O]); check("Commit receipt + registries -> base", !cm.err, cm.sig);

// ---- D. verify the one receipt on BASE against a local replay of BOTH phases
const rcb = await F.readReceiptBase(sid, 5); if (!rcb) throw new Error("receipt not visible on base"); const R = L.parseReceipt(rcb); const pinsLocal = execFileSync(L.LAB, ["pins"]).toString().trim();
log("\nRECEIPT (read from base):", JSON.stringify({ kind: R.kind, season: R.season.toString(), ruleset: R.ruleset, vmVersion: R.vmVersion, genVersion: R.genVersion, division: R.division, packsDrawn: R.packs, episodes: R.neps, seedA: R.seedA.toString(), seedB: R.seedB.toString(), finals: { status: R.finals.status, qualifiers: R.finals.qualifiers, episodes: R.finals.neps, packsDrawn: R.finals.packs, seedA: R.finals.seedA.toString(), seedB: R.finals.seedB.toString() }, owed: R.owed.toString(), entrants: R.ns, published: R.published }));
check("receipt pins equal the local conclave-vm pins", Buffer.from(R.pins).toString("hex") === pinsLocal, pinsLocal); check("the finals were played, on their own seed", R.finals.status === 1 && (R.finals.seedA !== R.seedA || R.finals.seedB !== R.seedB));
const replay = (sa, sb, eps, who) => execFileSync(L.LAB, ["season", sa.toString(), sb.toString(), String(eps), L.OUT + "/real_pool.bin", who.map(i => c.codes[entries[i].name].i).join(",")]).toString().trim().split("\n")[0].split(",").map(BigInt);
const localSeason = replay(R.seedA, R.seedB, NEPS, [0, 1, 2, 3, 4]); const q = qualifiersOf(localSeason); const qt = replay(R.finals.seedA, R.finals.seedB, R.finals.neps, q); const localFinals = [0n, 0n, 0n, 0n, 0n]; q.forEach((i, k) => { localFinals[i] = qt[k]; });
const recs = []; for (const e of entries) recs.push(await F.ownerRec(c, e.o, e.id));
runAll("score and rank checks, both phases:", scoreRankChecks(entries.map((e, i) => ({ id: e.id, owner: e.o, name: e.name, onchainTotal: recs[i].pnl, localTotal: localSeason[i], ownerRank: recs[i].rank, receiptRank: R.entries[i].rank, receiptSeasonRank: R.entries[i].seasonRank })), { onchain: recs.map(r => r.finalsPnl), local: localFinals }));
check("the receipt marks exactly the replay's qualifiers as finalists", R.entries.every((e, i) => e.finalist === q.includes(i)));
let okC = 0, okS = 0; for (let i = 0; i < 5; i++) { const e = entries[i], re = R.entries[i]; const reg = await L.base.getAccountInfo(L.regPda(e.id)); if (Buffer.compare(re.commit, reg.data.subarray(48, 80)) === 0 && Buffer.compare(re.commit, e.commit) === 0) okC++; if (Buffer.compare(L.scoreCommit(e.salt, sid, e.id, localSeason[i], localFinals[i], NEPS, re.finalist ? R.finals.neps : 0), re.score) === 0) okS++;
  log(`  entry ${i} ${e.name.padEnd(12)} season rank ${re.seasonRank} final rank ${re.rank} | season total ${recs[i].pnl} (local ${localSeason[i]}) | finals total ${recs[i].finalsPnl} (local ${localFinals[i]})`); }
check("code commitments equal the registry and the owner's salted commitment", okC === 5, `${okC}/5`); check("score commitments recompute from the owners' salts and the replay of both phases", okS === 5, `${okS}/5`);
runAll("owed versus claimed:", claimsChecks(claimed.after, R, { fee: FEE })); runAll("token balances:", payoutChecks({ fee: FEE, entries: entries.map((e, i) => ({ owner: e.o, receiptRank: R.entries[i].rank })), ownersBefore: before, ownersAfterEnter: afterEnter, ownersAfter: after }));
// ---- E. fingerprint test: an outsider with the whole preset pool, the on-chain registry and the revealed seeds
const dom = Buffer.from("CNCL-CODE-v1"), pool = L.loadPool(); let matches = 0, tries = 0; const onchain = entries.map(e => e.commit.toString("hex"));
for (const [n, p] of Object.entries(pool)) for (const variant of [p.code, Buffer.concat([dom, p.code]), Buffer.concat([dom, Buffer.alloc(32), p.code])]) { tries++; if (onchain.includes(L.sha256(variant).toString("hex"))) matches++; }
let scoreMatches = 0, sTries = 0; for (const salt of [Buffer.alloc(32), Buffer.alloc(0)]) for (let i = 0; i < 5; i++) { sTries++; if (R.entries.some(r => Buffer.compare(L.scoreCommit(salt, sid, R.entries[i].id, localSeason[i], localFinals[i], NEPS, R.entries[i].finalist ? R.finals.neps : 0), r.score) === 0)) scoreMatches++; }
check("fingerprint: no preset hash matches a code commitment and no unsalted score commitment matches", matches === 0 && scoreMatches === 0, `${tries} code candidates, ${sTries} score candidates`);
// ---- F. close the claims account and the arena; the hub is whole when both are closed (the sealed strategy accounts stay by design)
const hub0 = await F.hubLamports(c); const cc = await L.sendTee(c.URL, [F.closeClaimsIx(c, sid)], [O]); check("CloseClaims after the last claim", !cc.err, cc.sig + (cc.err ? " " + JSON.stringify(cc.err) : ""));
const cl = await L.sendTee(c.URL, [F.cleanupIx(c, sid)], [O]); check("Cleanup", !cl.err, cl.sig + (cl.err ? " " + JSON.stringify(cl.err) : "")); const hub1 = await F.hubLamports(c);
check("hub made whole for the arena and the claims account", hub1 === hubStart, `before CreateSeason ${hubStart}, after CloseClaims and Cleanup ${hub1} (they returned ${hub1 - hub0})`);
const cu = await L.sendTee(c.URL, [F.commitUndelegateIx([L.receiptPda(sid)])], [O]); check("Commit+undelegate the closed receipt", !cu.err, cu.sig);
{ const rp = L.receiptPda(sid); let acc = null; for (let t = 0; t < 60; t++) { acc = await L.base.getAccountInfo(rp); if (acc && acc.owner.equals(L.PROGRAM) && acc.data[144] === 2) break; await L.sleep(1500); }
  const RR = L.parseReceipt(acc.data); const l0 = acc.lamports; const rel = await L.sendBase([F.releaseBondIx(sid, O.publicKey)], [O]); const l1 = await L.base.getBalance(rp);
  check("the bond is released exactly, nothing forfeited", BigInt(l0 - l1) === RR.release && RR.release === RR.bond && RR.forfeit === 0n, `${rel} bond ${RR.bond} released ${l0 - l1}`); }
fs.writeFileSync(L.ROOT + "/client/last_v2_entries.json", JSON.stringify({ sid: sid.toString(), ids: entries.map(e => e.id.toString()) }));
log(`== season: ${checks.filter(Boolean).length}/${checks.length} checks | payer ${await sol()}`); process.exit(checks.every(Boolean) ? 0 : 1);

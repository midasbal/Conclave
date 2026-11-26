// Phase 2c: a field of authored, sealed strategies through one real season on devnet, using only the existing Phase 1 flows.
//   node client/campaign.mjs            (needs the keys folder, the built WASM author module, and a funded payer)
// Everything printed is public or a pass/fail boolean, except the season totals and ranks of these example strategies (the owner-private scores, shown on purpose to make the mapping legible).
// The salt, the code and the unsalted hashes of the code are never logged.
import fs from "fs"; import path from "path"; import { fileURLToPath } from "url";
import * as L from "./lib.mjs"; import * as F from "./flows.mjs"; import * as Art from "./artifact.mjs"; import * as K from "./campaign_lib.mjs"; import { load } from "./author.mjs"; import { coarseReceipt } from "../server/src/receipt.mjs";
const here = path.dirname(fileURLToPath(import.meta.url)); const root = path.join(here, ".."); const { O } = L; const log = L.logger(L.EV + "campaign.txt");
const FIELD = [["momentum", 0], ["calm_trend", 2], ["ema_cross", 4], ["mean_reversion", 3], ["quick_fade", 0], ["trend_stop", 2]]; const FEE = 10, NEPS = 12, DIV_IDX = 1, DIV = 32;
const checks = []; const check = (name, ok, detail = "") => { checks.push(!!ok); log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " | " + detail : ""}`); return !!ok; }; const runAll = (title, list) => { log(title); for (const c of list) check(c.name, c.ok, c.detail ?? ""); };
const sol = async k => (await L.base.getBalance(k)) / 1e9; const q16 = v => Number(v) / 65536; const f = x => (x >= 0 ? "+" : "") + x.toFixed(2);
const amount = d => d ? d.readBigUInt64LE(64) : null;

log(`\n== CAMPAIGN ${new Date().toISOString()} program ${L.PROGRAM.toBase58()}`); const payer0 = await sol(O.publicKey); log(`payer ${payer0.toFixed(4)} SOL`); if (payer0 < 1) { log("payer balance below 1 SOL: stopping before anything on-chain"); process.exit(2); }
const A = await load(); const c = await F.ctx();
// ---- 1. the field: authored, assembled, sealed (reusing a strategy already sealed from the same source and owner)
const field = [];
for (const [name, owner] of FIELD) { const src = fs.readFileSync(path.join(root, "strategies", name + ".cvs"), "utf8"); const art = Art.buildArtifact(src, A); const p = c.players[owner];
  if ((await L.base.getBalance(p.publicKey)) < 120_000_000) { const t = new L.Transaction().add(L.SystemProgram.transfer({ fromPubkey: O.publicKey, toPubkey: p.publicKey, lamports: 150_000_000 })); t.feePayer = O.publicKey; await L.sendAndConfirmTransaction(L.base, t, [O]); }
  let rec = L.loadStrats().find(s => s.owner === owner && s.artifact?.source_sha256 === art.source_sha256 && s.artifact?.ruleset === 2); let reused = false;
  if (rec) { const d = await L.readAcct(c.ptok[owner], L.stratPda(BigInt(rec.id))); if (d && Art.parseSealedAccount(d).code.equals(art.code)) reused = true; else rec = null; }
  if (!rec) { const reg = await F.register(c, owner, art.name, art.code, Art.artifactMeta(art)); const sl = await F.seal(c, owner, reg.id, reg.salt, art.code); log(`SIG base Register ${name}: ${reg.sigs[0]}\nSIG TEE Seal ${name}: ${sl.sig} ${sl.err ? "FAILED " + JSON.stringify(sl.err) : "ok"}`); if (sl.err) process.exit(1); rec = L.loadStrats().find(s => s.id === reg.id.toString()); }
  const sealed = Art.parseSealedAccount(await L.readAcct(c.ptok[owner], L.stratPda(BigInt(rec.id)))); field.push({ name, owner, id: BigInt(rec.id), art, salt: Buffer.from(rec.salt, "hex"), code: art.code, commitment: Buffer.from(sealed.commitment), src });
  log(`${name}: strategy ${rec.id} owner ${owner}, work ${art.work}, division ${art.division}, ${reused ? "already sealed (reused)" : "sealed now"}; public commitment ${Buffer.from(sealed.commitment).toString("hex")}`);
  check(`${name}: the sealed bytes are the authored bytecode, and the commitment opens under the stored salt`, sealed.code.equals(art.code) && Art.codeCommit(Buffer.from(rec.salt, "hex"), sealed.code).equals(Buffer.from(sealed.commitment))); }
check(`the whole field fits one division: every strategy's work is at most ${DIV} (division ${DIV} = arena index ${DIV_IDX})`, field.every(e => e.art.work <= DIV), field.map(e => `${e.name} ${e.art.work}`).join(", ")); check("the field has distinct strategies: no two share bytecode", new Set(field.map(e => e.code.toString("hex"))).size === field.length);

// ---- 2. the author's pre-seal view of every entrant (same WASM VM, before the season exists)
log(`\npre-seal forecast, ${NEPS}-episode seasons over 48 seeded worlds (the author tool, dev ensemble):`);
for (const e of field) { const r = A.simulate(e.code, { worlds: 48, episodes: NEPS, field: false, raw: false }); e.forecast = r.dev_season_totals; e.fMean = r.dev.season_total.mean; e.fMed = r.dev.season_total.p50; log(`  ${e.name.padEnd(16)} mean ${f(e.fMean)} median ${f(e.fMed)} p5 ${f(r.dev.season_total.p5)} p95 ${f(r.dev.season_total.p95)} (division ${r.division})`); }

// ---- 3. the season, through the Phase 1 flows
const sid = BigInt(Date.now() % 1_000_000_000 + 14_000_000); const owners = [...new Set(field.map(e => e.owner))];
// earlier runs move stake between the test players, so make sure every owner can pay for all its entries BEFORE a season exists
await F.fundStake(c, field.reduce((n, e) => (n[e.owner] = (n[e.owner] ?? 0) + FEE, n), {}), log); const ownersBefore = {}; for (const o of owners) ownersBefore[o] = await F.bal(c, o);
log(`\nseason ${sid}, division ${DIV}, ${NEPS} episodes, fee ${FEE} x ${field.length} entrants; owner token balances before entering ${JSON.stringify(ownersBefore)}`);
log("SIG base InitReceipt:", (await F.initReceipt(c, sid)).join(" ")); log("SIG base InitPool:", await F.initPool(c, sid)); const hubB = await F.hubLamports(c);
const cs = await F.createSeason(c, sid, { neps: NEPS, fee: FEE, division: DIV_IDX, window: 150_000, seedTimeout: 60_000, grace: F.MIN_GRACE, minEntrants: 4 }); log(`SIG TEE CreateSeason: ${cs.sig} ${cs.err ? "FAILED " + JSON.stringify(cs.err) : "ok"}`); if (!check("CreateSeason (division 32)", !cs.err)) process.exit(1);
log(`pool token account usable after ${(await F.awaitPoolReady(c, sid, field[0].owner, field[0].id)).toFixed(1)}s`); const en = await F.enter(c, sid, field.map(e => [e.owner, e.id]), log); if (!check(`all ${field.length} sealed strategies entered`, en.every(r => !r.err))) process.exit(1);
// the pool's own balance is readable by nobody but the program, so what the pool took in is observed from the owners' debits
const ownersAfterEnter = {}; for (const o of owners) ownersAfterEnter[o] = await F.bal(c, o); log(`owners' token balances after entering ${JSON.stringify(ownersAfterEnter)}; paid in ${owners.reduce((x, o) => x + ownersBefore[o] - ownersAfterEnter[o], 0)}`);
const lk = await L.sendTee(c.URL, [F.lockIx(sid)], [O]); const sd = await L.sendTee(c.URL, [F.seedIx(sid)], [O]); log(`SIG Lock: ${lk.sig}\nSIG RequestSeed: ${sd.sig}`); check("Lock and RequestSeed (VRF)", !lk.err && !sd.err);
const d1 = await F.drive(c, sid, { log }); log(`Advance: ${d1.ok} self-metered transactions, ${d1.fail} failures, first ${d1.sigs[0]}, last ${d1.sigs.at(-1)}`); check("the season ran to completion with no compute failures", d1.ok > 0 && d1.fail === 0);
const st = await L.sendTee(c.URL, [F.settleIx(c, sid, field.map(e => e.id))], [O]); log(`SIG TEE Settle (records what each entry is owed, writes the receipt, publishes all ${field.length} inline): ${st.sig} ${st.err ? "FAILED " + JSON.stringify(st.err) : "ok"}`); if (!check("Settle", !st.err)) process.exit(1);
const claimed = await F.claimAll(c, sid, log); log(F.claimsTable(claimed.after)); if (!check("every claim succeeded", claimed.results.every(r => !r.err))) process.exit(1);
const ownersAfter = {}; for (const o of owners) ownersAfter[o] = await F.bal(c, o);
const regs = field.map(e => L.regPda(e.id)); const parts = [[L.receiptPda(sid), ...regs.slice(0, 3)], regs.slice(3)]; const cms = []; for (const accts of parts) { const cm = await L.sendTee(c.URL, [F.commitIx(accts)], [O]); cms.push(cm); log(`SIG TEE Commit: ${cm.sig} ${cm.err ? "FAILED " + JSON.stringify(cm.err) : "ok"}`); } check("Commit of the receipt and registries to base", cms.every(x => !x.err));
const raw = await F.readReceiptBase(sid, field.length); if (!check("the receipt is on base with every entry published", !!raw)) process.exit(1); const rc = K.parseReceipt(raw); log(`receipt: kind ${rc.kind}, ${rc.ns} entrants, ${rc.published} published, ${rc.neps} episodes, seed words ${rc.seedA} / ${rc.seedB}`);

// ---- 4. entrant -> VM score -> published rank
const local = A.season(field.map(e => e.code), rc.seedA, rc.seedB, NEPS); const recs = []; for (const e of field) recs.push(await F.ownerRec(c, e.owner, e.id));
const rows = field.map((e, i) => ({ id: e.id, owner: e.owner, name: e.name, onchainTotal: recs[i].pnl, localTotal: local.totals[i], ownerRank: recs[i].rank, receiptRank: rc.entries[i].rank, receiptSeasonRank: rc.entries[i].seasonRank }));
log(`\nENTRANT -> SCORE -> RANK  (season packs ${local.packs}; scores in vol-units)\n  entry strategy          owner   on-chain total   local VM replay    receipt rank   forecast mean   realised vs forecast`);
for (const [i, r] of rows.entries()) log(`  ${String(i).padStart(3)}  ${r.name.padEnd(16)} ${String(r.owner).padStart(4)}   ${f(q16(r.onchainTotal)).padStart(12)}   ${f(q16(r.localTotal)).padStart(14)}   ${String(r.receiptRank).padStart(10)}   ${f(field[i].fMean).padStart(13)}   percentile ${K.percentileOf(q16(r.onchainTotal), field[i].forecast).toFixed(0)} of its own forecast`);
runAll("score and rank checks:", K.scoreRankChecks(rows));
check("every owner-read record is for this season and covers all entrants", recs.every(r => r && r.season === Number(sid) && r.n === field.length));

// ---- 5. skill, not luck: the same field over many independent seasons by the same VM
const seasons = []; let x = Number(sid % 1_000_000n) + 17; const nextWord = () => { x = (x * 1103515245 + 12345) % 2147483647; return BigInt(x) * 2654435761n + BigInt(seasons.length + 1); };
for (let k = 0; k < 300; k++) { const s = A.season(field.map(e => e.code), nextWord(), nextWord(), NEPS); seasons.push(K.rankByScore(s.totals)); } const stab = K.stability(seasons, rows.map(r => r.receiptRank));
log(`\nSTABILITY over 300 other seasons of this same field (same VM, fresh seeds): mean rank per entrant`); field.forEach((e, i) => log(`  ${e.name.padEnd(16)} mean rank ${stab.meanRank[i].toFixed(2)}   realised rank ${rows[i].receiptRank}`));
log(`  Spearman correlation between realised ranks and mean ranks: ${stab.spearman.toFixed(2)}; the realised season agrees with the majority outcome in ${stab.pairsAgreeing} of ${stab.pairs} pairs`);
check("the realised ranking is consistent with the field's long-run order (rank correlation above 0.5)", stab.spearman > 0.5, stab.spearman.toFixed(2));

// ---- 6. receipt hygiene, payouts
const regData = []; for (const e of field) regData.push(Buffer.from((await L.base.getAccountInfo(L.regPda(e.id))).data)); runAll("owed versus claimed:", K.claimsChecks(claimed.after, rc, { fee: FEE }));
const secrets = field.map((e, i) => ({ id: e.id, salt: e.salt, code: e.code, regCommit: regData[i].subarray(48, 80), total: recs[i].pnl }));
runAll("\nreceipt checks (the full public receipt):", K.receiptChecks(rc, raw, secrets, { season: sid, neps: NEPS })); runAll("public coarse view checks:", K.coarseChecks(coarseReceipt(raw), rc, secrets));
{ let bad = 0; for (const e of field) for (const r of Art.registryChecks(regData[field.indexOf(e)], { code: e.code, salt: e.salt, commitment: regData[field.indexOf(e)].subarray(48, 80) })) if (!r.ok) { bad++; check(`${e.name} registry: ${r.name}`, false); } check(`all ${field.length} public registry entries hold only the salted commitment (8 hygiene checks each, ${bad} failed)`, bad === 0); }
runAll("payout checks:", K.payoutChecks({ fee: FEE, entries: rows.map(r => ({ owner: r.owner, receiptRank: r.receiptRank })), ownersBefore, ownersAfterEnter, ownersAfter }));
const prizes = K.prizeSplit(BigInt(FEE) * BigInt(field.length), field.length); log(`prizes: rank 1 ${prizes[0]}, rank 2 ${prizes[1]}, rank 3 ${prizes[2]} of a pot of ${FEE * field.length}; owner nets ${JSON.stringify(Object.fromEntries(owners.map(o => [o, String(BigInt(ownersAfter[o]) - BigInt(ownersBefore[o]))])))}`);

// ---- 7. one VM: the bytes on chain, the bytes assembled, the bytes simulated
const tie = []; for (const [i, e] of field.entries()) { const onchain = Art.parseSealedAccount(await L.readAcct(c.ptok[e.owner], L.stratPda(e.id))).code; tie.push(onchain.equals(e.code) && A.assemble(e.src).bytecode === e.code.toString("hex") && A.hexToBytes(A.assemble(e.src).bytecode).every((b, k) => b === onchain[k])); }
check("for every entrant: the bytecode the author's tool assembled from source, the bytecode the forecast ran, and the bytecode sealed and run on chain are the same bytes", tie.every(Boolean));
check("the on-chain season totals equal a replay of the same bytes by the WASM VM using the season's own seed words (so the pre-seal tool and the chain are one VM)", rows.every((r, i) => r.onchainTotal === r.localTotal));

// ---- 8. close out: cleanup and release the bond
const cc = await L.sendTee(c.URL, [F.closeClaimsIx(c, sid)], [O]); log(`SIG TEE CloseClaims: ${cc.sig} ${cc.err ? "FAILED " + JSON.stringify(cc.err) : "ok"}`); check("CloseClaims", !cc.err);
const cl = await L.sendTee(c.URL, [F.cleanupIx(c, sid)], [O]); log(`SIG TEE Cleanup: ${cl.sig} ${cl.err ? "FAILED " + JSON.stringify(cl.err) : "ok"}`); check("Cleanup", !cl.err); const hubD = await F.hubLamports(c); check("hub made whole for the arena", hubD === hubB, `before CreateSeason ${hubB}, after Cleanup ${hubD}`);
const cu = await L.sendTee(c.URL, [F.commitUndelegateIx([L.receiptPda(sid)])], [O]); log(`SIG TEE Commit+undelegate receipt: ${cu.sig}`); let a; for (let t = 0; t < 60; t++) { a = await L.base.getAccountInfo(L.receiptPda(sid)); if (a && a.owner.equals(L.PROGRAM) && a.data[144] === 2) break; await L.sleep(1500); }
const RR = L.parseReceipt(a.data); const l0 = a.lamports; const rel = await L.sendBase([F.releaseBondIx(sid, O.publicKey)], [O]); const l1 = await L.base.getBalance(L.receiptPda(sid)); log(`SIG base ReleaseBond: ${rel}`);
check("the creator bond is released exactly, nothing forfeited, arena rent drawn equals reclaimed", BigInt(l0 - l1) === RR.release && RR.release === RR.bond && RR.forfeit === 0n && RR.rentDrawn === RR.rentReclaimed, `bond ${RR.bond}, released ${l0 - l1}, drawn ${RR.rentDrawn}, reclaimed ${RR.rentReclaimed}`);

// ---- 9. secrets never reached a visible file
function* walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (["node_modules", "target", ".git"].includes(e.name)) continue; const q = path.join(d, e.name); if (e.isDirectory()) yield* walk(q); else if (fs.statSync(q).size < 20_000_000) yield q; } }
// salts are always secret. A strategy's code and hashes are secret too, except where its source is a public example in this repository (all six here), which is public by construction
const isPublic = e => fs.existsSync(path.join(root, "strategies", e.name + ".cvs")); const needles = [...L.loadStrats().map(s => s.salt).filter(Boolean), ...field.filter(e => !isPublic(e)).flatMap(e => [e.code.toString("hex"), e.art.code_sha256, e.art.source_sha256])]; let files = 0, hits = 0; for (const fl of walk(root)) { const t = fs.readFileSync(fl).toString("latin1"); files++; for (const n of needles) if (t.includes(n)) { hits++; log(`LEAK: a secret value appears in ${path.relative(root, fl)}`); } }
const scope = field.every(isPublic) ? "; the strategies themselves are public by construction (their sources are repository examples)" : ", and no sealed non-public strategy or hash either"; check(`no salt (${L.loadStrats().length} of them) appears in any of ${files} repository or evidence files${scope}`, hits === 0);
log(`== campaign: ${checks.filter(Boolean).length}/${checks.length} checks | payer ${(await sol(O.publicKey)).toFixed(4)} SOL`); process.exit(checks.every(Boolean) ? 0 : 1);

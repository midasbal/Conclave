// Devnet proof of money-and-lifecycle v2, real signatures through the TEE, real stake tokens. Every transaction signature is written to evidence/proof3a_<mode>.txt.
//   node client/proof3a.mjs paid      a full paid season: authored sealed entrants, season phase, finals phase for the top 3, Settle records, every entry claimed, claims account closed, arena closed, bond released
//   node client/proof3a.mjs grief     one entrant UNDELEGATES its own token account before claiming: everyone else is still paid, the season still closes, CloseClaims is refused; then the account is put back and the claim completes
//   node client/proof3a.mjs void-open a paid finals season run to the end of its season phase, whose finals seed is deliberately never requested
//   node client/proof3a.mjs void-close   after the finals seed timeout (360,000 slots): the void settles the whole pot by the frozen season ranks
// Salts, code and unsalted code hashes are never logged. Season totals of these public example strategies are printed on purpose, to show the replay.
import * as L from "./lib.mjs"; import * as F from "./flows.mjs"; import * as Art from "./artifact.mjs"; import * as K from "./campaign_lib.mjs"; import { load } from "./author.mjs"; import { coarseReceipt, coarseClaims } from "../server/src/receipt.mjs";
import fs from "fs"; import path from "path"; import { fileURLToPath } from "url"; import { createRequire } from "module";
const E = createRequire(import.meta.url)("@magicblock-labs/ephemeral-rollups-sdk");
const here = path.dirname(fileURLToPath(import.meta.url)); const { O } = L; const mode = process.argv[2];
if (!["paid", "grief", "void-open", "void-close"].includes(mode)) { console.error("mode: paid | grief | void-open | void-close"); process.exit(2); }
const log = L.logger(L.EV + `proof3a_${mode.startsWith("void") ? "void" : mode}.txt`); const checks = []; const check = (name, ok, detail = "") => { checks.push(!!ok); log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " | " + detail : ""}`); return !!ok; }; const runAll = (title, list) => { log(title); for (const x of list) check(x.name, x.ok, x.detail ?? ""); };
const done = () => { log(`== ${mode}: ${checks.filter(Boolean).length}/${checks.length} checks passed | payer ${"" + payerNow} SOL`); process.exit(checks.every(Boolean) ? 0 : 1); };
let payerNow = "?"; const sol = async k => (await L.base.getBalance(k)) / 1e9; const finish = async () => { payerNow = await sol(O.publicKey); done(); };
const tee = async (label, ix, signers = [O], opts) => { const r = await L.sendTee(c.URL, [ix], signers, opts); log(`SIG TEE ${label}: ${r.sig} ${r.err ? "FAILED " + JSON.stringify(r.err) : "ok"}`); return r; };
const must = (r, what) => { if (r.err) { check(what, false, JSON.stringify(r.err)); log("stopping: a required step failed"); process.exit(1); } return r; };
const refused = (r, code, what) => check(`${what} is refused (${code})`, !!r.err && JSON.stringify(r.err).includes(String(code)), JSON.stringify(r.err || "ACCEPTED"));
const slotNow = async () => (await L.rpc(c.URL, "getSlot")).result;
const A = await load(); const c = await F.ctx(); const STATE = path.join(L.KEYS, "proof3a_void_state.json"); const FEE = 10, DIV_IDX = 2, FINALS_SEEDTO = 360_000;
log(`\n== PROOF 3a ${mode} ${new Date().toISOString()} program ${L.PROGRAM.toBase58()} validator ${c.validator.toBase58()} payer ${await sol(O.publicKey)} SOL`);

const balances = async () => { const o = []; for (let i = 0; i < 5; i++) o.push(await F.bal(c, i)); return o; };
const sum = a => a.reduce((x, y) => x + y, 0);
/** move stake tokens between test players inside the rollup, so every owner in the field can pay its fee */
async function fund(owners) { const need = {}; for (const o of owners) need[o] = (need[o] || 0) + FEE;
  for (const [o, n] of Object.entries(need)) { let have = await F.bal(c, +o); if (have >= n) continue; const all = await balances(); const from = all.indexOf(Math.max(...all)); const amt = n - have + FEE;
    const d = Buffer.alloc(9); d[0] = 3; d.writeBigUInt64LE(BigInt(amt), 1); must(await tee(`move ${amt} stake tokens from player ${from} to player ${o}`, new L.TransactionInstruction({ programId: L.TOKEN, keys: [L.K(c.ata(c.players[from].publicKey), true), L.K(c.ata(c.players[+o].publicKey), true), L.K(c.players[from].publicKey, false, true)], data: d }), [O, c.players[from]]), "fund a player"); } }
/** register and seal fresh authored strategies (salt custody in the key folder, never logged) */
async function sealField(spec) { const field = [];
  for (const [name, owner] of spec) { const src = fs.readFileSync(path.join(here, "..", "strategies", name + ".cvs"), "utf8"); const art = Art.buildArtifact(src, A); const p = c.players[owner];
    if ((await L.base.getBalance(p.publicKey)) < 60_000_000) { const t = new L.Transaction().add(L.SystemProgram.transfer({ fromPubkey: O.publicKey, toPubkey: p.publicKey, lamports: 60_000_000 })); t.feePayer = O.publicKey; log("SIG base top up player", owner, await L.sendAndConfirmTransaction(L.base, t, [O])); }
    const reg = await F.register(c, owner, art.name, art.code, Art.artifactMeta(art)); log(`SIG base Register ${name} (strategy ${reg.id}, owner ${owner}): ${reg.sigs[0]} | delegate: ${reg.sigs[1]}`);
    must(await F.seal(c, owner, reg.id, reg.salt, art.code).then(r => (log(`SIG TEE Seal ${name}: ${r.sig} ${r.err ? JSON.stringify(r.err) : "ok"}`), r)), "Seal");
    const raw = await L.readAcct(c.ptok[owner], L.stratPda(reg.id)); const sealed = Art.parseSealedAccount(raw); check(`${name}: sealed bytes are the authored bytecode, in the new ${raw.length}-byte account`, sealed.code.equals(art.code) && raw.length === 404, `work ${art.work}`);
    field.push({ name, owner, id: reg.id, salt: reg.salt, code: art.code }); } return field; }
async function createAndEnter(sid, field, neps) {
  const rc = await F.initReceipt(c, sid); log(`SIG base InitReceipt: ${rc[0]} | delegate: ${rc[1]}`); log(`SIG base InitPool: ${await F.initPool(c, sid)}`);
  const hubBefore = await F.hubLamports(c); const before = await balances();
  const cs = await F.createSeason(c, sid, { neps, fee: FEE, finals: true, division: DIV_IDX, window: 60_000, seedTimeout: 60_000, grace: F.MIN_GRACE, minEntrants: field.length }); log(`SIG TEE CreateSeason (${neps} episodes, fee ${FEE}, finals on): ${cs.sig} ${cs.err ? JSON.stringify(cs.err) : "ok"}`); must(cs, "CreateSeason");
  log(`pool token account usable after ${(await F.awaitPoolReady(c, sid, field[0].owner, field[0].id)).toFixed(1)}s`);
  const en = await F.enter(c, sid, field.map(e => [e.owner, e.id]), log); if (!check(`${field.length} sealed entrants entered`, en.every(r => !r.err))) process.exit(1);
  const afterEnter = await balances(); check(`entries in: ${FEE} x ${field.length} left the owners' accounts`, sum(before) - sum(afterEnter) === FEE * field.length, `${before} -> ${afterEnter}`);
  must(await tee("Lock", F.lockIx(sid)), "Lock"); must(await tee("RequestSeed (season)", F.seedIx(sid)), "RequestSeed"); return { hubBefore, before, afterEnter }; }
async function driveSeason(sid) { const d = await F.drive(c, sid, { log }); log(`Advance (season phase): ${d.ok} txs, ${d.fail} failures, ${d.wall.toFixed(0)}s`); for (const s of d.sigs) log("SIG TEE Advance:", s); check("the season phase ran to completion", d.ok > 0 && d.fail === 0); }
async function playFinals(sid) { must(await tee("RequestSeed (finals, the same instruction, the pinned queue)", F.seedIx(sid)), "finals RequestSeed"); const d = await F.drive(c, sid, { log }); log(`Advance (finals phase): ${d.ok} txs, ${d.fail} failures, ${d.wall.toFixed(0)}s`); for (const s of d.sigs) log("SIG TEE Advance:", s); check("the finals phase ran to completion", d.ok > 0 && d.fail === 0); }
async function settleAndCommit(sid, field) { must(await tee("Settle (records what each entry is owed; publishes every entry inline)", F.settleIx(c, sid, field.map(e => e.id))), "Settle");
  const regs = field.map(e => L.regPda(e.id)); for (let i = 0; i < regs.length; i += 4) must(await tee("Commit receipt + registries to base", F.commitIx([...(i === 0 ? [L.receiptPda(sid)] : []), ...regs.slice(i, i + 4)])), "Commit");
  const raw = await F.readReceiptBase(sid, field.length); if (!check("the receipt is on base with every entry published", !!raw)) process.exit(1); return { raw, R: L.parseReceipt(raw) }; }
/** the receipt against a local replay of the same VM, from the receipt's own seed words */
async function verifyReplay(sid, field, R, neps, played) {
  const season = A.season(field.map(e => e.code), R.seedA, R.seedB, neps).totals; const q = K.qualifiersOf(season); const finals = field.map(() => 0n);
  if (played) { const t = A.season(q.map(i => field[i].code), R.finals.seedA, R.finals.seedB, R.finals.neps).totals; q.forEach((i, k) => { finals[i] = t[k]; }); }
  const recs = []; for (const e of field) recs.push(await F.ownerRec(c, e.owner, e.id)); const want = K.expectedOutcome({ season, finals: played ? finals : null, fee: FEE });
  log("entry strategy         owner season-rank final-rank | season total (chain / local) | finals total (chain / local)"); field.forEach((e, i) => log(`  ${i} ${e.name.padEnd(15)} ${e.owner}    ${R.entries[i].seasonRank}          ${R.entries[i].rank}        | ${recs[i].pnl} / ${season[i]} | ${recs[i].finalsPnl} / ${finals[i]}`));
  runAll("replay checks (both phases, from the receipt's seed words):", K.scoreRankChecks(field.map((e, i) => ({ id: e.id, owner: e.owner, name: e.name, onchainTotal: recs[i].pnl, localTotal: season[i], ownerRank: recs[i].rank, receiptRank: R.entries[i].rank, receiptSeasonRank: R.entries[i].seasonRank })), { onchain: recs.map(r => r.finalsPnl), local: finals }));
  check("score commitments recompute from the owners' salts and the replayed totals", field.every((e, i) => L.scoreCommit(e.salt, sid, e.id, season[i], finals[i], neps, R.entries[i].finalist ? R.finals.neps : 0).equals(R.entries[i].score)));
  check("the receipt marks exactly the replay's qualifiers as finalists (none when voided)", R.entries.every((x, i) => x.finalist === (played && q.includes(i))));
  return { season, finals, want }; }
/** claim one entry at a time and, after EVERY claim, reconcile: tokens that reached owners == the claimed total, and what is outstanding == pot - claimed. The program itself asserts pool >= everything unclaimed before each transfer */
async function claimStepwise(sid, slots, base) { let ok = true; for (const slot of slots) { const cl = await F.readClaims(c, sid); const e = cl.entries[slot]; if (e.done) continue; const r = await tee(`Claim slot ${slot} (${e.owed})`, F.claimIx(c, sid, slot, new L.PublicKey(e.owner))); if (r.err) { ok = false; continue; } const now = await F.readClaims(c, sid); const out = sum((await balances()).map((x, i) => x - base[i])); ok = ok && BigInt(out) === now.claimed; log(`   after this claim: claimed ${now.claimed} of ${now.owed}, tokens that reached owners ${out}, outstanding ${now.owed - now.claimed}`); } return ok; }
async function closeClaims(sid) { must(await tee("CloseClaims", F.closeClaimsIx(c, sid)), "CloseClaims"); check("the claims account is gone", (await F.readClaims(c, sid)) === null); }
async function cleanupAndBond(sid) { must(await tee("Cleanup (arena + permission)", F.cleanupIx(c, sid)), "Cleanup"); must(await tee("Commit+undelegate the closed receipt", F.commitUndelegateIx([L.receiptPda(sid)])), "undelegate receipt");
  let a; for (let t = 0; t < 60; t++) { a = await L.base.getAccountInfo(L.receiptPda(sid)); if (a && a.owner.equals(L.PROGRAM) && a.data[144] === 2) break; await L.sleep(1500); }
  const RR = L.parseReceipt(a.data); const l0 = a.lamports; const rel = await L.sendBase([F.releaseBondIx(sid, O.publicKey)], [O]); const l1 = await L.base.getBalance(L.receiptPda(sid)); log(`SIG base ReleaseBond: ${rel}`);
  check("the creator bond is released exactly, nothing forfeited, arena rent drawn equals reclaimed", BigInt(l0 - l1) === RR.release && RR.release === RR.bond && RR.forfeit === 0n && RR.rentDrawn === RR.rentReclaimed && RR.rentDrawn > 0n, `bond ${RR.bond} released ${l0 - l1} drawn ${RR.rentDrawn} reclaimed ${RR.rentReclaimed}`); }
const newSid = off => BigInt(Date.now() % 1_000_000_000 + off);

if (mode === "paid") {
  const sid = newSid(20_000_000), NEPS = 20; log("season id", sid.toString()); const spec = [["momentum", 0], ["calm_trend", 1], ["ema_cross", 2], ["mean_reversion", 3], ["quick_fade", 4]]; await fund(spec.map(s => s[1])); const field = await sealField(spec);
  const hubAfterSeal = await F.hubLamports(c); const S = await createAndEnter(sid, field, NEPS); const hubOpen = await F.hubLamports(c); log(`hub lamports: before CreateSeason ${S.hubBefore}, after ${hubOpen} (arena, permission and claims account drew ${S.hubBefore - hubOpen}); after sealing was ${hubAfterSeal}`);
  check("the arena is unreadable without a token", (await L.readAcct(L.TEE, L.arenaPda(sid))) === null);
  await driveSeason(sid); refused(await tee("Settle between the phases (probe)", F.settleIx(c, sid)), 9115, "Settle while the finals can still be played"); refused(await tee("Cancel after the season phase (probe)", F.cancelIx(c, sid)), 9033, "refunding a finished season phase");
  await playFinals(sid); const { raw, R } = await settleAndCommit(sid, field); const afterSettle = await balances(); check("Settle moved no tokens", afterSettle.every((x, i) => x === S.afterEnter[i]));
  check("receipt: settled, finals played on their own seed, three qualifiers, owed = pot", R.kind === 0 && R.finals.status === 1 && R.finals.qualifiers === 3 && R.finals.neps === 15 && R.neps === NEPS && (R.finals.seedA !== R.seedA || R.finals.seedB !== R.seedB) && R.owed === BigInt(FEE * field.length), `season seed ${R.seedA}/${R.seedB} packs ${R.packs}; finals seed ${R.finals.seedA}/${R.finals.seedB} packs ${R.finals.packs}`);
  const { want } = await verifyReplay(sid, field, R, NEPS, true);
  const anon = await L.readAcct(L.TEE, L.claimsPda(sid)); check("the claims account is readable with no token at all", !!anon); const view = coarseClaims(anon); log("server claims view before claiming:", JSON.stringify(view));
  const cl0 = await F.readClaims(c, sid); log(F.claimsTable(cl0)); check("each entry is owed exactly the prize of its final rank", cl0.entries.every((e, i) => e.owed === want.owed[i]));
  refused(await tee("CloseClaims with every entry unclaimed (probe)", F.closeClaimsIx(c, sid)), 9083, "CloseClaims before any claim");
  const paid = cl0.entries.filter(e => !e.done).map(e => e.slot); check("claiming one at a time, tokens out always equal the claimed total", await claimStepwise(sid, paid.slice(0, -1), S.afterEnter));
  refused(await tee("CloseClaims with ONE entry unclaimed (probe)", F.closeClaimsIx(c, sid)), 9083, "CloseClaims with one entry still unclaimed");
  check("the last claim reconciles too", await claimStepwise(sid, paid.slice(-1), S.afterEnter)); const clN = await F.readClaims(c, sid); log(F.claimsTable(clN));
  const again = await tee(`repeat Claim slot ${paid[0]}`, F.claimIx(c, sid, paid[0], new L.PublicKey(cl0.entries[paid[0]].owner))); const after = await balances(); check("a repeat claim succeeds and pays nothing", !again.err && sum(after) === sum(S.before));
  runAll("owed versus claimed:", K.claimsChecks(clN, R, { fee: FEE })); runAll("token balances, entries in against claims out:", K.payoutChecks({ fee: FEE, entries: field.map((e, i) => ({ owner: e.owner, receiptRank: R.entries[i].rank })), ownersBefore: Object.fromEntries(S.before.entries()), ownersAfterEnter: Object.fromEntries(S.afterEnter.entries()), ownersAfter: Object.fromEntries(after.entries()) }));
  log("public receipt view:", JSON.stringify(coarseReceipt(raw)));
  await closeClaims(sid); await cleanupAndBond(sid); const hubEnd = await F.hubLamports(c); check("hub made whole at close: arena, permission and claims rent all returned", hubEnd === S.hubBefore, `before CreateSeason ${S.hubBefore}, after close ${hubEnd}`);
  await finish();
}

if (mode === "grief") {
  const sid = newSid(21_000_000), NEPS = 15; log("season id", sid.toString()); const spec = [["momentum", 0], ["ema_cross", 2], ["trend_stop", 4]]; await fund(spec.map(s => s[1])); const field = await sealField(spec);
  const S = await createAndEnter(sid, field, NEPS); await driveSeason(sid); await playFinals(sid);
  // all three qualify and all three are paid, so every entrant is owed money. The griefer withdraws its own token account from the rollup BEFORE Settle, using only its own authority
  const W = 2; const gOwner = field[W].owner; const gp = c.players[gOwner]; const eata = L.eataOf(gp.publicKey, c.mint); const ata = c.ata(gp.publicKey); const gBefore = await F.bal(c, gOwner);
  const baseOwner = async k => (await L.base.getAccountInfo(k))?.owner.toBase58() ?? "absent"; log(`griefer: player ${gOwner} (entry ${W}); its eATA on base is owned by ${await baseOwner(eata)} (the delegation program means delegated); rollup token balance ${gBefore}`);
  must(await tee(`GRIEF: player ${gOwner} undelegates its own token account (signed by that player)`, E.undelegateIx(gp.publicKey, c.mint), [O, gp]), "undelegate");
  let undone = false; for (let t = 0; t < 60; t++) { if ((await baseOwner(eata)) === L.ESPL.toBase58()) { undone = true; break; } await L.sleep(1500); } check("the withdrawal is committed: the eATA is back on base, no longer delegated", undone, await baseOwner(eata));
  const { R } = await settleAndCommit(sid, field); check("Settle succeeds with a withdrawn account in the field", R.owed === 30n && R.finals.status === 1); await verifyReplay(sid, field, R, NEPS, true);
  const cl0 = await F.readClaims(c, sid); log(F.claimsTable(cl0)); check("all three entrants, the griefer included, are owed money", cl0.entries.every(e => e.owed > 0n));
  const base = S.afterEnter.slice(); const othersBefore = await balances();
  const g1 = await tee(`Claim slot ${W} (the griefer's own, while withdrawn)`, F.claimIx(c, sid, W, gp.publicKey)); check("the griefer's own claim fails while its account is withdrawn", !!g1.err, JSON.stringify(g1.err || "ACCEPTED"));
  for (let i = 0; i < 3; i++) if (i !== W) { const r = await tee(`Claim slot ${i} (${cl0.entries[i].owed})`, F.claimIx(c, sid, i, c.players[field[i].owner].publicKey)); const got = (await F.bal(c, field[i].owner)) - othersBefore[field[i].owner]; check(`entrant ${i} (player ${field[i].owner}) is paid in full despite the withdrawal`, !r.err && BigInt(got) === cl0.entries[i].owed, `received ${got} of ${cl0.entries[i].owed}`); }
  const g2 = await tee(`Claim slot ${W} again (after the others were paid)`, F.claimIx(c, sid, W, gp.publicKey)); check("the griefer's claim still fails, and only it", !!g2.err, JSON.stringify(g2.err || "ACCEPTED"));
  const cl1 = await F.readClaims(c, sid); log(F.claimsTable(cl1)); check("only the withdrawer's amount is outstanding", cl1.owed - cl1.claimed === cl0.entries[W].owed && cl1.entries.every((e, i) => e.done === (i !== W)));
  refused(await tee("CloseClaims with the griefer's entry unclaimed (probe)", F.closeClaimsIx(c, sid)), 9083, "CloseClaims while the withdrawn entry is unclaimed");
  await cleanupAndBond(sid); check("the season closed (arena gone, bond released) while the claim waits", (await F.readClaims(c, sid)) !== null);
  // no expiry: whenever the account is usable again the claim completes. Here the payer (NOT the griefer) delegates it again
  log(`re-delegating player ${gOwner}'s token account, signed by the payer only`);
  try { const sig = await L.sendBase([E.delegateEphemeralAtaIx(O.publicKey, eata, c.validator)], [O]); log(`SIG base re-delegate eATA: ${sig}`); } catch (e) { log("re-delegate signed by the payer alone FAILED:", String(e).slice(0, 300)); }
  let back = false; for (let t = 0; t < 60; t++) { if ((await baseOwner(eata)) === L.DLP.toBase58()) { back = true; break; } await L.sleep(1500); } check("the token account is delegated again (somebody other than the griefer can do it)", back);
  await L.sleep(8000); let g3; for (let t = 0; t < 10; t++) { g3 = await tee(`Claim slot ${W} (after re-delegation)`, F.claimIx(c, sid, W, gp.publicKey)); if (!g3.err) break; await L.sleep(3000); }
  const gAfter = await F.bal(c, gOwner); check("the waiting claim completes later, in full: no expiry, nothing lost", !g3.err && BigInt(gAfter - gBefore) === cl0.entries[W].owed, `${gBefore} -> ${gAfter}`);
  if (!g3.err) { const total = sum(await balances()); check("entries in equal claims out across the whole season", total === sum(S.before), `${sum(S.before)} -> ${total}`); await closeClaims(sid); const hubEnd = await F.hubLamports(c); check("hub made whole once the last claim is in", hubEnd === S.hubBefore, `before CreateSeason ${S.hubBefore}, at close ${hubEnd}`); }
  await finish();
}

if (mode === "void-open") {
  const sid = newSid(22_000_000), NEPS = 15; log("season id", sid.toString()); const spec = [["calm_trend", 0], ["mean_reversion", 1], ["quick_fade", 2], ["trend_stop", 3]]; await fund(spec.map(s => s[1])); const field = await sealField(spec);
  const S = await createAndEnter(sid, field, NEPS); await driveSeason(sid); const seasonDoneBy = await slotNow();
  refused(await tee("Settle inside the finals seed timeout (probe)", F.settleIx(c, sid)), 9115, "settling before the finals seed timeout");
  fs.writeFileSync(STATE, JSON.stringify({ sid: sid.toString(), neps: NEPS, seasonDoneBy, before: S.before, afterEnter: S.afterEnter, hubOpen: await F.hubLamports(c), hubBefore: S.hubBefore, field: field.map(e => ({ name: e.name, owner: e.owner, id: e.id.toString() })) }), { mode: 0o600 });
  log(`the finals seed is deliberately never requested. The season phase was over by slot ${seasonDoneBy}; the void is available at slot ${seasonDoneBy + FINALS_SEEDTO} at the latest`);
  await finish();
}

if (mode === "void-close") {
  const st = JSON.parse(fs.readFileSync(STATE, "utf8")); const sid = BigInt(st.sid); const salts = new Map(L.loadStrats().map(s => [s.id, s])); const field = st.field.map(e => ({ ...e, id: BigInt(e.id), salt: Buffer.from(salts.get(e.id).salt, "hex"), code: Buffer.from(salts.get(e.id).code, "hex") }));
  const now = await slotNow(); if (now < st.seasonDoneBy + FINALS_SEEDTO + 200) { log(`too early: slot ${now}, need ${st.seasonDoneBy + FINALS_SEEDTO + 200}`); process.exit(3); }
  log(`season ${sid}: ${now - st.seasonDoneBy} slots since the season phase was over (timeout ${FINALS_SEEDTO})`);
  refused(await tee("RequestSeed after the finals seed timeout (probe)", F.seedIx(sid)), 9111, "asking for the finals seed after its timeout"); refused(await tee("Cancel (probe)", F.cancelIx(c, sid, c.players[4].publicKey), [O, c.players[4]]), 9033, "refunding a season whose season phase finished");
  const pre = await balances(); const settle = await tee("Settle of the VOIDED finals, signed by an outsider", (() => { const ix = F.settleIx(c, sid, field.map(e => e.id)); ix.keys[0] = L.K(c.players[4].publicKey, false, true); return ix; })(), [O, c.players[4]]); must(settle, "voided Settle");
  const regs = field.map(e => L.regPda(e.id)); for (let i = 0; i < regs.length; i += 4) must(await tee("Commit receipt + registries to base", F.commitIx([...(i === 0 ? [L.receiptPda(sid)] : []), ...regs.slice(i, i + 4)])), "Commit");
  const raw = await F.readReceiptBase(sid, field.length); if (!check("the receipt is on base with every entry published", !!raw)) process.exit(1); const R = L.parseReceipt(raw);
  check("the receipt is marked voided, reason finals seed timeout, with no finals seed and no finalists", R.finals.status === 2 && R.reason === 4 && R.finals.seedA === 0n && R.finals.qualifiers === 0 && R.entries.every(e => !e.finalist), JSON.stringify(coarseReceipt(raw)));
  const { want } = await verifyReplay(sid, field, R, st.neps, false); check("every final rank equals the frozen season rank", R.entries.every(e => e.rank === e.seasonRank));
  const cl0 = await F.readClaims(c, sid); log(F.claimsTable(cl0)); check("the whole pot is owed by season rank, 50/30/20", cl0.owed === BigInt(FEE * field.length) && cl0.entries.every((e, i) => e.owed === want.owed[i]));
  refused(await tee("CloseClaims with every entry unclaimed (probe)", F.closeClaimsIx(c, sid)), 9083, "CloseClaims before the claims");
  check("claiming one at a time, tokens out always equal the claimed total", await claimStepwise(sid, cl0.entries.filter(e => !e.done).map(e => e.slot), pre)); const clN = await F.readClaims(c, sid); log(F.claimsTable(clN)); runAll("owed versus claimed:", K.claimsChecks(clN, R, { fee: FEE }));
  const after = await balances(); check("every owner received exactly the prizes of its season ranks", after.every((x, o) => BigInt(x - pre[o]) === field.reduce((a, e, i) => a + (e.owner === o ? want.owed[i] : 0n), 0n)), `${pre} -> ${after}`);
  const h0 = await F.hubLamports(c); await closeClaims(sid); await cleanupAndBond(sid); const h2 = await F.hubLamports(c); const drew = st.hubBefore - st.hubOpen;
  check("hub made whole: CloseClaims and Cleanup returned exactly what creating this season drew", drew > 0 && h2 - h0 === drew, `creation drew ${drew}, the two closes returned ${h2 - h0}`);
  await finish();
}

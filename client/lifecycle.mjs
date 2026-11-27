// Devnet scenarios for the season state machine and money safety, real signatures through the TEE.
//   node client/lifecycle.mjs cancel     seed never arrives: anyone cancels after the timeout, every fee comes back exactly
//   node client/lifecycle.mjs undermin   field below the minimum: a stranger's Lock after the window cancels, fees refunded, creator forfeits 25% of the bond
//   node client/lifecycle.mjs recover <season> [n]   cancel and close a season left locked and unseeded (n most recent registered strategies are its entrants)
// Cancel records the refunds; Claim pays them. The happy path with finals is client/season.mjs.
import * as L from "./lib.mjs"; import * as F from "./flows.mjs"; import fs from "fs";
const { O } = L; const mode = process.argv[2]; const log = L.logger(L.EV + `lifecycle_${mode}.txt`); const c = await F.ctx(); const names = ["Mom20th", "EMAcross", "TrendSwitch"];
const slot = async () => (await L.rpc(L.TEE, "getSlot")).result; const waitSlot = async n => { while ((await slot()) < n) await L.sleep(400); };
const sol = async () => (await L.base.getBalance(O.publicKey)) / 1e9; const ok = (r, what) => { log(`${r.err ? "FAILED" : "ok"} ${what}: ${r.sig}${r.err ? " " + JSON.stringify(r.err) : ""}`); return !r.err; };
const checks = []; const check = (name, good, detail = "") => { checks.push(good); log(`${good ? "PASS" : "FAIL"} ${name}${detail ? " | " + detail : ""}`); };
log(`\n== CONCLAVE LIFECYCLE ${mode} season-arg ${process.argv[3] || ""} ${new Date().toISOString()} program ${L.PROGRAM.toBase58()} creator ${O.publicKey.toBase58()} payer SOL ${await sol()}`);

async function receiptBase(sid, pred, tries = 60) { for (let t = 0; t < tries; t++) { const a = await L.base.getAccountInfo(L.receiptPda(sid)); if (a && pred(a)) return a; await L.sleep(1500); } return null; }
async function closeOut(sid, expectForfeit, label) { // commit + undelegate the closed receipt, release the bond, check it equals what the receipt says
  const cu = await L.sendTee(c.URL, [F.commitUndelegateIx([L.receiptPda(sid)])], [O]); ok(cu, "Commit+undelegate receipt");
  const a = await receiptBase(sid, a => a.owner.equals(L.PROGRAM) && a.data[144] === 2); if (!a) { check("receipt back on base in state closed", false); return null; } const R = L.parseReceipt(a.data);
  const l0 = a.lamports; const rel = await L.sendBase([F.releaseBondIx(sid, O.publicKey)], [O]); const l1 = await L.base.getBalance(L.receiptPda(sid));
  log(`SIG base ReleaseBond: ${rel}`); check(`${label}: forfeit is ${expectForfeit}`, R.forfeit === BigInt(expectForfeit), `bond ${R.bond} forfeit ${R.forfeit} release ${R.release} rentDrawn ${R.rentDrawn} rentReclaimed ${R.rentReclaimed}`);
  check(`${label}: the receipt paid out exactly its releasable amount`, BigInt(l0 - l1) === R.release, `${l0} -> ${l1}`); return R; }
const closeClaims = async sid => { const r = await L.sendTee(c.URL, [F.closeClaimsIx(c, sid)], [O]); check("CloseClaims", ok(r, "TEE CloseClaims")); };
async function setup(sid, owners, params) { // strategies, receipt, pool, season
  const ids = []; const hubS0 = await F.hubLamports(c);
  const entries = []; for (const o of owners) { const nm = names[o % 3]; const r = await F.register(c, o, nm, c.codes[nm].code); entries.push({ o, id: r.id, salt: r.salt, code: c.codes[nm].code, name: nm }); }
  log("SIG base Register x" + entries.length); log("SIG base InitReceipt (bond " + F.BOND + "):", (await F.initReceipt(c, sid)).join(" ")); log("SIG base InitPool:", await F.initPool(c, sid));
  for (const e of entries) ok(await F.seal(c, e.o, e.id, e.salt, e.code), `TEE Seal ${e.name}`);
  const hubB = await F.hubLamports(c); log(`hub lamports: before sealing ${hubS0}, after sealing ${hubB} (the ${entries.length} sealed strategy accounts stay in the rollup: ${hubS0 - hubB} lamports, ${(hubS0 - hubB) / entries.length} each)`);
  const cs = await F.createSeason(c, sid, { neps: 2, fee: 10, division: 2, ...params }); ok(cs, "TEE CreateSeason"); const hubC = await F.hubLamports(c); log(`hub lamports after CreateSeason ${hubC}: the arena and its permission drew ${hubB - hubC}`);
  return { entries, hubB, hubC }; }

if (mode === "cancel") {
  const sid = BigInt(Date.now() % 1_000_000_000 + 8_000_000); log("season id", sid.toString()); const S = await setup(sid, [0, 1, 2], { window: 60_000, seedTimeout: 700, minEntrants: 1 });
  log(`pool token account usable after ${(await F.awaitPoolReady(c, sid, 0, S.entries[0].id)).toFixed(1)}s`); const before = []; for (const e of S.entries) before.push(await F.bal(c, e.o));
  await F.enter(c, sid, S.entries.map(e => [e.o, e.id]), log); const after = []; for (const e of S.entries) after.push(await F.bal(c, e.o)); check("each entrant paid exactly 10 into the pool", after.every((x, i) => before[i] - x === 10), `${before} -> ${after}`);
  const lk = await L.sendTee(c.URL, [F.lockIx(sid)], [O]); ok(lk, "TEE Lock (seed is deliberately never requested)"); const lockSlot = await slot();
  const early = await L.sendTee(c.URL, [F.cancelIx(c, sid, c.players[4].publicKey)], [O, c.players[4]]); check("Cancel before the seed timeout is refused (a stranger, 9033)", !!early.err && JSON.stringify(early.err).includes("9033"), JSON.stringify(early.err || "ACCEPTED"));
  await waitSlot(lockSlot + 750); log("seed timeout (700 slots) elapsed, slot", await slot());
  const cx = await L.sendTee(c.URL, [F.cancelIx(c, sid, c.players[4].publicKey, S.entries.map(e => e.id))], [O, c.players[4]]); check("Cancel by a stranger after the timeout", ok(cx, "TEE Cancel (signed by a stranger wallet)"));
  { const cm = await F.claimAll(c, sid, log); log(F.claimsTable(cm.after)); check("every refund claimed", cm.results.every(r => !r.err) && cm.after.claimed === cm.after.owed); }
  const refunded = []; for (const e of S.entries) refunded.push(await F.bal(c, e.o)); check("every fee refunded exactly", refunded.every((x, i) => x === before[i]), `${after} -> ${refunded} (started ${before})`);
  const dup = await L.sendTee(c.URL, [F.cancelIx(c, sid, c.players[4].publicKey)], [O, c.players[4]]); check("a second Cancel is refused (9034), no double refund", !!dup.err && JSON.stringify(dup.err).includes("9034"));
  if (!cx.err) { const sd = await L.sendTee(c.URL, [F.seedIx(sid)], [O]); check("RequestSeed on the cancelled season is refused", !!sd.err); }
  ok(await L.sendTee(c.URL, [F.commitIx([L.receiptPda(sid)])], [O]), "TEE Commit receipt"); const a = await receiptBase(sid, a => a.owner.equals(L.PROGRAM) || a.data[4] === 2); const R = a && L.parseReceipt(a.data);
  check("public record on base: cancelled, reason seed timeout, 30 refunded", R && R.kind === 2 && R.reason === 2 && R.refunded === 30n && R.owed === 30n && R.ns === 3, R ? `kind ${R.kind} reason ${R.reason} refunded ${R.refunded} entrants ${R.ns}` : "no receipt");
  await closeClaims(sid); const cl = await L.sendTee(c.URL, [F.cleanupIx(c, sid)], [O]); check("Cleanup", ok(cl, "TEE Cleanup")); const hubD = await F.hubLamports(c); check("hub made whole: arena rent fully returned", hubD === S.hubB, `before CreateSeason ${S.hubB}, after Cleanup ${hubD}`);
  await closeOut(sid, 0, "seed-timeout cancel");
} else if (mode === "undermin") {
  const sid = BigInt(Date.now() % 1_000_000_000 + 9_000_000); log("season id", sid.toString()); const S = await setup(sid, [0, 1], { window: 4_000, seedTimeout: 30_000, minEntrants: 3 }); const created = await slot();
  log(`pool token account usable after ${(await F.awaitPoolReady(c, sid, 0, S.entries[0].id)).toFixed(1)}s`); const before = []; for (const e of S.entries) before.push(await F.bal(c, e.o));
  await F.enter(c, sid, S.entries.map(e => [e.o, e.id]), log); const early = await L.sendTee(c.URL, [F.lockIx(sid)], [O]); check("the creator cannot cancel early by locking an under-filled field (9031)", !!early.err && JSON.stringify(early.err).includes("9031"), JSON.stringify(early.err || "ACCEPTED"));
  const stranger = await L.sendTee(c.URL, [F.lockIx(sid, c.players[4].publicKey)], [O, c.players[4]]); check("a stranger cannot lock inside the window (9032)", !!stranger.err && JSON.stringify(stranger.err).includes("9032"), JSON.stringify(stranger.err || "ACCEPTED"));
  await waitSlot(created + 4_100); log("entry window elapsed, slot", await slot());
  const lr = await F.register(c, 2, "Mom20th", c.codes["Mom20th"].code); const hubBeforeLate = await F.hubLamports(c); ok(await F.seal(c, 2, lr.id, lr.salt, c.codes["Mom20th"].code), "TEE Seal late strategy (owner 2)"); const lateRent = hubBeforeLate - await F.hubLamports(c); /* sealed after the starting hub reading: since the registry-paid build its rent is the registry's, not the hub's */
  const late = await F.sendEnter(c, sid, 2, lr.id); check("Enter after the window is refused (9030)", !!late.err && JSON.stringify(late.err).includes("9030"), JSON.stringify(late.err || "ACCEPTED"));
  const lk = await L.sendTee(c.URL, [F.lockIx(sid, c.players[4].publicKey)], [O, c.players[4]]); check("a stranger's Lock after the window cancels the under-minimum season", ok(lk, "TEE Lock (stranger)"));
  const cx = await L.sendTee(c.URL, [F.cancelIx(c, sid, c.players[4].publicKey, S.entries.map(e => e.id))], [O, c.players[4]]); check("Cancel and refund by a stranger", ok(cx, "TEE Cancel"));
  { const cm = await F.claimAll(c, sid, log); log(F.claimsTable(cm.after)); check("both refunds claimed", cm.results.every(r => !r.err) && cm.after.claimed === cm.after.owed); }
  const refunded = []; for (const e of S.entries) refunded.push(await F.bal(c, e.o)); check("both fees refunded exactly", refunded.every((x, i) => x === before[i]), `${refunded} (started ${before})`);
  ok(await L.sendTee(c.URL, [F.commitIx([L.receiptPda(sid)])], [O]), "TEE Commit receipt"); const a = await receiptBase(sid, a => a.data[4] === 2); const R = a && L.parseReceipt(a.data); check("public record on base: cancelled, reason under-minimum, 20 refunded", R && R.kind === 2 && R.reason === 1 && R.refunded === 20n && R.ns === 2, R ? `kind ${R.kind} reason ${R.reason} refunded ${R.refunded}` : "no receipt");
  await closeClaims(sid); const cl = await L.sendTee(c.URL, [F.cleanupIx(c, sid)], [O]); check("Cleanup", ok(cl, "TEE Cleanup")); const hubD = await F.hubLamports(c); const forfeit = F.BOND / 100 * 25;
  check("hub made whole and keeps the 25% forfeit (a strategy sealed during the run costs the hub nothing: its registry pays)", hubD - S.hubB === forfeit - lateRent && lateRent === 0, `before CreateSeason ${S.hubB}, after Cleanup ${hubD}, difference ${hubD - S.hubB}, expected +${forfeit} - ${lateRent}`);
  await closeOut(sid, forfeit, "under-minimum cancel");
} else if (mode === "recover") {
  // a season left locked and unseeded (here: created while the rollup still ran the previous program binary): refund its entrants, close it, reconcile the hub, release the bond
  const sid = BigInt(process.argv[3]); const st = L.loadStrats().slice(-Number(process.argv[4] || 3)); const entries = st.map(x => ({ o: x.owner, id: BigInt(x.id) })); const hub0 = await F.hubLamports(c);
  const before = []; for (const e of entries) before.push(await F.bal(c, e.o)); log("entrant ER balances before:", before.join(","), "hub", hub0);
  const cx = await L.sendTee(c.URL, [F.cancelIx(c, sid, c.players[4].publicKey, entries.map(e => e.id))], [O, c.players[4]]); check("Cancel by a stranger", ok(cx, "TEE Cancel"));
  { const cm = await F.claimAll(c, sid, log); log(F.claimsTable(cm.after)); }
  const after = []; for (const e of entries) after.push(await F.bal(c, e.o)); check("every entrant refunded exactly the 10 they paid", after.every((x, i) => x - before[i] === 10), `${before} -> ${after}`);
  ok(await L.sendTee(c.URL, [F.commitIx([L.receiptPda(sid)])], [O]), "TEE Commit receipt"); const a = await receiptBase(sid, a => a.data[4] === 2); const R = a && L.parseReceipt(a.data); log("receipt on base:", R ? `kind ${R.kind} reason ${R.reason} refunded ${R.refunded} state ${R.state} bond ${R.bond} rentDrawn ${R.rentDrawn}` : "none");
  await closeClaims(sid); const cl = await L.sendTee(c.URL, [F.cleanupIx(c, sid)], [O]); check("Cleanup", ok(cl, "TEE Cleanup")); const hub1 = await F.hubLamports(c); log(`hub ${hub0} -> ${hub1} (+${hub1 - hub0})`); check("the arena's rent returned to the hub", hub1 - hub0 > 300_000, `+${hub1 - hub0}`);
  await closeOut(sid, 0, "recovered season");
} else if (mode === "midsetup") {
  // a setup that dies after CreateSeason: receipt and arena exist, no pool, nobody entered. The creator cancels, anyone cleans up, the hub is whole and the creator forfeits 25% of the bond.
  const sid = BigInt(Date.now() % 1_000_000_000 + 10_000_000); log("season id", sid.toString()); const hubB = await F.hubLamports(c); log("SIG base InitReceipt:", (await F.initReceipt(c, sid)).join(" "));
  const cs = await F.createSeason(c, sid, { neps: 2, fee: 10, division: 2, window: 60_000, seedTimeout: 30_000 }); check("CreateSeason", ok(cs, "TEE CreateSeason")); const hubC = await F.hubLamports(c); log(`arena drew ${hubB - hubC} lamports from the hub (then the setup 'crashes' here)`);
  const cx = await L.sendTee(c.URL, [F.cancelIx(c, sid)], [O]); check("Cancel by the creator with no pool at all", ok(cx, "TEE Cancel"));
  await closeClaims(sid); const cl = await L.sendTee(c.URL, [F.cleanupIx(c, sid)], [O]); check("Cleanup", ok(cl, "TEE Cleanup")); const hubD = await F.hubLamports(c); const forfeit = F.BOND / 100 * 25;
  check("rent reclaimed: hub ends +25% bond forfeit over where it began", hubD - hubB === forfeit, `before ${hubB}, after ${hubD}, difference ${hubD - hubB}, expected ${forfeit}`);
  await closeOut(sid, forfeit, "mid-setup abandonment");
} else { console.error("mode: cancel | undermin | midsetup | recover <season>"); process.exit(2); }
log(`== ${mode}: ${checks.filter(Boolean).length}/${checks.length} checks passed | payer SOL ${await sol()}`); process.exit(checks.every(Boolean) ? 0 : 1);

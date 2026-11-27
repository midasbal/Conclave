// Phase 6 on devnet, after the upgrade (the first Seal is proof6_seal.mjs): the payer flag and the migration refunds, the public terms record and Enter's checks, a season end to end with the hub left whole, and the guards.
// Real program, real TEE, real signatures. Every amount below is read from the rollup (or base) before and after the one transaction it is attributed to.
//   P6_NEW=<id of a strategy already sealed by the new build> (default: the first-seal strategy in evidence/proof6_first_seal.json)  P6_OLD=<id of one sealed by the previous build>
import fs from "fs"; import path from "path"; import crypto from "crypto"; import { fileURLToPath } from "url";
const L = await import("./lib.mjs"); const F = await import("./flows.mjs"); const { O, K, ixp, u64 } = L; const here = path.dirname(fileURLToPath(import.meta.url));
const codes = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(here, "canary_codes.json"), "utf8"))).map(([k, v]) => [k, Buffer.from(v, "hex")]));
const log0 = L.logger(L.EV + "proof6_" + new Date().toISOString().replace(/[:.]/g, "-") + ".txt"); const log = (...a) => log0(...a);
const checks = []; const check = (name, ok, detail = "") => { checks.push({ name, ok: !!ok }); log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " | " + detail : ""}`); return !!ok; };
const lam = async (url, k) => (await L.rpc(url, "getAccountInfo", [k.toBase58(), { encoding: "base64" }])).result?.value?.lamports ?? null;
const code = e => { const m = JSON.stringify(e ?? "").match(/"Custom":(\d+)/); return m ? +m[1] : null; };
const passphrase = fs.readFileSync(path.join(L.KEYS, "bundle-passphrase.txt"), "utf8").trim(); const backup = { passphrase, acknowledgeDisclosure: true };
log(`== PHASE 6 LIVE PROOF ${new Date().toISOString()} program ${L.PROGRAM.toBase58()} (upgraded in slot 526779926)`);
const c = await F.ctx(); const ev = {}; const hubStart = await F.hubLamports(c); log("hub (rollup) at the start:", hubStart);
const NEWID = process.env.P6_NEW ?? JSON.parse(fs.readFileSync(L.EV + "proof6_first_seal.json", "utf8")).id;

// ---------- close one strategy and attribute the rent to the right account: every balance is read immediately before and after the single CloseStrategy transaction ----------
async function closeMeasured(label, id, ownerIdx) {
  const p = c.players[ownerIdx]; const { ticket } = await F.recoverBundle(c, ownerIdx, id, backup); const raw = (await L.readAcct(c.ptok[ownerIdx], L.stratPda(id))).readUInt16LE(6);
  const [h0, r0] = [await F.hubLamports(c), await lam(c.URL, L.regPda(id))]; const a = await L.sendTee(c.URL, [F.closeStrategyIx(c, p.publicKey, id, ticket)], [O, p]); const [h1, r1] = [await F.hubLamports(c), await lam(c.URL, L.regPda(id))];
  log(`${label}: strategy ${id} payer flag ${(raw & 0x8000) ? "SET" : "absent"}; SIG CloseStrategy ${a.sig} ${a.err ? "FAILED " + JSON.stringify(a.err) : "ok"}`); log(`  registry ${r0} -> ${r1} (${r1 - r0 >= 0 ? "+" : ""}${r1 - r0})   hub ${h0} -> ${h1} (${h1 - h0 >= 0 ? "+" : ""}${h1 - h0})`);
  // finish the retirement: undelegate the closed registry and shrink it on base, so the owner's deposit is returned
  let sigs = [a.sig]; if (!a.err) { const b = await L.sendTee(c.URL, [F.commitUndelegateIx([L.regPda(id)])], [O]); sigs.push(b.sig); for (let t = 0; t < 60; t++) { const acct = await L.base.getAccountInfo(L.regPda(id)); if (acct && acct.owner.equals(L.PROGRAM)) break; await L.sleep(1500); } sigs.push(await L.sendBase([F.closeRegistryIx(id, p.publicKey)], [O])); }
  return { err: a.err, flag: !!(raw & 0x8000), dReg: r1 - r0, dHub: h1 - h0, sigs }; }

// ---------- 1. the migration: a strategy sealed by the PREVIOUS build repays the HUB; one sealed by THIS build repays its REGISTRY ----------
log("\n---- MIGRATION: an old-build strategy (hub-funded) ----");
const OLD = process.env.P6_OLD ?? (() => { for (const r of L.loadStrats()) if (["6522180161511238013"].includes(r.id)) return r.id; })();
const oldRec = L.loadStrats().find(x => x.id === OLD); const oldRaw = (await L.readAcct(c.ptok[oldRec.owner], L.stratPda(BigInt(OLD)))).readUInt16LE(6); check("the strategy was sealed by the previous build: no payer flag, count 0", oldRaw === 0, `bytes 6..8 = 0x${oldRaw.toString(16)}`);
const mo = await closeMeasured("old", BigInt(OLD), oldRec.owner); check("old strategy: CloseStrategy succeeds", !mo.err); check("old strategy: the HUB is repaid exactly 20,000 and the registry is not touched", mo.dHub === 20_000 && mo.dReg === 0, `hub ${mo.dHub >= 0 ? "+" : ""}${mo.dHub}, registry ${mo.dReg}`); ev.oldClose = mo;

// ---------- 2. a season, end to end, with the public terms record ----------
log("\n---- SEASON: public terms, Enter's checks, the whole season, the hub ----");
const SID = BigInt(Date.now() % 1_000_000_000 + 8_000_000), SID2 = SID + 1n; const PARAMS = { neps: 3, spt: 1, fee: 10, maxs: 20, finals: false, division: 2, window: 20_000, seedTimeout: 6_000, minEntrants: 1 };
const rawFlag = async (o, id) => (await L.readAcct(c.ptok[o], L.stratPda(BigInt(id))))?.readUInt16LE(6);
// two more strategies of this build, so the field has three
const entries = [{ o: 0, id: BigInt(NEWID), name: "first-seal", fresh: false }]; for (const [o, n] of [[1, "EMAcross"], [2, "SwitchTwo"]]) { const r = await F.register(c, o, "p6-" + n, codes[n]); for (let i = 0; i < 60 && !(await L.readAcct(c.URL, L.regPda(r.id))); i++) await L.sleep(700);
  const s = await F.seal(c, o, r.id, r.salt, codes[n], false); log(`SIG Seal ${n} (owner ${o}): ${s.sig} ${s.err ? "FAILED " + JSON.stringify(s.err) : "ok"}`); entries.push({ o, id: r.id, name: n, fresh: true }); }
check("all three strategies carry the payer flag after sealing", (await Promise.all(entries.map(e => rawFlag(e.o, e.id)))).every(x => x === 0x8000), (await Promise.all(entries.map(e => rawFlag(e.o, e.id)))).map(x => "0x" + x.toString(16)).join(" "));
for (const e of entries) { if ((await F.bal(c, e.o)) < PARAMS.fee) await F.fundStake(c, { [e.o]: PARAMS.fee }, log); }
const hub0 = await F.hubLamports(c); for (const s of [SID, SID2]) { const r = await F.initReceipt(c, s); log(`SIG InitReceipt+Delegate season ${s}: ${r.join(" ")}`); const p = await F.initPool(c, s); log(`SIG InitPool season ${s}: ${p}`); }
const cs = await F.createSeason(c, SID, PARAMS); check("CreateSeason (with the terms account)", !cs.err, `${cs.sig}${cs.err ? " " + JSON.stringify(cs.err) : ""}`); const cs2 = await F.createSeason(c, SID2, { ...PARAMS, fee: 777 }); check("CreateSeason of a second season, whose terms record is the 'stale' one below", !cs2.err, `${cs2.sig}${cs2.err ? " " + JSON.stringify(cs2.err) : ""}`);
// the record is PUBLIC: read it with no token at all
const anon = L.parseTerms(await L.readAcct(L.TEE, L.termsPda(SID))); check("the terms record is readable with NO token", !!anon);
if (anon) { check("it states exactly what the creator asked for", anon.fee === 10n && anon.episodes === 3 && anon.slotsPerTick === 1 && anon.entryWindowSlots === 20000n && anon.seedTimeoutSlots === 6000n && anon.seats === 20 && anon.minEntrants === 1 && anon.finals === false && anon.division === 2 && anon.season === SID && new L.PublicKey(anon.mint).equals(c.mint) && new L.PublicKey(anon.creator).equals(O.publicKey), JSON.stringify({ fee: anon.fee.toString(), episodes: anon.episodes, window: anon.entryWindowSlots.toString(), seats: anon.seats, mint: new L.PublicKey(anon.mint).toBase58(), creator: new L.PublicKey(anon.creator).toBase58(), hubRent: anon.hubRent.toString(), hash: anon.hash.toString("hex") }));
  check("the hub paid 7,808 lamports for it, recorded on the record", anon.hubRent === 7808n); }
const rawRec = await L.readAcct(L.TEE, L.termsPda(SID)); const arenaRaw = await L.readAcct(L.TEE, L.arenaPda(SID)); check("the arena itself is NOT readable without a token (only the terms are public)", arenaRaw === null);
await F.awaitPoolReady(c, SID, 0, entries[0].id); const good = await F.termsExpect(c, SID); const e0 = entries[0]; const p0 = c.players[e0.o]; const send = ix => L.sendTee(c.ptok[e0.o], [ix], [p0]);
const refusal = async (what, ix, want) => { const r = await send(ix); check(`Enter refused: ${what} (${want})`, code(r.err) === want, `SIG ${r.sig} ${JSON.stringify(r.err ?? "ACCEPTED")}`); return r; };
const bal0 = await F.bal(c, e0.o); const flip = Buffer.from(good.hash); flip[31] ^= 1;
await refusal("a fee other than the record's", F.enterIx(c, SID, e0.o, e0.id, false, { ...good, fee: good.fee + 1n }), 9151);
await refusal("a fee of zero", F.enterIx(c, SID, e0.o, e0.id, false, { ...good, fee: 0n }), 9151);
await refusal("another stake mint", F.enterIx(c, SID, e0.o, e0.id, false, { ...good, mint: crypto.randomBytes(32) }), 9151);
await refusal("a hash with one bit flipped", F.enterIx(c, SID, e0.o, e0.id, false, { ...good, hash: flip }), 9151);
const stale = await F.termsExpect(c, SID2); { const ix = F.enterIx(c, SID, e0.o, e0.id, false, stale); ix.keys[9] = K(L.termsPda(SID2)); await refusal("another season's (stale) terms record, with the fee and hash that record carries", ix, 9150); }
{ const ix = F.enterIx(c, SID, e0.o, e0.id, false, good); ix.keys[9] = K(L.arenaPda(SID)); await refusal("an account that is not a terms record in its place", ix, 9150); }
{ const ix = F.enterIx(c, SID, e0.o, e0.id, false, good); ix.data = Buffer.alloc(0); const r = await send(ix); check("Enter refused: the previous build's Enter (no data)", !!r.err && code(r.err) !== null || !!r.err, `SIG ${r.sig} ${JSON.stringify(r.err ?? "ACCEPTED")}`); }
check("none of those moved a token or took a seat", (await F.bal(c, e0.o)) === bal0 && (await L.readAcct(c.ptok[e0.o], L.stratPda(e0.id))).readUInt16LE(6) === 0x8000, `entrant balance ${bal0} -> ${await F.bal(c, e0.o)}`);
const before = await Promise.all(entries.map(e => F.bal(c, e.o))); const en = await F.enter(c, SID, entries.map(e => [e.o, e.id]), log); check("an entrant that read the terms and sends the matching fee, mint and hash enters (all three)", en.every(r => !r.err));
const after = await Promise.all(entries.map(e => F.bal(c, e.o))); check("each paid exactly the recorded fee", after.every((x, i) => before[i] - x === 10), `${before} -> ${after}`);
check("the payer flag survives an entry: the open-entry count rises to 1 beside it (0x8001)", (await Promise.all(entries.map(e => rawFlag(e.o, e.id)))).every(x => x === 0x8001), (await Promise.all(entries.map(e => rawFlag(e.o, e.id)))).map(x => "0x" + x.toString(16)).join(" "));
{ const r = await send(F.enterIx(c, SID, e0.o, e0.id, false, good)); check("a second entry of the same strategy is refused", !!r.err, JSON.stringify(r.err ?? "ACCEPTED")); }
// run the season
const lock = await L.sendTee(c.URL, [F.lockIx(SID)], [O]); check("Lock", !lock.err, lock.sig); const seed = await L.sendTee(c.URL, [F.seedIx(SID)], [O]); check("RequestSeed (VRF)", !seed.err, seed.sig); const run = await F.runSeason(c, SID, { log }); check("the season runs with no compute failures", run.season.ok > 0 && run.season.fail === 0, `${run.season.ok} Advance txs`);
const settle = await L.sendTee(c.URL, [F.settleIx(c, SID)], [O]); check("Settle", !settle.err, `${settle.sig}${settle.err ? " " + JSON.stringify(settle.err) : ""}`); const cm = await F.claimAll(c, SID, log); check("every claim paid", cm.results.every(r => !r.err) && cm.after.claimed === cm.after.owed, `owed ${cm.after.owed} claimed ${cm.after.claimed}`);
let pubOk = true; for (let i = 0; i < entries.length; i++) { const r = await L.sendTee(c.URL, [F.publishIx(SID, i, entries[i].id)], [O]); log(`SIG Publish ${i}: ${r.sig} ${r.err ? "FAILED " + JSON.stringify(r.err) : "ok"}`); if (r.err) pubOk = false; } check("Publish all", pubOk);
check("after the publishes the count is back to 0 and the payer flag is still set (0x8000)", (await Promise.all(entries.map(e => rawFlag(e.o, e.id)))).every(x => x === 0x8000), (await Promise.all(entries.map(e => rawFlag(e.o, e.id)))).map(x => "0x" + x.toString(16)).join(" "));
const termsBeforeClose = await L.readAcct(L.TEE, L.termsPda(SID)); const cc = await L.sendTee(c.URL, [F.closeClaimsIx(c, SID)], [O]); check("CloseClaims", !cc.err, `${cc.sig}${cc.err ? " " + JSON.stringify(cc.err) : ""}`);
check("the terms record closed with the claims account", !!termsBeforeClose && (await L.readAcct(L.TEE, L.termsPda(SID))) === null && (await L.readAcct(c.URL, L.claimsPda(SID))) === null);
const cl = await L.sendTee(c.URL, [F.cleanupIx(c, SID)], [O]); check("Cleanup", !cl.err, `${cl.sig}${cl.err ? " " + JSON.stringify(cl.err) : ""}`);
// the second season: abandoned by its creator (25% of the bond to the hub), wound up completely
const can = await L.sendTee(c.URL, [F.cancelIx(c, SID2)], [O]); check("Cancel of the second season", !can.err, can.sig); const cc2 = await L.sendTee(c.URL, [F.closeClaimsIx(c, SID2)], [O]); check("CloseClaims of the second season closes its terms record too", !cc2.err && (await L.readAcct(L.TEE, L.termsPda(SID2))) === null, `${cc2.sig}${cc2.err ? " " + JSON.stringify(cc2.err) : ""}`); const cl2 = await L.sendTee(c.URL, [F.cleanupIx(c, SID2)], [O]); check("Cleanup of the second season", !cl2.err, cl2.sig);
const hub1 = await F.hubLamports(c); check("the hub is whole: exactly what it held before the seasons, plus the 25% forfeit of the one abandoned season's 2,000,000 bond", hub1 === hub0 + 500_000, `${hub0} -> ${hub1} (${hub1 - hub0})`);
for (const s of [SID, SID2]) { const cu = await L.sendTee(c.URL, [F.commitUndelegateIx([L.receiptPda(s)])], [O]); let acc = null; for (let t = 0; t < 60; t++) { acc = await L.base.getAccountInfo(L.receiptPda(s)); if (acc && acc.owner.equals(L.PROGRAM) && acc.data[144] === 2) break; await L.sleep(1500); } if (acc) { const l0 = acc.lamports; const rel = await L.sendBase([F.releaseBondIx(s, O.publicKey)], [O]); const R = L.parseReceiptMoney(acc.data); log(`SIG ReleaseBond season ${s}: ${rel} (receipt held ${l0}, forfeit ${R.forfeit ?? "?"})`); } }

// ---------- 3. the migration, new build: its REGISTRY is repaid, the hub is untouched ----------
log("\n---- MIGRATION: a new-build strategy (registry-funded) ----");
const mn = await closeMeasured("new", entries[0].id, entries[0].o); check("new strategy: CloseStrategy succeeds", !mn.err); check("new strategy: the REGISTRY is repaid exactly 20,000 and the hub is not touched", mn.flag && mn.dReg === 20_000 && mn.dHub === 0, `registry ${mn.dReg >= 0 ? "+" : ""}${mn.dReg}, hub ${mn.dHub}`); ev.newClose = mn;
for (const e of entries.slice(1)) { const m = await closeMeasured("new", e.id, e.o); check(`new strategy ${e.name}: registry repaid 20,000, hub untouched`, !m.err && m.dReg === 20_000 && m.dHub === 0, `registry ${m.dReg}, hub ${m.dHub}`); }

// ---------- 4. guards ----------
log("\n---- GUARDS ----");
{ const o = 3; const id = L.newId(); const salt = crypto.randomBytes(32); const cd = codes.Mom20th; const commit = L.codeCommit(salt, cd); L.addStrat({ id: id.toString(), owner: o, name: "p6-undelegated", salt: salt.toString("hex"), code: cd.toString("hex") });
  const owner = c.players[o]; const s1 = await L.sendBase([ixp(1, [K(owner.publicKey, true, true), K(L.regPda(id), true), K(L.SystemProgram.programId)], Buffer.concat([u64(id), commit]))], [O, owner]); log(`SIG Register (and NOT delegated) strategy ${id}: ${s1}`);
  const s = L.stratPda(id); const mk = reg => ixp(3, [K(owner.publicKey, false, true), K(s, true), K(L.permissionPdaFromAccount(s), true), K(L.EPHEMERAL_VAULT_ID, true), K(L.MAGIC), K(L.PERMISSION_PROGRAM_ID), reg], Buffer.concat([u64(id), salt, cd]));
  const ro = await L.sendTee(c.URL, [mk(K(L.regPda(id), false))], [O, owner]); check("Seal with an undelegated registry passed read-only: refused by the program (9133)", code(ro.err) === 9133, `SIG ${ro.sig} ${JSON.stringify(ro.err ?? "ACCEPTED")}`);
  const rw = await L.sendTee(c.URL, [mk(K(L.regPda(id), true))], [O, owner]); check("Seal with an undelegated registry passed writable: refused by the rollup itself, before the program runs", !!rw.err && code(rw.err) === null, `SIG ${rw.sig} ${JSON.stringify(rw.err ?? "ACCEPTED")}`);
  check("nothing was created: no sealed account, the registry is where it was", (await L.readAcct(c.ptok[o], s)) === null);
  // then do what the owner should: delegate, seal, and retire it, so the registry deposit is not stranded
  const d = await L.sendBase([ixp(2, [K(owner.publicKey, true, true), K(L.SystemProgram.programId), K(L.regPda(id), true), K(L.PROGRAM), K(L.delegAccts(L.regPda(id)).buffer, true), K(L.delegAccts(L.regPda(id)).record, true), K(L.delegAccts(L.regPda(id)).meta, true), K(L.DLP), K(c.validator)], Buffer.concat([Buffer.from([1]), u64(id)]))], [O, owner]); log(`SIG Delegate the registry: ${d}`);
  for (let i = 0; i < 60 && !(await L.readAcct(c.URL, L.regPda(id))); i++) await L.sleep(700); const sl = await F.seal(c, o, id, salt, cd, false); check("the same strategy seals once its registry is delegated", !sl.err, `${sl.sig}${sl.err ? " " + JSON.stringify(sl.err) : ""}`);
  const m = await closeMeasured("guard", id, o); check("and retires: registry repaid 20,000, hub untouched", !m.err && m.dReg === 20_000 && m.dHub === 0); }
const bad = checks.filter(x => !x.ok); log(`\n== PHASE 6 LIVE PROOF ${bad.length ? "FAILED: " + bad.map(x => x.name).join("; ") : "PASSED"} (${checks.length - bad.length}/${checks.length} checks)`); fs.writeFileSync(L.EV + "proof6_summary.json", JSON.stringify({ checks, hubStart, hubEnd: await F.hubLamports(c), sid: SID.toString(), sid2: SID2.toString() }, (k, v) => typeof v === "bigint" ? v.toString() : v, 1)); process.exit(bad.length ? 1 : 0);

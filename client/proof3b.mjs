// Devnet proof of strategy reclaim and the two guards, real signatures through the TEE, real stake tokens. Every transaction signature is written to evidence/proof3b_<mode>.txt.
//   node client/proof3b.mjs reclaim   fresh sealed strategies through a paid finals season: the open-entry count rises, CloseStrategy is refused (9130) while anything is open, publish brings it to zero, every strategy closes, the hub is whole and each registry balance returns to its owner
//   node client/proof3b.mjs cancel    a paid season whose seed never arrives: Cancel, Cleanup refused (9131) until the strategies are passed, then the strategies close
//   node client/proof3b.mjs compat    two strategies sealed by earlier builds still enter and close; a strategy whose registry was never delegated is refused at Enter (and works once delegated); the minimum grace is enforced at creation
// Salts, code and unsalted code hashes are never logged.
import * as L from "./lib.mjs"; import * as F from "./flows.mjs"; import * as Art from "./artifact.mjs"; import { load } from "./author.mjs";
import fs from "fs"; import path from "path"; import { fileURLToPath } from "url"; import crypto from "crypto"; import { passphraseFromFile } from "./custody.mjs";
const here = path.dirname(fileURLToPath(import.meta.url)); const { O, K, ixp, u64 } = L; const mode = process.argv[2];
if (!["reclaim", "cancel", "compat"].includes(mode)) { console.error("mode: reclaim | cancel | compat"); process.exit(2); }
const log = L.logger(L.EV + `proof3b_${mode}.txt`); const checks = []; const check = (name, ok, detail = "") => { checks.push(!!ok); log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " | " + detail : ""}`); return !!ok; };
const A = await load(); const c = await F.ctx(); const FEE = 10;
const sol = async k => (await L.base.getBalance(k)) / 1e9; const lam = async k => L.base.getBalance(k);
const finish = async () => { log(`== ${mode}: ${checks.filter(Boolean).length}/${checks.length} checks passed | payer ${await sol(O.publicKey)} SOL`); process.exit(checks.every(Boolean) ? 0 : 1); };
const tee = async (label, ix, signers = [O], opts) => { const r = await L.sendTee(c.URL, [ix], signers, opts); log(`SIG TEE ${label}: ${r.sig} ${r.err ? "FAILED " + JSON.stringify(r.err) : "ok"}`); return r; };
const must = (r, what) => { if (r.err) { check(what, false, JSON.stringify(r.err)); log("stopping: a required step failed"); process.exit(1); } return r; };
const refused = (r, code, what) => check(`${what} is refused (${code})`, !!r.err && JSON.stringify(r.err).includes(String(code)), JSON.stringify(r.err || "ACCEPTED"));
const slotNow = async () => (await L.rpc(c.URL, "getSlot")).result; const waitSlot = async n => { while ((await slotNow()) < n) await L.sleep(500); };
const balances = async () => { const o = []; for (let i = 0; i < 5; i++) o.push(await F.bal(c, i)); return o; }; const sum = a => a.reduce((x, y) => x + y, 0);
const hub = () => F.hubLamports(c);
const sealedAcct = e => L.readAcct(c.ptok[e.owner], L.stratPda(e.id));
const openCount = async e => { const d = await sealedAcct(e); return d ? d.readUInt16LE(6) : null; };
const counts = async f => { const o = []; for (const e of f) o.push(await openCount(e)); return o; };
const newSid = off => BigInt(Date.now() % 1_000_000_000 + off);
log(`\n== PROOF 3b ${mode} ${new Date().toISOString()} program ${L.PROGRAM.toBase58()} validator ${c.validator.toBase58()} payer ${await sol(O.publicKey)} SOL`);

async function topUp(owner) { const p = c.players[owner]; if ((await lam(p.publicKey)) < 60_000_000) { const t = new L.Transaction().add(L.SystemProgram.transfer({ fromPubkey: O.publicKey, toPubkey: p.publicKey, lamports: 60_000_000 })); t.feePayer = O.publicKey; log("SIG base top up player", owner, await L.sendAndConfirmTransaction(L.base, t, [O])); } }
async function fund(owners) { const need = {}; for (const o of owners) need[o] = (need[o] || 0) + FEE;
  for (const [o, n] of Object.entries(need)) { const have = await F.bal(c, +o); if (have >= n) continue; const all = await balances(); const from = all.indexOf(Math.max(...all)); const amt = n - have + FEE; const d = Buffer.alloc(9); d[0] = 3; d.writeBigUInt64LE(BigInt(amt), 1);
    must(await tee(`move ${amt} stake tokens from player ${from} to player ${o}`, new L.TransactionInstruction({ programId: L.TOKEN, keys: [K(c.ata(c.players[from].publicKey), true), K(c.ata(c.players[+o].publicKey), true), K(c.players[from].publicKey, false, true)], data: d }), [O, c.players[from]]), "fund a player"); } }
/** register (and delegate) and seal fresh authored strategies; records what the owner put into each registry */
async function sealField(spec) { const field = [];
  for (const [name, owner] of spec) { const art = Art.buildArtifact(fs.readFileSync(path.join(here, "..", "strategies", name + ".cvs"), "utf8"), A); await topUp(owner);
    const reg = await F.register(c, owner, art.name, art.code, Art.artifactMeta(art)); log(`SIG base Register ${name} (strategy ${reg.id}, owner ${owner}): ${reg.sigs[0]} | delegate: ${reg.sigs[1]}`);
    const t = await L.base.getTransaction(reg.sigs[0], { maxSupportedTransactionVersion: 0, commitment: "confirmed" }); const keys = t.transaction.message.staticAccountKeys ?? t.transaction.message.accountKeys; const at = keys.findIndex(k => k.equals(L.regPda(reg.id))); const regPaid = t.meta.postBalances[at] - t.meta.preBalances[at];
    const s = await F.seal(c, owner, reg.id, reg.salt, art.code); log(`SIG TEE Seal ${name}: ${s.sig} ${s.err ? JSON.stringify(s.err) : "ok"}`); must(s, "Seal");
    field.push({ name, owner, id: reg.id, salt: reg.salt, code: art.code, regPaid }); } return field; }
async function openSeason(sid, params, { poolFirst = true } = {}) {
  if (poolFirst) { const rc = await F.initReceipt(c, sid); log(`SIG base InitReceipt: ${rc[0]} | delegate: ${rc[1]}`); log(`SIG base InitPool: ${await F.initPool(c, sid)}`); }
  const cs = await F.createSeason(c, sid, params); log(`SIG TEE CreateSeason (${params.neps} episodes, fee ${params.fee}${params.finals ? ", finals on" : ""}, grace ${params.grace ?? F.MIN_GRACE}): ${cs.sig} ${cs.err ? JSON.stringify(cs.err) : "ok"}`); must(cs, "CreateSeason"); }
async function enterAll(sid, field) { log(`pool token account usable after ${(await F.awaitPoolReady(c, sid, field[0].owner, field[0].id)).toFixed(1)}s`); const en = await F.enter(c, sid, field.map(e => [e.owner, e.id]), log); if (!check(`${field.length} sealed entrants entered`, en.every(r => !r.err), JSON.stringify(en.filter(r => r.err).map(r => r.err)))) process.exit(1); }
// the client builds CloseStrategy only from a verified recovery bundle
const ticketFor = async e => (await F.recoverBundle(c, e.owner, e.id, { passphrase: passphraseFromFile(process.env.CONCLAVE_BUNDLE_PASSPHRASE_FILE || path.join(L.KEYS, "bundle-passphrase.txt")) })).ticket;
const closeAttempt = async (e, when) => { const before = await sealedAcct(e); const h = await hub(); const r = await tee(`CloseStrategy ${e.name} (${when}; probe)`, F.closeStrategyIx(c, c.players[e.owner].publicKey, e.id, await ticketFor(e)), [O, c.players[e.owner]]); refused(r, 9130, `closing ${e.name} ${when}`); const after = await sealedAcct(e); check(`  and nothing changed: the sealed account is intact and the hub did not move`, !!after && after.equals(before) && (await hub()) === h); };
async function driveToEnd(sid, label) { const d = await F.drive(c, sid, { log }); log(`Advance (${label}): ${d.ok} txs, ${d.fail} failures, ${d.wall.toFixed(0)}s`); for (const s of d.sigs) log("SIG TEE Advance:", s); check(`${label} ran to completion`, d.ok > 0 && d.fail === 0); }
async function claimsAndCloseClaims(sid, paidIn, before) { const cm = await F.claimAll(c, sid, log); log(F.claimsTable(cm.after)); check("every claim succeeded and nothing is outstanding", cm.results.every(r => !r.err) && cm.after.claimed === cm.after.owed && cm.after.owed === BigInt(paidIn), `owed ${cm.after.owed} claimed ${cm.after.claimed}, paid in ${paidIn}`);
  const now = await balances(); check("entries in = claims out: the owners' token total is what it was before entering", sum(now) === sum(before), `${before} -> ${now}`); must(await tee("CloseClaims", F.closeClaimsIx(c, sid)), "CloseClaims"); return cm; }
async function commitReceiptAndRegs(sid, field) { const regs = field.map(e => L.regPda(e.id)); for (let i = 0; i < regs.length; i += 4) must(await tee("Commit receipt + registries to base", F.commitIx([...(i === 0 ? [L.receiptPda(sid)] : []), ...regs.slice(i, i + 4)])), "Commit"); }
async function releaseBond(sid) { must(await tee("Commit+undelegate the closed receipt", F.commitUndelegateIx([L.receiptPda(sid)])), "undelegate receipt");
  let a; for (let t = 0; t < 60; t++) { a = await L.base.getAccountInfo(L.receiptPda(sid)); if (a && a.owner.equals(L.PROGRAM) && a.data[144] === 2) break; await L.sleep(1500); }
  const RR = L.parseReceipt(a.data); const l0 = a.lamports; const rel = await L.sendBase([F.releaseBondIx(sid, O.publicKey)], [O]); const l1 = await lam(L.receiptPda(sid)); log(`SIG base ReleaseBond: ${rel}`);
  check("the creator bond is released in full, nothing forfeited, arena rent drawn equals reclaimed", BigInt(l0 - l1) === RR.release && RR.release === RR.bond && RR.forfeit === 0n && RR.rentDrawn === RR.rentReclaimed, `bond ${RR.bond} released ${l0 - l1} drawn ${RR.rentDrawn} reclaimed ${RR.rentReclaimed}`); }
/** the whole retirement of one strategy, step by step, with the money measured at each step */
async function retire(e, rent) {
  const ticket = await ticketFor(e); const h0 = await hub(); const cl = await tee(`CloseStrategy ${e.name}`, F.closeStrategyIx(c, c.players[e.owner].publicKey, e.id, ticket), [O, c.players[e.owner]]); must(cl, `CloseStrategy ${e.name}`); const h1 = await hub();
  check(`${e.name}: the sealed account's rent returned to the hub, exactly ${rent}`, h1 - h0 === rent, `hub ${h0} -> ${h1} (+${h1 - h0})`); check(`${e.name}: the sealed account is gone, even for its owner`, (await sealedAcct(e)) === null);
  must(await tee(`Commit+undelegate the closed registry ${e.name}`, F.commitUndelegateIx([L.regPda(e.id)])), "undelegate registry");
  let a; for (let t = 0; t < 60; t++) { a = await L.base.getAccountInfo(L.regPda(e.id)); if (a && a.owner.equals(L.PROGRAM)) break; await L.sleep(1500); } if (!check(`${e.name}: the registry is back on base`, !!a && a.owner.equals(L.PROGRAM))) return;
  const owner = c.players[e.owner].publicKey; const o0 = await lam(owner); const held = a.lamports; const sig = await L.sendBase([F.closeRegistryIx(e.id, owner)], [O]); log(`SIG base CloseRegistry ${e.name}: ${sig}`); const o1 = await lam(owner); let gone; for (let t = 0; t < 20; t++) { gone = await L.base.getAccountInfo(L.regPda(e.id)); if (!gone) break; await L.sleep(1000); }
  check(`${e.name}: the registry's whole balance returned to its owner and the account is gone`, o1 - o0 === held && !gone, `held ${held}, owner +${o1 - o0}${e.regPaid ? `, paid at Register ${e.regPaid}` : ""}`);
  if (e.regPaid) check(`${e.name}: that is exactly what the owner put in at Register`, held === e.regPaid, `${held} vs ${e.regPaid}`); }
async function graceProbes(sid) { const rc = await F.initReceipt(c, sid); log(`SIG base InitReceipt: ${rc[0]} | delegate: ${rc[1]}`); log(`SIG base InitPool: ${await F.initPool(c, sid)}`);
  for (const grace of [1, 600, F.MIN_GRACE - 1]) { const h = await hub(); const r = await F.createSeason(c, sid, { neps: 2, fee: FEE, division: 2, window: 60_000, seedTimeout: 60_000, grace }); log(`SIG TEE CreateSeason with grace ${grace} (probe): ${r.sig} ${r.err ? "FAILED " + JSON.stringify(r.err) : "ok"}`); refused(r, 9105, `a season with a publish grace of ${grace} slots`); check("  and the hub paid nothing", (await hub()) === h); } }

if (mode === "reclaim") {
  const sid = newSid(21_000_000); const spec = [["momentum", 0], ["ema_cross", 1], ["mean_reversion", 2], ["trend_stop", 3]]; await fund(spec.map(s => s[1]));
  const H0 = await hub(); log(`season ${sid}; hub before anything: ${H0}`);
  const field = await sealField(spec); const H1 = await hub(); check("the hub paid each sealed strategy's rent: 20,000 each", H0 - H1 === 20_000 * field.length, `${H0} -> ${H1}`);
  check("a fresh sealed strategy has no open entry", (await counts(field)).every(n => n === 0), `${await counts(field)}`);
  await openSeason(sid, { neps: 15, fee: FEE, finals: true, division: 2, window: 60_000, seedTimeout: 60_000, minEntrants: field.length }); const before = await balances();
  await enterAll(sid, field); check("every strategy's open-entry count rose to 1", (await counts(field)).every(n => n === 1), `${await counts(field)}`); check(`entries in: ${FEE} x ${field.length}`, sum(before) - sum(await balances()) === FEE * field.length);
  await closeAttempt(field[0], "right after Enter");
  must(await tee("Lock", F.lockIx(sid)), "Lock"); must(await tee("RequestSeed (season)", F.seedIx(sid)), "RequestSeed"); await driveToEnd(sid, "the season phase");
  must(await tee("RequestSeed (finals)", F.seedIx(sid)), "finals RequestSeed"); await driveToEnd(sid, "the finals phase");
  await closeAttempt(field[1], "after the run, before Settle");
  must(await tee("Settle, publishing only entries 0 and 1 inline", F.settleIx(c, sid, field.slice(0, 2).map(e => e.id))), "Settle");
  { const n = await counts(field); check("the two published entries are at 0, the two unpublished still at 1", n.join() === "0,0,1,1", `${n}`); }
  await closeAttempt(field[2], "settled but unpublished");
  refused(await tee("Cleanup inside the grace, naming the unpublished strategies (probe)", F.cleanupIx(c, sid, field.slice(2).map(e => e.id))), 9123, "destroying the arena inside the grace");
  for (const i of [2, 3]) must(await tee(`Publish entry ${i} (${field[i].name})`, F.publishIx(sid, i, field[i].id)), "Publish");
  check("after every entry is published every count is 0", (await counts(field)).every(n => n === 0), `${await counts(field)}`);
  await commitReceiptAndRegs(sid, field); const raw = await F.readReceiptBase(sid, field.length); check("the receipt is on base with every entry published", !!raw); const R = raw && L.parseReceipt(raw); if (R) log("receipt ranks (final / season):", R.entries.map(e => `${e.rank}/${e.seasonRank}`).join(" "), "finals status", R.finals.status);
  await claimsAndCloseClaims(sid, FEE * field.length, before); must(await tee("Cleanup (names no strategy: none is held)", F.cleanupIx(c, sid)), "Cleanup"); await releaseBond(sid);
  const H2 = await hub(); check("with the season closed, only the four sealed strategies still hold hub rent", H0 - H2 === 20_000 * field.length, `${H0} -> ${H2}`);
  for (const e of field) await retire(e, 20_000);
  const H3 = await hub(); check("THE HUB IS WHOLE: it holds exactly what it held before the first strategy was sealed", H3 === H0, `before ${H0}, after ${H3}`);
  { const rb = await L.base.getAccountInfo(L.receiptPda(sid)); const RR = L.parseReceipt(rb.data); check("the season receipt on base still records every entry's id and rank after the strategies are gone", RR.entries.length === field.length && RR.entries.every((x, i) => x.id === field[i].id && x.rank >= 1)); }
  await finish();
}

if (mode === "cancel") {
  const sid = newSid(22_000_000); const spec = [["calm_trend", 0], ["quick_fade", 1], ["momentum", 2]]; await fund(spec.map(s => s[1]));
  const H0 = await hub(); log(`season ${sid}; hub before anything: ${H0}`); const field = await sealField(spec);
  await openSeason(sid, { neps: 2, fee: FEE, division: 2, window: 60_000, seedTimeout: 900, minEntrants: 1 }); const before = await balances(); await enterAll(sid, field); check("every count rose to 1", (await counts(field)).every(n => n === 1), `${await counts(field)}`);
  must(await tee("Lock (the seed is deliberately never requested)", F.lockIx(sid)), "Lock"); const locked = await slotNow(); await waitSlot(locked + 1000);
  const stranger = c.players[4]; must(await tee("Cancel after the seed timeout, signed by an outsider, naming NO strategy", F.cancelIx(c, sid, stranger.publicKey), [O, stranger]), "Cancel");
  check("Cancel refunds without naming strategies, and leaves every count at 1", (await counts(field)).every(n => n === 1), `${await counts(field)}`);
  await closeAttempt(field[0], "in a cancelled season that has not released it");
  await claimsAndCloseClaims(sid, FEE * field.length, before); { const now = await balances(); check("every owner got back exactly what it paid", now.join() === before.join(), `${before} -> ${now}`); }
  const asStranger = ix => { ix.keys[0] = K(stranger.publicKey, false, true); return ix; };
  refused(await tee("Cleanup naming no strategy (probe)", F.cleanupIx(c, sid)), 9131, "Cleanup with no strategy passed");
  refused(await tee("Cleanup naming two of the three (probe)", F.cleanupIx(c, sid, field.slice(0, 2).map(e => e.id))), 9131, "Cleanup with one held strategy missing");
  check("a refused Cleanup releases nothing", (await counts(field)).every(n => n === 1), `${await counts(field)}`);
  must(await tee("Cleanup naming all three, signed by an outsider who owns none of them", asStranger(F.cleanupIx(c, sid, field.map(e => e.id))), [O, stranger]), "Cleanup");
  check("Cleanup released every count to 0", (await counts(field)).every(n => n === 0), `${await counts(field)}`);
  await releaseBond(sid); for (const e of field) await retire(e, 20_000);
  const H1 = await hub(); check("the hub is whole after the cancelled season and the closes", H1 === H0, `before ${H0}, after ${H1}`); await finish();
}

if (mode === "compat") {
  const H0 = await hub(); log(`hub before anything: ${H0}`);
  // ---- strategies sealed by earlier builds: one 404-byte from the build deployed before this one, one 396-byte from an older build
  const stored = L.loadStrats(); const read = async x => L.readAcct(c.ptok[x.owner], L.stratPda(BigInt(x.id))); const asEntry = (x, name) => ({ name, owner: x.owner, id: BigInt(x.id), old: true });
  const r404 = stored.find(x => x.id === "5116188822909309413"); const d404 = r404 && await read(r404);
  const keep = new Set(JSON.parse(fs.readFileSync(path.join(here, "last_v2_entries.json"))).ids); // pins.mjs enters those: never close one of them
  let r396, d396, tries = 0; for (const x of stored) { if (tries >= 25) break; if (x.owner === undefined || x.owner === r404.owner || keep.has(x.id)) continue; tries++; const d = await read(x); await L.sleep(250); if (d && d.length === 396 && d.readUInt32LE(0) === 0x53545254 && d[136] === 2) { r396 = x; d396 = d; break; } }
  if (!check("a 404-byte strategy sealed by the previous build and a 396-byte one sealed by an older build are both still in the rollup", !!d404 && d404.length === 404 && !!d396, `404: ${r404?.id} (${d404?.length} bytes), 396: ${r396?.id} (${d396?.length} bytes)`)) process.exit(1);
  const olds = [asEntry(r404, "old404"), asEntry(r396, "old396")];
  check("both read an open-entry count of 0 (bytes 6 and 7 were never written)", (await counts(olds)).every(n => n === 0), `${await counts(olds)}`);
  await fund(olds.map(e => e.owner).concat([3]));
  // ---- the minimum grace at creation
  const sid = newSid(23_000_000); await graceProbes(sid);
  await openSeason(sid, { neps: 2, fee: FEE, division: 2, window: 150_000, seedTimeout: 60_000, grace: F.MIN_GRACE, minEntrants: 1 }, { poolFirst: false }); check(`the floor itself, ${F.MIN_GRACE} slots, is accepted`, true);
  const before = await balances(); await enterAll(sid, olds); check("each old strategy now counts its open entry", (await counts(olds)).every(n => n === 1), `${await counts(olds)}`); await closeAttempt(olds[1], "(old 396-byte) while entered");
  // ---- a registry that was never delegated
  const ownerIdx = 3; const owner = c.players[ownerIdx]; await topUp(ownerIdx); const art = Art.buildArtifact(fs.readFileSync(path.join(here, "..", "strategies", "calm_trend.cvs"), "utf8"), A);
  const id = L.newId(); const salt = crypto.randomBytes(32); L.addStrat({ id: id.toString(), owner: ownerIdx, name: art.name, salt: salt.toString("hex"), code: art.code.toString("hex"), ...Art.artifactMeta(art) });
  const regSig = await L.sendBase([ixp(1, [K(owner.publicKey, true, true), K(L.regPda(id), true), K(L.SystemProgram.programId)], Buffer.concat([u64(id), L.codeCommit(salt, art.code)]))], [O, owner]); log(`SIG base Register WITHOUT delegating (strategy ${id}, owner ${ownerIdx}): ${regSig}`);
  const regPaid = await lam(L.regPda(id)); const loose = { name: "undelegated", owner: ownerIdx, id, regPaid };
  const hs = await hub(); let seal; for (let t = 0; t < 30; t++) { if (await L.readAcct(c.URL, L.regPda(id))) break; await L.sleep(700); } seal = await F.seal(c, ownerIdx, id, salt, art.code, false); log(`SIG TEE Seal of the strategy whose registry is not delegated: ${seal.sig} ${seal.err ? "FAILED " + JSON.stringify(seal.err) : "ok"}`);
  check("observed: Seal ACCEPTS a strategy whose registry was never delegated (it only reads the registry), so Enter is where it must be stopped", !seal.err && (await hub()) === hs - 20_000);
  const ownerBal = await F.bal(c, ownerIdx);
  { const r = await tee("Enter with the undelegated registry writable, as the client builds it (probe)", F.enterIx(c, sid, ownerIdx, id), [O, owner]); check("the rollup refuses Enter for a non-delegated registry (InvalidWritableAccount)", !!r.err && JSON.stringify(r.err).includes("InvalidWritableAccount"), JSON.stringify(r.err || "ACCEPTED")); }
  { const ix = F.enterIx(c, sid, ownerIdx, id); ix.keys[ix.keys.length - 1] = K(L.regPda(id), false); refused(await tee("Enter passing that registry read-only instead (probe)", ix, [O, owner]), 9133, "getting round the rollup's rule by passing the registry read-only"); }
  check("neither attempt entered anything: no count, no fee", (await openCount(loose)) === 0 && (await F.bal(c, ownerIdx)) === ownerBal, `count ${await openCount(loose)}, balance ${ownerBal} -> ${await F.bal(c, ownerIdx)}`);
  { const r = await tee("CloseStrategy while the registry is not delegated (probe)", F.closeStrategyIx(c, owner.publicKey, id, await ticketFor(loose)), [O, owner]); check("observed: it cannot be closed either until the registry is delegated", !!r.err, JSON.stringify(r.err || "ACCEPTED")); }
  // control: delegate it, and the very same strategy is accepted. Delegation was the only difference.
  const a = L.delegAccts(L.regPda(id)); const del = await L.sendBase([ixp(2, [K(owner.publicKey, true, true), K(L.SystemProgram.programId), K(L.regPda(id), true), K(L.PROGRAM), K(a.buffer, true), K(a.record, true), K(a.meta, true), K(L.DLP), K(c.validator)], Buffer.concat([Buffer.from([1]), u64(id)]))], [O, owner]); log(`SIG base Delegate that registry: ${del}`);
  { let e; const t0 = Date.now(); for (;;) { e = await F.simErr(c, [F.enterIx(c, sid, ownerIdx, id)], [O, owner]); if (!e || Date.now() - t0 > 90_000) break; await L.sleep(1500); } log(`after delegating, a simulated Enter answers ${e ?? "ok"} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); }
  { const r = await tee("Enter after delegating the registry (control)", F.enterIx(c, sid, ownerIdx, id), [O, owner]); check("once delegated, the same strategy enters", !r.err && (await openCount(loose)) === 1, JSON.stringify(r.err || "ok")); }
  const field = [...olds, loose];
  must(await tee("Lock", F.lockIx(sid)), "Lock"); must(await tee("RequestSeed (season)", F.seedIx(sid)), "RequestSeed"); await driveToEnd(sid, "the season");
  must(await tee("Settle, publishing every entry inline", F.settleIx(c, sid, field.map(e => e.id))), "Settle"); check("published: every count is back to 0, old strategies included", (await counts(field)).every(n => n === 0), `${await counts(field)}`);
  await commitReceiptAndRegs(sid, field); check("the receipt is on base with every entry published", !!(await F.readReceiptBase(sid, field.length)));
  await claimsAndCloseClaims(sid, FEE * field.length, before); must(await tee("Cleanup", F.cleanupIx(c, sid)), "Cleanup"); await releaseBond(sid);
  await retire(olds[0], 20_000); await retire(olds[1], 19_744); await retire(loose, 20_000);
  const H1 = await hub(); check("the hub ends higher by exactly the rent of the two strategies earlier builds had left in it (20,000 + 19,744): they are reclaimed", H1 - H0 === 39_744, `before ${H0}, after ${H1} (+${H1 - H0})`); await finish();
}

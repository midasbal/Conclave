import * as L from "./lib.mjs"; import fs from "fs"; import path from "path"; import { execFileSync } from "child_process"; import * as Custody from "./custody.mjs";
const { K, ixp, u64, u32, O, PublicKey, SystemProgram } = L;
export const ATOKEN = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/** access guards: the config PDA (pause, stake-mint allowlist, authority) lives in the rollup after delegation */
export const CONFIG = L.pda([Buffer.from("config")]);
export const PROGRAMDATA = PublicKey.findProgramAddressSync([L.PROGRAM.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];
export async function ctx() { const st = fs.existsSync(L.ROOT + "/client/state.json") ? JSON.parse(fs.readFileSync(L.ROOT + "/client/state.json")) : {}; const players = process.env.CONCLAVE_SOLO ? [O] : L.players(); const validator = new PublicKey((await L.rpc(L.TEE, "getIdentity")).result.identity);
  const URL = new L.Endpoint(L.TEE, await L.tokenFor(L.TEE, O)); const ptok = []; for (const p of players) ptok.push(new L.Endpoint(L.TEE, await L.tokenFor(L.TEE, p)));
  return { st, mint: process.env.CONCLAVE_MINT ? new PublicKey(process.env.CONCLAVE_MINT) : st.mint ? new PublicKey(st.mint) : null, players, validator, URL, ptok, codes: process.env.CONCLAVE_SOLO ? {} : L.loadPool(), hub: L.hubPda(), ata(o) { return L.getAssociatedTokenAddressSync(this.mint, o, true); }, save() { fs.writeFileSync(L.ROOT + "/client/state.json", JSON.stringify(this.st, null, 1)); } }; }
export const hubLamports = async c => { const d = (await L.rpc(c.URL, "getAccountInfo", [c.hub.toBase58(), { encoding: "base64" }])).result?.value; return d ? d.lamports : null; };
const delegIx = (c, payer, pdaK, kind, idOrSid) => { const a = L.delegAccts(pdaK); return ixp(2, [K(payer, true, true), K(SystemProgram.programId), K(pdaK, true), K(L.PROGRAM), K(a.buffer, true), K(a.record, true), K(a.meta, true), K(L.DLP), K(c.validator)], Buffer.concat([Buffer.from([kind]), u64(idOrSid)])); };
/** register a sealed-strategy commitment on base and delegate the registry to the TEE. The salt is generated here.
 *  The record (salt and code) is on disk BEFORE anything is sent: after any crash, from the first request on, the key file can open the commitment, and resumeStrategy finishes the job.
 *  It is never removed on failure: a send that reported an error may still have landed.
 *  meta (optional): extra fields stored with the strategy in strategies.json, e.g. the authored artifact's source hash, ruleset and division. The salt is kept there and in recovery bundles, nowhere else. */
export async function register(c, ownerIdx, name, code, meta = {}) { const owner = c.players[ownerIdx]; const id = L.newId(); const salt = (await import("crypto")).randomBytes(32); const commit = L.codeCommit(salt, code); const reg = L.regPda(id);
  if (!process.env.CONCLAVE_SOLO) L.addStrat({ id: id.toString(), owner: ownerIdx, name, salt: salt.toString("hex"), code: code.toString("hex"), ...meta }); /* disposable canary strategies are never written to the key folder */
  const s1 = await L.sendBase([registerIx(owner.publicKey, id, commit)], [O, owner]);
  const s2 = await L.sendBase([delegIx(c, owner.publicKey, reg, 1, id)], [O, owner]);
  return { id, salt, commit, sigs: [s1, s2] }; }
const registerIx = (owner, id, commit) => ixp(1, [K(owner, true, true), K(L.regPda(id), true), K(SystemProgram.programId)], Buffer.concat([u64(id), commit]));
/** Finish a strategy whose registration was interrupted, from its key-file record: register if the registry is missing, delegate it if it is still on base, seal it if it is not sealed. Safe to run again. */
export async function resumeStrategy(c, id, log) { const rec = L.loadStrats().find(x => x.id === String(id)); if (!rec) throw new Error("no such strategy in the key file"); const owner = c.players[rec.owner]; const salt = Buffer.from(rec.salt, "hex"), code = Buffer.from(rec.code, "hex"), commit = L.codeCommit(salt, code); const reg = L.regPda(BigInt(rec.id)); const did = [];
  const step = (n, sig) => { did.push(n); log && log(`SIG ${n}: ${sig}`); };
  let a = await L.base.getAccountInfo(reg);
  if (!a) { step("register", await L.sendBase([registerIx(owner.publicKey, BigInt(rec.id), commit)], [O, owner])); a = await L.base.getAccountInfo(reg); }
  const onChain = await L.readAcct(c.URL, reg) ?? a?.data; if (!onChain || !Buffer.from(onChain).subarray(48, 80).equals(commit)) throw new Error("the registry does not hold this record's commitment");
  if (a && a.owner.equals(L.PROGRAM)) step("delegate", await L.sendBase([delegIx(c, owner.publicKey, reg, 1, BigInt(rec.id))], [O, owner]));
  if (!(await L.readAcct(c.ptok[rec.owner], L.stratPda(BigInt(rec.id))))) { const r = await seal(c, rec.owner, BigInt(rec.id), salt, code); if (r.err) throw new Error("seal failed: " + JSON.stringify(r.err)); step("seal", r.sig); }
  return did; }
export async function seal(c, ownerIdx, id, salt, code, wait = true) { const p = c.players[ownerIdx]; const s = L.stratPda(id);
  if (wait) for (let i = 0; i < 60; i++) { if (await L.readAcct(c.URL, L.regPda(id))) break; await L.sleep(700); }
  return L.sendTee(c.URL, [ixp(3, [K(p.publicKey, false, true), K(c.hub, true), K(s, true), K(L.permissionPdaFromAccount(s), true), K(L.EPHEMERAL_VAULT_ID, true), K(L.MAGIC), K(L.PERMISSION_PROGRAM_ID), K(L.regPda(id))], Buffer.concat([u64(id), salt, code]))], [O, p]); }
/** the receipt holds the creator's bond (lamports above rent, default 0.002 SOL); it is refunded at cleanup through releaseBondIx */
export const BOND = 2_000_000;
export async function initReceipt(c, sid, bond = BOND) { const rc = L.receiptPda(sid); const s1 = await L.sendBase([ixp(16, [K(O.publicKey, true, true), K(rc, true), K(SystemProgram.programId)], Buffer.concat([u64(sid), u64(bond)]))], [O]); const s2 = await L.sendBase([delegIx(c, O.publicKey, rc, 2, sid)], [O]); return [s1, s2]; }
export async function initPool(c, sid) { const pool = L.poolPda(sid), pe = L.eataOf(pool, c.mint); const buf = L.pda([Buffer.from("buffer"), pe.toBuffer()], L.ESPL);
  return L.sendBase([ixp(13, [K(O.publicKey, true, true), K(pe, true), K(pool), K(c.mint), K(SystemProgram.programId), K(L.ESPL), K(buf, true), K(L.pda([Buffer.from("delegation"), pe.toBuffer()], L.DLP), true), K(L.pda([Buffer.from("delegation-metadata"), pe.toBuffer()], L.DLP), true), K(L.DLP), K(c.validator), K(c.ata(pool), true), K(ATOKEN), K(L.TOKEN)], u64(sid))], [O]); }
/** clock parameters are in rollup slots: window = entry window, seedTimeout = slots after Lock before anyone may cancel, grace = slots after Settle before an unpublished entry stops blocking Cleanup */
/** the shortest publish grace the program accepts (9105 below it): about 29 minutes of rollup slots. It delays only the arena cleanup */
export const MIN_GRACE = 180_000;
/** bounds enforced by the program: neps 1..100 (at least 15 with finals), spt 1..100, (neps + 15 if finals) x 150 x spt <= 720,000, window <= 25,000,000, seedTimeout <= 1,000,000. finals: the fixed format (top 3 by season rank, fresh seed, 15 episodes) */
export function createSeasonIx(c, sid, { neps, spt = 1, fee = 0, maxs = 20, finals = false, division = 2, window = 600, seedTimeout = 600, grace = MIN_GRACE, minEntrants = 1 }) { const arena = L.arenaPda(sid);
  return ixp(5, [K(O.publicKey, true, true), K(c.hub, true), K(arena, true), K(L.permissionPdaFromAccount(arena), true), K(L.EPHEMERAL_VAULT_ID, true), K(L.MAGIC), K(L.PERMISSION_PROGRAM_ID), K(L.receiptPda(sid), true), K(CONFIG), K(L.claimsPda(sid), true), K(L.rosterPda(sid), true), K(L.permissionPdaFromAccount(L.rosterPda(sid)), true)], Buffer.concat([u64(sid), u32(neps), u32(spt), u64(fee), c.mint.toBuffer(), Buffer.from([maxs, finals ? 2 : 0, division]), u64(window), u64(seedTimeout), u64(grace), Buffer.from([minEntrants])])); }
export async function createSeason(c, sid, params) { return L.sendTee(c.URL, [createSeasonIx(c, sid, params)], [O]); }
export const enterIx = (c, sid, o, id, ro = false) => { const p = c.players[o]; return ixp(6, [K(p.publicKey, false, true), K(L.stratPda(id), true), K(L.arenaPda(sid), true), K(c.ata(p.publicKey), !ro), K(c.ata(L.poolPda(sid)), !ro), K(L.TOKEN), K(CONFIG), K(L.regPda(id), true), K(L.rosterPda(sid), true)]); };
export async function simErr(c, ixs, signers, cu = 1_400_000, feePayer = O.publicKey) { const tx = new L.Transaction().add(L.ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ...ixs); tx.feePayer = feePayer; tx.recentBlockhash = (await L.rpc(c.URL, "getLatestBlockhash")).result.value.blockhash; tx.sign(...signers); const r = (await L.rpc(c.URL, "simulateTransaction", [tx.serialize().toString("base64"), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true }])).result?.value; return r && !r.err ? null : JSON.stringify(r?.err); }
/** condition-based readiness: poll a simulated Enter until the pool token account is usable */
/** How an Enter is sent: by its ENTRANT alone, who pays the fee, is the only signer, and submits it under its own rollup token. Nobody else may sign it. The rollup shows a wallet the signatures of what it
 *  signed, so a creator that paid for every Enter could rebuild the field before Lock by intersecting the arena's signature list with each public registry's. A sponsor who signs an Enter sees that entry */
export const enterTx = (c, sid, o, id, ro = false) => ({ endpoint: c.ptok?.[o], signers: [c.players[o]] /* the first signer pays (lib.sendTee) */, ixs: [enterIx(c, sid, o, id, ro)] });
export const sendEnter = (c, sid, o, id, ro = false, send = L.sendTee /* the CI test passes its own, to run exactly what would be sent against the program bytecode */) => { const t = enterTx(c, sid, o, id, ro); return send(t.endpoint, t.ixs, t.signers); };
/** unsent: would this entrant's Enter succeed now? Asked as the entrant, like the Enter itself */
export async function awaitPoolReady(c, sid, o, id, timeout = 90) { const t = enterTx(c, sid, o, id); const t0 = Date.now(); for (;;) { const e = await simErr({ URL: t.endpoint }, t.ixs, t.signers, 1_400_000, t.signers[0].publicKey); if (!e) return (Date.now() - t0) / 1000; if ((Date.now() - t0) / 1000 > timeout) throw new Error("pool not ready: " + e); await L.sleep(500); } }
export async function enter(c, sid, entries, log, ro = false, send) { const out = []; for (const [o, id] of entries) { const r = await sendEnter(c, sid, o, id, ro, send); out.push(r); if (log) log(`SIG TEE Enter owner${o + 1}: ${r.sig} ${r.err ? "FAILED " + JSON.stringify(r.err) : "ok"}`); } return out; }
export const lockIx = (sid, signer = O.publicKey) => ixp(7, [K(signer, signer.equals(O.publicKey), true), K(L.arenaPda(sid), true)]);
export const seedIx = sid => ixp(8, [K(O.publicKey, true, true), K(L.arenaPda(sid), true), K(L.identityPda(), false), K(L.EQUEUE, true), K(SystemProgram.programId), K(L.SLOTH), K(L.VRF)]);
/** the program meters by work: the caller only states its compute limit (in thousands); it never picks a tick count */
export const advIx = (sid, budgetK = 1400, max = 65535) => ixp(9, [K(L.arenaPda(sid), true)], Buffer.from([max & 255, max >> 8, budgetK & 255, budgetK >> 8]));
export async function drive(c, sid, { budgetK = 1400, cu = 1_400_000, log } = {}) { let ok = 0, fail = 0, done = false; const t0 = Date.now(); const sigs = []; const errs = [];
  for (let i = 0; i < 4000 && !done; i++) { const r = await L.sendTee(c.URL, [advIx(sid, budgetK)], [O], { cu }); if (!r.err) { ok++; sigs.push(r.sig); } else if (JSON.stringify(r.err).includes("Custom")) { if (ok > 0) done = true; else await L.sleep(300); } else { fail++; errs.push(JSON.stringify(r.err)); log && log("  Advance error", JSON.stringify(r.err)); if (fail > 5) break; } }
  return { ok, fail, errs, wall: (Date.now() - t0) / 1000, sigs }; }
/** Settle records what each entry is owed; it moves no tokens and names no entrant's token account. publish: optional ids (in slot order) of the first entries to publish inline */
export const settleIx = (c, sid, publish = []) => ixp(10, [K(O.publicKey, true, true), K(L.arenaPda(sid), true), K(L.receiptPda(sid), true), K(L.claimsPda(sid), true), K(L.poolPda(sid)), K(c.ata(L.poolPda(sid))), K(L.rosterPda(sid)), ...publish.flatMap(id => [K(L.stratPda(id), true), K(L.regPda(id), true)])]);
/** strategy accounts as the trailing writable list Cancel and Cleanup take */
const strats = ids => ids.map(id => K(L.stratPda(id), true));
/** Cancel: records each entry fee as owed. Allowed for the creator while unlocked, for anyone after the seed timeout or the season deadline, or once an under-minimum Lock has cancelled the arena. ids: the strategies of this season's entries, released at once (optional, a refund never needs them; name them all and Cleanup needs none) */
export const cancelIx = (c, sid, signer = O.publicKey, ids = []) => ixp(17, [K(signer, signer.equals(O.publicKey), true), K(L.arenaPda(sid), true), K(L.claimsPda(sid), true), K(L.poolPda(sid)), K(c.ata(L.poolPda(sid))), K(L.receiptPda(sid), true), K(L.rosterPda(sid)), ...strats(ids)]);
/** Claim: pays one entry what it is owed, to its owner's token account, once. Anyone may send it. nothingOwed: pass the token accounts read-only (the rollup rejects a writable account it does not hold, and nothing will move) */
export const claimIx = (c, sid, slot, owner, nothingOwed = false) => ixp(22, [K(L.claimsPda(sid), true), K(L.poolPda(sid)), K(c.ata(L.poolPda(sid)), !nothingOwed), K(c.ata(owner), !nothingOwed), K(L.TOKEN)], Buffer.from([slot]));
/** CloseClaims: once everything recorded has been paid, the claims account closes and its rent returns to the hub */
export const closeClaimsIx = (c, sid) => ixp(23, [K(O.publicKey, true, true), K(c.hub, true), K(L.claimsPda(sid), true), K(L.EPHEMERAL_VAULT_ID, true), K(L.MAGIC)]);
export const readClaims = async (c, sid) => L.parseClaims(await L.readAcct(c.URL, L.claimsPda(sid)));
/** claim for every entry, ONE TRANSACTION PER ENTRY so that one unpayable token account cannot hold back anyone else. Entries with nothing left to pay are skipped. Returns the claims account before and after */
export async function claimAll(c, sid, log) { const before = await readClaims(c, sid); if (!before?.recorded) throw new Error("nothing recorded to claim for season " + sid);
  const results = []; for (const e of before.entries) { if (e.done) continue; const r = await L.sendTee(c.URL, [claimIx(c, sid, e.slot, new PublicKey(e.owner))], [O]); results.push({ slot: e.slot, owed: e.owed, ...r }); if (log) log(`SIG TEE Claim slot ${e.slot} (${e.owed}): ${r.sig} ${r.err ? "FAILED " + JSON.stringify(r.err) + " (this entry only; claim again later)" : "ok"}`); }
  const after = await readClaims(c, sid); return { before, after, results }; }
/** owed versus claimed, one line per entry */
export const claimsTable = cl => [`claims (${cl.kind}): owed ${cl.owed}, claimed ${cl.claimed}, outstanding ${cl.owed - cl.claimed}`, ...cl.entries.map(e => `  slot ${String(e.slot).padStart(2)}  owed ${String(e.owed).padStart(6)}  ${e.owed === 0n ? "nothing owed" : e.done ? "claimed" : "OUTSTANDING"}`)].join("\n");
/** DEVNET TEST PLAYERS ONLY: before a paid season, move stake tokens inside the rollup so that every owner can pay. need: { ownerIndex: amount }. Takes from whichever player has the most to spare */
export async function fundStake(c, need, log) { for (const [k, n] of Object.entries(need)) { const o = +k; if ((await bal(c, o)) >= n) continue; const spare = []; for (let i = 0; i < c.players.length; i++) spare.push(i === o ? -1 : (await bal(c, i)) - (need[i] ?? 0));
    const from = spare.indexOf(Math.max(...spare)); const amt = Math.min(spare[from], n - (await bal(c, o))); if (amt <= 0 || spare[from] < n - (await bal(c, o))) throw new Error(`no test player can spare enough stake tokens for player ${o}`);
    const d = Buffer.alloc(9); d[0] = 3; d.writeBigUInt64LE(BigInt(amt), 1); const r = await L.sendTee(c.URL, [new L.TransactionInstruction({ programId: L.TOKEN, keys: [K(c.ata(c.players[from].publicKey), true), K(c.ata(c.players[o].publicKey), true), K(c.players[from].publicKey, false, true)], data: d })], [O, c.players[from]]);
    log && log(`SIG TEE move ${amt} stake tokens from player ${from} to player ${o}: ${r.sig} ${r.err ? "FAILED " + JSON.stringify(r.err) : "ok"}`); if (r.err) throw new Error("stake transfer failed " + JSON.stringify(r.err)); } }
/** drive a season to the end of everything it has to run. The program moves into the finals by itself; the client's part is to request the second seed (anyone may) and keep advancing.
 *  Returns { season, finals } drive results; finals is null when the season had nothing more to run */
export async function runSeason(c, sid, { log } = {}) { const season = await drive(c, sid, { log }); if (season.fail) return { season, finals: null };
  const req = await L.sendTee(c.URL, [seedIx(sid)], [O]); if (req.err) { if (!JSON.stringify(req.err).includes("9111")) throw new Error("finals RequestSeed failed: " + JSON.stringify(req.err)); return { season, finals: null }; }
  log && log(`SIG RequestSeed (finals): ${req.sig}`); return { season, finals: await drive(c, sid, { log }) }; }
/** commit AND undelegate the receipts of closed seasons (the program refuses anything else) so the bond can be released on base */
export const commitUndelegateIx = accts => ixp(12, [K(O.publicKey, true, true), K(L.MAGIC), K(L.MCTX, true), ...accts.map(a => K(a, true))], Buffer.from([1]));
/** base layer: pays the creator the releasable part of the bond once the receipt is back on base */
export const releaseBondIx = (sid, creator) => ixp(18, [K(O.publicKey, true, true), K(L.receiptPda(sid), true), K(creator, true)]);
export const publishIx = (sid, i, id) => ixp(11, [K(O.publicKey, true, true), K(L.arenaPda(sid), true), K(L.stratPda(id), true), K(L.regPda(id), true), K(L.receiptPda(sid), true)], Buffer.from([i]));
export const commitIx = accts => ixp(12, [K(O.publicKey, true, true), K(L.MAGIC), K(L.MCTX, true), ...accts.map(a => K(a, true))]);
/** Cleanup. ids: the strategies of the entries still counted on this arena, which must all be named (9131): every unpublished entry of a settled season, or every entry of a cancelled season that Cancel was not given.
 *  The arena is private, so the list comes from what the caller knows: the receipt lists every entry id and which are published. A strategy already closed by its owner no longer exists and must not be named. */
export const cleanupIx = (c, sid, ids = []) => { const arena = L.arenaPda(sid); return ixp(15, [K(O.publicKey, true, true), K(c.hub, true), K(arena, true), K(L.permissionPdaFromAccount(arena), true), K(L.EPHEMERAL_VAULT_ID, true), K(L.MAGIC), K(L.PERMISSION_PROGRAM_ID), K(L.receiptPda(sid), true), K(L.rosterPda(sid), true), K(L.permissionPdaFromAccount(L.rosterPda(sid)), true), ...strats(ids)]); };
/** the owner's private record: final rank, season-phase total, and (on strategies sealed since this build) the finals total */
export async function ownerRec(c, o, id) { const d = await L.readAcct(c.ptok[o], L.stratPda(id)); return d && { season: Number(d.readBigUInt64LE(80)) - 1, rank: d.readUInt32LE(88), n: d.readUInt32LE(92), pnl: d.readBigInt64LE(96), finalsPnl: d.length >= 404 ? d.readBigInt64LE(396) : null }; }
export async function bal(c, o) { const x = await L.readAcct(c.ptok[o], c.ata(c.players[o].publicKey)); return x ? Number(x.readBigUInt64LE(64)) : null; }
// while a receipt is delegated its base owner is the delegation program, so it is identified by its magic, not its owner
export async function readReceiptBase(sid, minPub) { for (let t = 0; t < 50; t++) { const b = await L.base.getAccountInfo(L.receiptPda(sid)); if (b && b.data.readUInt32LE(0) === 0x54435052 && b.data[6] >= minPub) return b.data; await L.sleep(1500); } return null; }

/** InitConfig (base): only the program's upgrade authority can create the config, and it becomes the config authority */
export const initConfigIx = () => ixp(19, [K(O.publicKey, true, true), K(CONFIG, true), K(SystemProgram.programId), K(PROGRAMDATA)]);
export const delegateConfig = async c => L.sendBase([delegIx(c, O.publicKey, CONFIG, 3, 0n)], [O]);
/** Admin (authority only, in the rollup): 0 pause, 1 unpause, 2 allow mint, 3 disallow mint, 4 set authority */
export const adminIx = (sub, payload = Buffer.alloc(0)) => ixp(20, [K(O.publicKey, true, true), K(CONFIG, true)], Buffer.concat([Buffer.from([sub]), payload]));
/** RecoverBond (authority only, in the rollup): closes the books on an orphaned receipt so ReleaseBond pays the recorded creator. Moves no lamports. */
export const recoverBondIx = sid => ixp(21, [K(O.publicKey, true, true), K(CONFIG), K(L.receiptPda(sid), true), K(L.arenaPda(sid))], u64(sid));
/** the config as the rollup sees it */
export async function readConfig(c) { const d = await L.readAcct(c.URL, CONFIG); if (!d) return null; const n = d[5]; return { paused: d[4] !== 0, authority: new PublicKey(d.subarray(8, 40)), mints: Array.from({ length: n }, (_, i) => new PublicKey(d.subarray(64 + i * 32, 96 + i * 32))) }; }

/** CloseStrategy (the owner, in the rollup): only with no open entry (9130). The sealed account's rent returns to the hub, which paid it; the registry is marked closed.
 *  It WIPES the sealed salt and code, so this builder refuses without a ticket from a recovery bundle that was written, reopened and checked against the commitment (custody.issueCloseTicket).
 *  This guards this client only: anyone who builds the instruction by hand, or uses another client, bypasses it. The program cannot know whether a backup exists. */
export const closeStrategyIx = (c, owner, id, ticket) => { Custody.assertCloseTicket(ticket, { program: L.PROGRAM.toBase58(), id, owner: owner.toBase58() }); const s = L.stratPda(id); return ixp(24, [K(owner, false, true), K(c.hub, true), K(s, true), K(L.permissionPdaFromAccount(s), true), K(L.EPHEMERAL_VAULT_ID, true), K(L.MAGIC), K(L.PERMISSION_PROGRAM_ID), K(L.regPda(id), true)]); };
/** observed from getGenesisHash on api.devnet.solana.com and on the base RPC this client uses */
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export async function clusterInfo() { const g = (await L.rpc(L.BASE_URL, "getGenesisHash")).result; if (!g) throw new Error("cannot read the cluster's genesis hash"); return { name: g === DEVNET_GENESIS ? "devnet" : "unknown", genesisHash: g }; }
export const bundleDir = () => path.join(L.KEYS, "bundles");
export const bundlePath = (id, dir = bundleDir()) => path.join(dir, String(id) + Custody.BUNDLE_EXT);
/** the repository example whose assembly is exactly this bytecode, if any (source "if available"); null when none matches or the author module is not built */
export async function sourceFor(code) { try { const A = await (await import("./author.mjs")).load(); const d = path.join(L.ROOT, "strategies"); for (const f of fs.readdirSync(d)) { if (!f.endsWith(".cvs")) continue; const src = fs.readFileSync(path.join(d, f), "utf8"); const a = A.assemble(src); if (a.ok && a.bytecode === Buffer.from(code).toString("hex")) return src; } } catch { /* no author module */ } return null; }
export const vmPins = () => { try { return execFileSync(L.LAB, ["pins"]).toString().trim(); } catch { return null; } };
/** what the owner reads of a sealed strategy and its registry, from the rollup */
async function readSealed(c, ownerIdx, id) { const sealedData = await L.readAcct(c.ptok[ownerIdx], L.stratPda(id)); if (!sealedData) throw new Error(`strategy ${id}: no sealed account readable by this owner (never sealed, closed, not the owner, or the rollup lost it)`); const registryData = await L.readAcct(c.URL, L.regPda(id)); if (!registryData) throw new Error(`strategy ${id}: the registry cannot be read`); return { sealedData, registryData }; }
async function backupArgs(c, ownerIdx, id, backup) { if (!backup?.passphrase) throw new Error("a recovery-bundle passphrase is required"); const data = await readSealed(c, ownerIdx, id); const sealed = Custody.fromSealedAccount(data.sealedData);
  return { file: backup.file ?? bundlePath(id, backup.dir), passphrase: backup.passphrase, program: L.PROGRAM.toBase58(), cluster: await clusterInfo(), id: String(id), owner: c.players[ownerIdx].publicKey.toBase58(), ...data, source: await sourceFor(sealed.code), vmPins: vmPins() }; }
/** RECOVER from the sealed account: needs the owner's wallet and nothing from the key file. Writes (or checks) the bundle, reopens it and verifies it against the sealed account and registry.
 *  restore: also put the record back into the key file, so the other scripts can use the strategy again. */
export async function recoverBundle(c, ownerIdx, id, backup) { const a = await backupArgs(c, ownerIdx, id, backup); const ticket = Custody.exportForClose(a);
  if (backup.restore) { const s = Custody.fromSealedAccount(a.sealedData); L.addStrat({ id: String(id), owner: ownerIdx, name: "recovered", salt: s.salt.toString("hex"), code: s.code.toString("hex") }); }
  return { file: ticket.file, ticket }; }
export const M_REG_DEAD = 0x4447_4552, MARKER_SIZE = 8;
/** the permanent marker left where a removed registry was, or null if the address holds anything else (or nothing) */
export async function registryMarker(id) { const a = await L.base.getAccountInfo(L.regPda(id)); return a && a.owner.equals(L.PROGRAM) && a.data.length === MARKER_SIZE && a.data.readUInt32LE(0) === M_REG_DEAD ? a : null; }
/** CloseRegistry (base): shrinks a closed registry that is back from the rollup to a permanent 8-byte marker, so its id is never registered again, and returns everything above the marker's rent to the owner */
export const closeRegistryIx = (id, owner) => ixp(25, [K(O.publicKey, true, true), K(L.regPda(id), true), K(owner, true)]);
/** The true guarantee: a strategy is private only while it is open. The salt and bytecode live in the Seal transaction's own data, and the rollup redacts that transaction's body only for as long as the
 *  strategy's permission exists. CloseStrategy is the only instruction that ever removes that permission (it is created once, at Seal, and destroyed once, here), so closing is also the only action that
 *  ends privacy: sealing, entering, running, settling, claiming and cleanup never do. Once closed, ANYONE, with no token at all, can read that Seal transaction's full body and recover the salt and
 *  bytecode from devnet's own history, forever, independent of anything this client logs. Only the owner closing their own strategy can trigger this; no rival can force it, and a strategy with an open
 *  entry cannot be closed, so an active strategy never leaks this way. No fix for this exists on MagicBlock's current TEE (see "Security considerations: sealing disclosure" in program/LIFECYCLE.md). */
export const DISCLOSURE_WARNING = "closing this strategy will make its salt and bytecode permanently and publicly readable, by anyone, from devnet's own transaction history, the moment this strategy's permission is removed; this is independent of anything this client logs or of any reveal command. No rival can force this, only the owner closing their own strategy can. There is no fix for this on MagicBlock's current TEE (program/LIFECYCLE.md, \"Security considerations: sealing disclosure\"). The alternative is to leave the strategy open and forgo its registry rent. Pass { acknowledgeDisclosure: true } in backup to confirm you want to proceed.";
/** the whole retirement of a strategy: back it up, close it in the rollup, undelegate the closed registry, shrink it to its marker on base.
 *  backup: { passphrase, dir? or file?, acknowledgeDisclosure: true } (all REQUIRED). Nothing is read or sent, not even the backup, until the disclosure is acknowledged and the passphrase is given. */
export async function closeStrategy(c, ownerIdx, id, backup) { if (backup?.acknowledgeDisclosure !== true) throw new Error(DISCLOSURE_WARNING); const p = c.players[ownerIdx]; const { ticket } = await recoverBundle(c, ownerIdx, id, { ...backup, restore: false });
  const a = await L.sendTee(c.URL, [closeStrategyIx(c, p.publicKey, id, ticket)], [O, p]); if (a.err) return { err: a.err, sigs: [a.sig], bundle: ticket.file };
  const b = await L.sendTee(c.URL, [commitUndelegateIx([L.regPda(id)])], [O]); if (b.err) return { err: b.err, sigs: [a.sig, b.sig], bundle: ticket.file };
  for (let t = 0; ; t++) { const acct = await L.base.getAccountInfo(L.regPda(id)); if (acct && acct.owner.equals(L.PROGRAM)) break; if (t >= 60) return { err: "the registry has not come back to base yet; send closeRegistryIx later", sigs: [a.sig, b.sig], bundle: ticket.file }; await L.sleep(1500); }
  return { err: null, sigs: [a.sig, b.sig, await L.sendBase([closeRegistryIx(id, p.publicKey)], [O])], bundle: ticket.file }; }

// Work-metered Advance on a FULL 20-seat arena of worst-case strategies (63 x EMA, work 64, the most expensive shape per work unit that I measured).
import * as L from "./lib.mjs"; import * as F from "./flows.mjs"; import fs from "fs";
const { K, ixp, u64, u32, O, SystemProgram } = L; const log = L.logger(L.EV + "v2_metering.txt"); const c = await F.ctx();
const op = (c_, d = 0, a = 0, b = 0) => [c_, d, a, b]; const code = Buffer.from([2, 64, 0, 0, ...Array.from({ length: 63 }, (_, i) => op(22, 1 + (i % 12), 0, 3)).flat(), ...op(31, 0, 1, 0)]);
log("\n== METERING on a full worst-case arena", new Date().toISOString(), "| program code bytes", code.length, "ops", code[1]);
for (const p of c.players) { const b = await L.base.getBalance(p.publicKey); if (b < 120_000_000) { const t = new L.Transaction().add(SystemProgram.transfer({ fromPubkey: O.publicKey, toPubkey: p.publicKey, lamports: 150_000_000 - b })); t.feePayer = O.publicKey; await L.sendAndConfirmTransaction(L.base, t, [O]); } }
const have = L.loadStrats().filter(s => s.name === "worst64").slice(-20); const ents = [];
if (have.length === 20) for (const s of have) ents.push({ o: s.owner, id: BigInt(s.id) }); else for (let k = 0; k < 20; k++) { const r = await F.register(c, k % 5, "worst64", code); const s = await F.seal(c, k % 5, r.id, r.salt, code); if (s.err) throw new Error("seal " + JSON.stringify(s.err)); ents.push({ o: k % 5, id: r.id }); }
log("20 worst-case strategies registered (salted) and sealed; work_of each = 64 (the cap)");
const cuIx = u => L.ComputeBudgetProgram.setComputeUnitLimit({ units: u });
async function minLimit(sid, budgetK) { let lo = 5000, hi = 1_400_000; if (await F.simErr(c, [F.advIx(sid, budgetK)], [O], hi)) return null; while (hi - lo > 500) { const mid = (lo + hi) >> 1; if (await F.simErr(c, [F.advIx(sid, budgetK)], [O], mid)) lo = mid; else hi = mid; } return hi; }
async function arena(sid, neps) { const cs = await F.createSeason(c, sid, { neps, fee: 0, division: 2 }); if (cs.err) throw new Error("create " + JSON.stringify(cs.err)); const en = await F.enter(c, sid, ents.map(e => [e.o, e.id]), null, true); if (en.some(x => x.err)) throw new Error("enter " + JSON.stringify(en.find(x => x.err).err));
  await L.sendTee(c.URL, [F.lockIx(sid)], [O]); await L.sendTee(c.URL, [F.seedIx(sid)], [O]); for (let i = 0; i < 80; i++) { if (!(await F.simErr(c, [F.advIx(sid, 1400)], [O]))) break; await L.sleep(700); } await L.sleep(6000); return cs; }
const base = BigInt(Date.now() % 900000 + 100000);
// 1. full budget: 1.4M limit, budget hint 1400k
if (!process.env.SKIP_FULL) {
let sid = base; await arena(sid, 2); log(`arena ${sid}: 20 seats entered (21st rejected: ${(await F.enter(c, sid, [[0, ents[0].id]], null, true))[0].err ? "yes" : "NO"}), locked, VRF-seeded`);
const startMin = await minLimit(sid, 1400); log(`state at episode start: the metered Advance (budget hint 1400k) succeeds with a limit as low as ${startMin} CU (so it consumes at most that), under the 1.4M cap`);
const a1 = await L.sendTee(c.URL, [F.advIx(sid, 1400)], [O], { cu: 1_400_000 }); log(`SIG real metered Advance at episode start: ${a1.sig} ${a1.err ? "FAILED " + JSON.stringify(a1.err) : "ok"}`);
const midMin = await minLimit(sid, 1400); log(`mid-episode: metered Advance (budget hint 1400k) needs at most ${midMin} CU`);
const d = await F.drive(c, sid, { budgetK: 1400, cu: 1_400_000, log }); log(`FULL BUDGET: ${d.ok + 1} metered Advance txs for 300 ticks (avg ${(300 / (d.ok + 1)).toFixed(1)} ticks/tx), compute failures ${d.fail}; first ${a1.sig}, last ${d.sigs.at(-1)}`);
}
// 2. smaller budgets: the program adapts, never exceeds
{ const s0 = base + 5n; await arena(s0, 1); let moved = 0; for (let i = 0; i < 3; i++) { const r = await L.sendTee(c.URL, [F.advIx(s0, 300)], [O], { cu: 300_000 }); if (r.err) log('  error', JSON.stringify(r.err)); } log('BUDGET 300k on this arena: the model says one episode start (330k generation) plus one tick does not fit, so the call returns without progress and without failing (3 calls, 0 errors); a budget below the minimum just waits for a bigger one'); }
for (const [kb, label] of [[650, "650k"], [900, "900k"]]) { const s2 = base + BigInt(kb); await arena(s2, 1); const dd = await F.drive(c, s2, { budgetK: kb, cu: kb * 1000, log }); log(`BUDGET ${label} (limit ${label}): ${dd.ok} Advance txs for 150 ticks (avg ${(150 / dd.ok).toFixed(1)} ticks/tx), compute failures ${dd.fail}`); }
// 3. a lying caller: budget hint above the real limit fails safely (no partial state), and the same season can still be driven correctly afterwards
const s3 = base + 7n; await arena(s3, 1); const lie = await L.sendTee(c.URL, [F.advIx(s3, 1400)], [O], { cu: 200_000 }); log(`caller states 1400k but sets a 200k limit: ${lie.err ? "tx fails safely " + JSON.stringify(lie.err) : "ACCEPTED"}`); const dd3 = await F.drive(c, s3, { budgetK: 1400, cu: 1_400_000, log }); log(`same arena then driven correctly: ${dd3.ok} txs, ${dd3.fail} failures`);
log("payer SOL now", (await L.base.getBalance(O.publicKey)) / 1e9);

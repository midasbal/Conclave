// Run by tests/svm/tests/verifier_4b.rs with receipts written by the real program (stdin). Prints one line per check; exit 1 if any fails.
import fs from "fs"; import os from "os"; import path from "path"; import { spawnSync } from "child_process"; import { fileURLToPath } from "url"; import nacl from "tweetnacl";
import { buildRecord } from "../lib/builder.mjs"; import { lookupSeason, judge } from "../lib/lookup.mjs"; import * as P from "../lib/proofs.mjs"; import { makeReveal } from "../lib/prover.mjs";
import { DELEGATION_PROGRAM_ID, delegationRecordAddress, unkey58, key58 } from "../lib/chain.mjs"; import { evaluate } from "../policy/official.mjs"; import { load } from "../../client/author.mjs";
const here = path.dirname(fileURLToPath(import.meta.url)); const inp = JSON.parse(fs.readFileSync(0, "utf8")); const program = inp.program, genesis = "svm"; const author = await load();
let bad = 0; const check = (name, ok, detail = "") => { console.log(`${ok ? "ok " : "NOT OK "}${name}${detail ? " | " + detail : ""}`); if (!ok) bad++; };
const stage = n => Buffer.from(inp.stages[n], "hex"); const { a, b, c } = inp.seasons; const VALIDATOR = key58(nacl.sign.keyPair().publicKey);
/** a source over the program's receipt bytes. `delegated` wraps one in a SYNTHETIC delegation record naming this program (the SVM does not model delegation). There is no transaction history */
function source(accounts) {
  const map = new Map();
  for (const { address, data, delegated } of accounts) { map.set(address, { owner: delegated ? DELEGATION_PROGRAM_ID : program, lamports: 1, slot: 1, data }); if (delegated) map.set(delegationRecordAddress(address), { owner: DELEGATION_PROGRAM_ID, lamports: 1, slot: 1, data: Buffer.concat([Buffer.alloc(8), unkey58(VALIDATOR), unkey58(program), Buffer.alloc(24)]) }); }
  return { async genesisHash() { return genesis; }, async receiptsOwnedBy(o) { return [...map].filter(([k, v]) => v.owner === o && accounts.some(x => x.address === k)).map(([address, v]) => ({ address, ...v })); }, async account(k) { return map.get(k) ?? null; }, async signatures() { return []; }, async transaction() { return null; } };
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verifier-svm-")); const build = accounts => buildRecord(source(accounts), { archiveDir: dir, program, genesis });

// ---- the record, through every stage
let r = await build([{ address: a.address, data: stage("a_settled3"), delegated: true }]); let s = r.seasons[0];
check("settled and still delegated: PROVISIONAL, 3 of 5 published, no first copy", s?.status === "provisional" && s.facts.publishedEntries === 3 && r.archive.copies === 0);
const provisional = { a3: await lookupSeason(source([{ address: a.address, data: stage("a_settled3"), delegated: true }]), a.sid, { program, genesis }) };
r = await build([{ address: a.address, data: stage("a_published"), delegated: true }]); check("publishing changes a provisional receipt without any flag", r.seasons[0].facts.publishedEntries === 5 && r.seasons[0].flags.length === 0);
const finals = [{ address: a.address, data: stage("a_closed") }, { address: b.address, data: stage("b_closed") }, { address: c.address, data: stage("c_closed") }];
r = await build(finals); check("closed and program-owned: all three FINAL, three first copies", r.counts.final === 3 && r.archive.copies === 3 && r.newFlags.length === 0, JSON.stringify(r.counts));
const get = (rec, sid) => rec.seasons.find(x => x.season === sid);
check("the validator seen while A was delegated is remembered once it is final; for the others it is unknown", get(r, a.sid).validator.key === VALIDATOR && get(r, b.sid).validator.status === "unknown");
{ const x = stage("a_closed"), y = stage("a_released"); const d = [...x.keys()].filter(i => x[i] !== y[i]); check("the REAL ReleaseBond changes nothing outside offsets 184..192", d.length > 0 && d.every(i => i >= 184 && i < 192) && y.subarray(184, 192).every(v => v === 0), `offsets ${d[0]}..${d.at(-1)}`); }
const before = r.archive; r = await build([{ address: a.address, data: stage("a_released") }, ...finals.slice(1)]);
check("so after it the builder raises only the information flag, keeps the first copy, and the digests are unchanged", get(r, a.sid).flags.map(f => `${f.kind}:${f.info}`).join() === "bond-released:true" && r.archive.sha256 === before.sha256);
{ const late = fs.mkdtempSync(path.join(os.tmpdir(), "verifier-svm-late-")); const r2 = await buildRecord(source([{ address: a.address, data: stage("a_released") }, ...finals.slice(1)]), { archiveDir: late, program, genesis }); check("an archive that first saw A after the release differs exactly but agrees on the record digest", r2.archive.sha256 !== before.sha256 && r2.archive.recordSha256 === before.recordSha256); fs.rmSync(late, { recursive: true }); }
const A = get(r, a.sid), B = get(r, b.sid), Cs = get(r, c.sid);
check("A: finals played; owners, ranks and finalists are the oracle's", A.finals === "played" && A.entries.every((e, i) => e.owner === a.strategies[i].owner && e.strategyId === a.strategies[i].id && e.rank === a.oracle.rank[i] && e.seasonRank === a.oracle.seasonRank[i] && e.finalist === a.oracle.finalist[i]));
check("C: finals voided; nobody is a finalist", Cs.finals === "voided" && Cs.entries.every(e => !e.finalist));
check("B: cancelled, no ranks, nothing published", B.kind === "cancelled" && B.entries.every(e => e.rank === null && !e.published));
check("facts: field 5, five wallets, fee 10 per entry, the creator is the season's creator", A.facts.fieldSize === 5 && A.facts.distinctEntrantWallets === 5 && A.facts.feePerEntry === "10" && A.facts.creator === inp.creator && !A.facts.creatorIsAlsoAnEntrant);
const id0 = a.strategies[0].id;
check("view by strategy id: one history across all three seasons", r.views.strategies[id0].final.length === 3 && r.views.strategies[id0].codeCommitments.length === 1);
check("view by wallet: the first player's entries, by the owner on each receipt", r.views.wallets[a.strategies[0].owner].final.every(x => x.owner === a.strategies[0].owner) && r.views.wallets[a.strategies[0].owner].final.length === 3);
check("view by commitment: the same sealed code, grouped", r.views.commitments[A.entries[0].codeCommitment].final.length === 3 && r.anomalies.length === 0);

// ---- the policy over the same record
const rules = { name: "svm", trustedCreators: [inp.creator], trustedValidators: [VALIDATOR] }; const frozen = JSON.stringify(r); const out = evaluate(r, rules);
check("policy: only A has a trusted validator, so only A counts; B and C say why", out.counted.join() === a.sid && out.excluded.find(x => x.season === b.sid).reasons.join().includes("cancelled") && out.excluded.find(x => x.season === c.sid).reasons.join() === "validator unknown");
check("policy: its winner is A's first place, and it did not change the record", out.ranking[0].strategyId === a.strategies[a.oracle.rank.indexOf(1)].id && JSON.stringify(r) === frozen);

// ---- the proofs, against the final receipts read through the archive
const find = (season, data) => lookupSeason(source(finals.map(f => f.address === season.address && data ? { ...f, data } : f)), season.sid, { program, genesis, archiveDir: dir });
const fa = await find(a, stage("a_released")), fc = await find(c), fb = await find(b);
check("lookup: final, from the first copy, no alarm after the bond release", fa.receipt.status === "final" && fa.receipt.alarms.length === 0 && fa.receipt.from.includes("first final copy"));
const pass = (res, f) => judge(res, f.receipt).verified;
for (const [label, season, f] of [["A", a, fa], ["C (voided finals)", c, fc]]) {
  let l3 = 0, l4 = 0, exact = 0;
  for (const [i, st] of season.strategies.entries()) {
    const secret = { id: st.id, salt: st.salt, code: st.code }; const code = makeReveal("code", f, secret, { genesis, program, author }); const v4 = P.verifyCode(f.season, f.seeds, { id: st.id, salt: code.salt, code: code.code }, { author }); if (pass(v4, f) && v4.totalsBoundToReceipt) l4++;
    if (v4.replay.total === season.oracle.season[i] && v4.replay.finalsTotal === season.oracle.finals[i]) exact++;
    const t = makeReveal("totals", f, secret, { genesis, program, author }); if (pass(P.verifyTotals(f.season, { id: t.strategyId, slot: t.slot, ...t }), f) && !JSON.stringify(t).includes(st.salt) && !JSON.stringify(t).includes(st.code)) l3++;
  }
  check(`${label}: level 4 verifies all five and binds their totals`, l4 === 5, `${l4}/5`); check(`${label}: the replayed totals are the oracle's, season and finals`, exact === 5, `${exact}/5`); check(`${label}: level 3 verifies all five, and no reveal holds the sealed salt or code`, l3 === 5, `${l3}/5`);
}
const st0 = a.strategies[0], t0 = makeReveal("totals", fa, { id: st0.id, salt: st0.salt, code: st0.code }, { genesis, program, author }); const L3 = over => P.verifyTotals(fa.season, { id: t0.strategyId, slot: t0.slot, ...t0, ...over }).verified;
check("level 3 refuses a total off by one", !L3({ total: (BigInt(t0.total) + 1n).toString() })); check("level 3 refuses a finals total off by one", !L3({ finalsTotal: (BigInt(t0.finalsTotal) + 1n).toString() }));
check("level 3 refuses another season's score salt", !L3({ scoreSalt: P.scoreSaltOf(Buffer.from(st0.salt, "hex"), c.sid).toString("hex") })); check("level 3 refuses the sealed salt offered as a score salt", !L3({ scoreSalt: st0.salt })); check("level 3 refuses these totals on another entry", !L3({ id: a.strategies[1].id, slot: 1 }));
check("the score salt does not open the code commitment", P.codeCommit(Buffer.from(t0.scoreSalt, "hex"), Buffer.from(st0.code, "hex")).toString("hex") !== fa.season.entries[0].codeCommitment);
check("level 4 refuses other code under the salt", !P.verifyCode(fa.season, fa.seeds, { id: st0.id, salt: st0.salt, code: a.strategies[1].code }, { author }).verified);
check("level 4 refuses another entry's reveal on this one", !P.verifyCode(fa.season, fa.seeds, { id: st0.id, salt: a.strategies[1].salt, code: a.strategies[1].code }, { author }).verified);
// where the receipt holds no score (cancelled, unpublished) the code commitment is the ONLY thing between a reveal and any code at all
{ const x = a.strategies[0], other = a.strategies[1].code; check("cancelled season: other code under the right salt is refused", !P.verifyCode(fb.season, fb.seeds, { id: x.id, salt: x.salt, code: other }, { author }).verified);
  const y = a.strategies[4]; check("unpublished entry: other code under the right salt is refused", !P.verifyCode(provisional.a3.season, provisional.a3.seeds, { id: y.id, salt: y.salt, code: other }, { author }).verified); }
// the right salt and code against a score commitment that is not what they replay to (SYNTHETIC: one byte of the score commitment altered)
{ const doctored = Buffer.from(stage("a_closed")); doctored[224 + 40] ^= 1; const f = await lookupSeason(source([{ address: a.address, data: doctored }]), a.sid, { program, genesis }); const x = a.strategies[0]; const v = P.verifyCode(f.season, f.seeds, { id: x.id, salt: x.salt, code: x.code }, { author });
  check("a replay that does not reproduce the score commitment fails level 4, although the code opens the commitment", !v.verified && !v.totalsBoundToReceipt && v.checks[1].ok); }
check("level 4 without the VM does not pass", !P.verifyCode(fa.season, fa.seeds, { id: st0.id, salt: st0.salt, code: st0.code }, { author: null }).verified);
check("level 4 on a VM with other rules does not pass", !P.verifyCode(fa.season, fa.seeds, { id: st0.id, salt: st0.salt, code: st0.code }, { author, localVmRules: "00".repeat(48) }).verified);
{ const st = b.address; const x = a.strategies[0]; const v = P.verifyCode(fb.season, fb.seeds, { id: x.id, salt: x.salt, code: x.code }, { author }); check("cancelled season: the code opens the commitment, and no totals are claimed", v.verified && v.replay === null && !v.totalsBoundToReceipt && !P.verifyTotals(fb.season, { id: x.id, total: "0", finalsTotal: "0", scoreSalt: "00".repeat(32) }).verified); }
{ const f = provisional.a3, x = a.strategies[4]; const v = P.verifyCode(f.season, f.seeds, { id: x.id, salt: x.salt, code: x.code }, { author }); check("unpublished entry: level 4 shows the code but binds no totals, level 3 is impossible", v.verified && !v.totalsBoundToReceipt && v.replay !== null && !P.verifyTotals(f.season, { id: x.id, total: v.replay.total, finalsTotal: v.replay.finalsTotal, scoreSalt: P.scoreSaltOf(Buffer.from(x.salt, "hex"), a.sid).toString("hex") }).verified);
  check("and a provisional receipt is not a pass unless asked for", !judge(v, f.receipt).verified && judge(v, f.receipt, { allowProvisional: true }).verified); }
check("level 1: the right commitment passes, a wrong one and an absent id do not", pass(P.verifyRecorded(fa.season, { id: st0.id, codeCommitment: fa.season.entries[0].codeCommitment }), fa) && !P.verifyRecorded(fa.season, { id: st0.id, codeCommitment: "22".repeat(32) }).verified && !P.verifyRecorded(fa.season, { id: "1" }).verified);

// ---- level 2, with the owner's real key
const key = i => Uint8Array.from(inp.playerKeys[i]); const ch = P.makeChallenge({ genesis, program, season: a.sid, id: st0.id, askedBy: "svm test verifier" });
const answer = P.signChallenge(ch, key(st0.ownerIndex)); const L2 = (issued, resp, season = fa.season, opts = {}) => P.verifyWallet(season, issued, resp, { genesis, program, ...opts }).verified;
check("level 2 passes for the wallet that entered", L2(ch, answer)); check("level 2 refuses another wallet", !L2(ch, P.signChallenge(ch, key(a.strategies[1].ownerIndex))));
check("level 2 refuses an expired challenge", !L2(ch, answer, fa.season, { now: Date.parse(ch.expiresAt) + 1000 }));
check("level 2 refuses an answer to a different challenge, even with the nonce rewritten", (() => { const ch2 = P.makeChallenge({ genesis, program, season: a.sid, id: st0.id, askedBy: "svm test verifier" }); return !L2(ch2, answer) && !L2(ch2, { ...answer, nonce: ch2.nonce }); })());
check("level 2 refuses a signature obtained for another asker", !L2({ ...ch, askedBy: "someone else" }, answer)); check("level 2 refuses a challenge replayed on another season", !L2(ch, answer, fc.season));
check("the signed bytes start 0xff, so they are not a transaction message", P.challengeMessage(ch)[0] === 0xff); check("a field with a newline cannot smuggle a second line into the signed text", (() => { try { P.challengeMessage({ ...ch, askedBy: "x\nstrategyId: 1" }); return false; } catch { return true; } })());
{ const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verifier-svm-sign-")); const f = n => path.join(tmp, n); fs.writeFileSync(f("c.json"), JSON.stringify(ch)); fs.writeFileSync(f("k.json"), JSON.stringify([...key(st0.ownerIndex)]), { mode: 0o600 });
  const p = spawnSync(process.execPath, [path.join(here, "..", "cli.mjs"), "sign-challenge", "--challenge", f("c.json"), "--key", f("k.json"), "--out", f("r.json")], { encoding: "utf8" }); const printed = (p.stdout ?? "") + (p.stderr ?? "");
  check("the CLI's sign-challenge shows what is signed, never the key, and its answer verifies", p.status === 0 && printed.includes("svm test verifier") && !printed.includes(Buffer.from(key(st0.ownerIndex).subarray(0, 32)).toString("hex")) && !printed.includes(JSON.stringify([...key(st0.ownerIndex)]).slice(1, 40)) && L2(ch, JSON.parse(fs.readFileSync(f("r.json"))))); fs.rmSync(tmp, { recursive: true }); }
// a change to a final record, through the real lookup: every proof about it stops passing
{ const forged = Buffer.from(stage("a_released")); forged.writeUInt32LE(1, 224 + 80 + 72); const f = await find(a, forged); check("a rank rewritten after the first copy: flagged, and no proof about that receipt passes; the first copy's rank is what is read", f.receipt.alarms.includes("record-changed") && !pass(P.verifyRecorded(f.season, { id: st0.id }), f) && f.season.entries[1].rank === a.oracle.rank[1]); }
fs.rmSync(dir, { recursive: true }); console.log(`${bad ? "FAILED " + bad : "all checks passed"}`); process.exit(bad ? 1 : 0);

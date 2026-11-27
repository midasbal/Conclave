// Offline, over REAL devnet responses (test/fixtures, recorded 2026-11-27). Where a test needs something that did not happen on devnet (tampering, a second delegation, a foreign owner), it alters a copy of
// the real bytes or history and says SYNTHETIC. Proofs with secrets are in tests/svm/tests/verifier_4b.rs, because no committed fixture may carry a salt.
import test from "node:test"; import assert from "node:assert/strict"; import fs from "fs"; import os from "os"; import path from "path"; import { fileURLToPath } from "url"; import nacl from "tweetnacl";
import { buildRecord } from "../lib/builder.mjs"; import { classify } from "../lib/receipt.mjs"; import { Archive, compareToFirst } from "../lib/archive.mjs"; import { lookupSeason, judge } from "../lib/lookup.mjs";
import { PROGRAM_ID, DEVNET_GENESIS, DELEGATION_PROGRAM_ID, delegationRecordAddress, receiptAddress, key58, unkey58 } from "../lib/chain.mjs"; import * as P from "../lib/proofs.mjs"; import { assertOutsideRepo } from "../lib/files.mjs";
import { evaluate } from "../policy/official.mjs"; import { replay } from "./recorded.mjs";
const here = path.dirname(fileURLToPath(import.meta.url)); const load = n => JSON.parse(fs.readFileSync(path.join(here, "fixtures", `devnet-${n}.json`)));
const ALL = load("all"); const STAGE = Object.fromEntries(["provisional", "provisional-republished", "final", "bond-released"].map(n => [n, load(n)]));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "verifier-test-")); const clone = x => JSON.parse(JSON.stringify(x));
const build = (tape, dir = tmp()) => buildRecord(replay(tape), { archiveDir: dir });
const example = JSON.parse(fs.readFileSync(path.join(here, "../policy/rules.example.json")));
const unpack = a => a && { owner: a.owner, lamports: a.lamports, slot: a.slot, data: Buffer.from(a.data, "base64") };
let full; const record = async () => (full ??= await build(ALL));
const finalAddress = async () => (await record()).seasons.find(s => s.kind === "settled" && s.finals === "played" && s.status === "final").address;
const flagsOf = (rec, address) => rec.seasons.find(s => s.address === address).flags;

test("every receipt on devnet is classified: format 3 into the record, earlier layouts labelled legacy, the unverifiable one rejected", async () => {
  const r = await record(); assert.deepEqual([r.counts.final, r.counts.provisional, r.counts.legacy, r.counts.rejected], [28, 0, 46, 1]);
  for (const s of r.seasons) { assert.equal(receiptAddress(s.season, PROGRAM_ID), s.address); assert.equal(s.status, "final"); assert.equal(s.validator.status, "observed"); assert.match(s.validator.note, /not recorded on the receipt/); assert.ok(s.createdAt.unixTime > 0); }
  assert.match(r.rejected[0].reason, /address cannot be verified/);
});

test("legacy receipts are labelled and appear in no view", async () => {
  const r = await record(); assert.match(r.legacy.label, /^LEGACY\. Not verified history/); assert.deepEqual([...new Set(r.legacy.receipts.map(x => x.format))].sort(), [1, 2]);
  const inViews = new Set(Object.values(r.views.strategies).flatMap(v => v.final.map(x => x.season))); const official = new Set(r.seasons.map(s => s.season));
  for (const s of inViews) assert.ok(official.has(s)); for (const x of r.legacy.receipts) { assert.equal(x.label, "LEGACY: no recorded owner"); assert.ok(x.entries.every(e => !("owner" in e) && !("rank" in e))); assert.ok(!r.seasons.some(s => s.address === x.address)); }
});

test("the three views hold the same entries, keyed three ways", async () => {
  const r = await record(); const entries = r.seasons.reduce((n, s) => n + s.entries.length, 0);
  for (const view of Object.values(r.views)) assert.equal(Object.values(view).reduce((n, v) => n + v.final.length + v.provisional.length, 0), entries);
  for (const [id, v] of Object.entries(r.views.strategies)) assert.ok(v.final.every(x => x.strategyId === id)); for (const [w, v] of Object.entries(r.views.wallets)) assert.ok(v.final.every(x => x.owner === w));
  for (const [c, v] of Object.entries(r.views.commitments)) assert.ok(v.final.every(x => x.codeCommitment === c)); assert.ok(Object.values(r.views.strategies).some(v => v.final.length > 1), "a strategy with a history");
});

test("a strategy's history follows its id when the owner on a later receipt differs (SYNTHETIC owner: no transfer exists on chain yet)", async () => {
  const { buildViews } = await import("../lib/views.mjs"); const r = await record(); const [id] = Object.entries(r.views.strategies).find(([, v]) => v.final.length > 1);
  const seasons = clone(r.seasons); const last = seasons.filter(s => s.entries.some(e => e.strategyId === id)).at(-1); const e = last.entries.find(e => e.strategyId === id); const before = e.owner; const after = key58(nacl.sign.keyPair().publicKey); e.owner = after;
  const v = buildViews(seasons).views; assert.deepEqual(v.strategies[id].ownersAtEntry.sort(), [before, after].sort()); assert.equal(v.strategies[id].final.length, r.views.strategies[id].final.length); assert.deepEqual(v.wallets[after].final.map(x => x.season), [last.season]);
});

test("raw facts for every season", async () => {
  for (const s of (await record()).seasons) { const f = s.facts; assert.equal(f.fieldSize, s.entries.length); assert.equal(f.distinctEntrantWallets, new Set(s.entries.map(e => e.owner)).size); assert.equal(f.creatorIsAlsoAnEntrant, s.entries.some(e => e.owner === f.creator)); assert.match(f.creator, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    if (f.fieldSize) assert.equal(BigInt(f.feePerEntry) * BigInt(f.fieldSize), BigInt(f.totalOwed)); assert.match(f.feeUnit, /does not name/); }
});

test("one real receipt followed from provisional to final to bond-released", async () => {
  const dir = tmp(); const address = STAGE.provisional.address; const only = async n => build(STAGE[n], dir);
  let r = await only("provisional"); assert.equal(r.seasons[0].status, "provisional"); assert.equal(r.archive.copies, 0); assert.equal(r.seasons[0].facts.publishedEntries, 3); assert.equal(r.seasons[0].validator.sources.length, 2, "history and the live delegation record");
  r = await only("provisional-republished"); assert.equal(r.seasons[0].facts.publishedEntries, 5); assert.deepEqual(r.seasons[0].flags, []);
  r = await only("final"); assert.equal(r.seasons[0].status, "final"); assert.equal(r.counts.firstCopiesSavedNow, 1); const sha = r.seasons[0].copy.sha256;
  r = await only("bond-released"); assert.deepEqual(flagsOf(r, address).map(f => [f.kind, f.info]), [["bond-released", true]]); assert.equal(r.seasons[0].copy.sha256, sha); assert.notEqual(r.seasons[0].current.sha256, sha);
  r = await only("bond-released"); assert.equal(r.counts.flagsRaisedNow, 0); assert.equal(r.counts.firstCopiesSavedNow, 0);
});

test("a late reader gets a different copy, differing only in the released bond, and the same record digest", async () => {
  const early = tmp(), late = tmp(); const a = await build(STAGE.final, early), b = await build(STAGE["bond-released"], late);
  assert.notEqual(a.archive.sha256, b.archive.sha256); assert.equal(a.archive.recordSha256, b.archive.recordSha256); assert.deepEqual(a.seasons[0].entries, b.seasons[0].entries);
});

test("the first copy is never written again", async () => {
  const dir = tmp(); await build(STAGE.final, dir); const ar = new Archive(dir, DEVNET_GENESIS, PROGRAM_ID); const [address] = ar.addresses(); const file = path.join(ar.dirOf(address), "first-final.json"); const bytes = fs.readFileSync(file);
  assert.throws(() => ar.saveFirst(address, { account: unpack(STAGE["bond-released"].accounts[address]), season: "0", observedAt: "later" }), /EEXIST/); await build(STAGE["bond-released"], dir); assert.deepEqual(fs.readFileSync(file), bytes);
});

async function afterFirstCopy(mutate) { const dir = tmp(); const address = await finalAddress(); await build(ALL, dir); const tape = clone(ALL); mutate(tape, address); return { r: await build(tape, dir), dir, address }; }
const edit = (tape, address, f) => { const d = Buffer.from(tape.accounts[address].data, "base64"); f(d); tape.accounts[address].data = d.toString("base64"); };

test("SYNTHETIC tampering: a rewritten rank is flagged, the record keeps the first copy, and the flag stays when the bytes are put back", async () => {
  const rank = 224 + 72; const { r, dir, address } = await afterFirstCopy((t, a) => edit(t, a, d => d.writeUInt32LE((d.readUInt32LE(rank) % 5) + 1, rank)));
  assert.deepEqual(flagsOf(r, address).filter(f => !f.info).map(f => f.kind), ["record-changed"]); const s = r.seasons.find(s => s.address === address); assert.deepEqual(s.entries, (await record()).seasons.find(s => s.address === address).entries);
  assert.ok(evaluate(r, example).excluded.find(x => x.season === s.season).reasons.includes("flagged: record-changed"));
  const back = await build(ALL, dir); assert.deepEqual(flagsOf(back, address).filter(f => !f.info).map(f => f.kind), ["record-changed"]);
});

test("SYNTHETIC: changes to the bond field other than to zero, and any change outside it, are alarms", () => {
  const first = Buffer.from(STAGE.final.accounts[STAGE.final.address].data, "base64"); const at = (i, v) => { const d = Buffer.from(first); d[i] = v ?? (d[i] ^ 1); return { owner: PROGRAM_ID, data: d }; };
  assert.equal(compareToFirst(first, at(184))[0].kind, "record-changed"); for (const i of [0, 144, 183, 192, 224 + 8, 1824, 2463]) assert.equal(compareToFirst(first, at(i))[0].kind, "record-changed", "offset " + i);
});

test("SYNTHETIC: re-delegation is flagged, whether the account is held again or history shows a second delegation", async () => {
  let x = await afterFirstCopy((t, a) => { t.accounts[a].owner = DELEGATION_PROGRAM_ID; t.listed[PROGRAM_ID] = t.listed[PROGRAM_ID].filter(k => k !== a); (t.listed[DELEGATION_PROGRAM_ID] ??= []).push(a); t.accounts[delegationRecordAddress(a)] = { owner: DELEGATION_PROGRAM_ID, lamports: 1, slot: 1, data: Buffer.concat([Buffer.alloc(8), Buffer.alloc(32, 7), unkey58(PROGRAM_ID), Buffer.alloc(24)]).toString("base64") }; });
  assert.ok(flagsOf(x.r, x.address).some(f => f.kind === "redelegated")); assert.equal(x.r.seasons.find(s => s.address === x.address).validator.status, "conflicting");
  // delegated again and back between two builds: only the history can show it. The real delegate transaction is repeated under another signature
  x = await afterFirstCopy((t, a) => { const real = t.signatures[a].find(s => !s.err && t.transactions[s.signature]?.transaction.message.instructions.some(i => i.accounts.length === 9)); const again = "SYNTHETIC" + real.signature.slice(9); t.signatures[a] = [{ ...real, signature: again, slot: real.slot + 1000 }, ...t.signatures[a]]; t.transactions[again] = { ...t.transactions[real.signature], slot: real.slot + 1000 }; });
  assert.ok(flagsOf(x.r, x.address).some(f => f.kind === "multiple-delegations")); assert.ok(evaluate(x.r, example).excluded.some(e => e.reasons.includes("flagged: multiple-delegations")));
  // the same, from a node that no longer has the ORIGINAL delegation: one delegation in its history, but later than the first copy
  const pruned = tmp(); await build(ALL, pruned); const t2 = clone(ALL); const a2 = await finalAddress(); const real2 = t2.signatures[a2].find(s => !s.err && t2.transactions[s.signature]?.transaction.message.instructions.some(i => i.accounts.length === 9)); const late = "SYNTHETIC" + real2.signature.slice(9); const slot2 = t2.accounts[a2].slot + 1000; t2.signatures[a2] = [{ ...real2, signature: late, slot: slot2 }]; t2.transactions[late] = { ...t2.transactions[real2.signature], slot: slot2 };
  const fresh = new Archive(pruned, DEVNET_GENESIS, PROGRAM_ID); fresh.saveSeen(a2, { history: { examined: [], events: [] }, delegationRecords: [] }); const r2 = await build(t2, pruned); assert.deepEqual(flagsOf(r2, a2).filter(f => !f.info).map(f => f.kind), ["redelegated"]);
});

test("SYNTHETIC: an account that disappears is still reported, from the archive", async () => {
  const { r, address } = await afterFirstCopy((t, a) => { t.listed[PROGRAM_ID] = t.listed[PROGRAM_ID].filter(k => k !== a); t.accounts[a] = null; });
  assert.ok(flagsOf(r, address).some(f => f.kind === "account-missing")); assert.equal(r.seasons.find(s => s.address === address).status, "final");
});

test("SYNTHETIC: an edited first copy is not trusted", async () => {
  const dir = tmp(); const address = await finalAddress(); await build(ALL, dir); const file = path.join(dir, DEVNET_GENESIS, PROGRAM_ID, address, "first-final.json"); const j = JSON.parse(fs.readFileSync(file)); const d = Buffer.from(j.data, "base64"); d[300] ^= 1; j.data = d.toString("base64"); fs.writeFileSync(file, JSON.stringify(j));
  const r = await build(ALL, dir); assert.ok(!r.seasons.some(s => s.address === address)); assert.ok(r.rejected.some(x => x.address === address && /damaged/.test(x.reason)));
});

test("SYNTHETIC rejections: foreign owner, wrong address, another program's delegation, no delegation record, inconsistent contents", async () => {
  const address = await finalAddress(); const good = unpack(ALL.accounts[address]); const c = (acc, extra = {}, at = address) => classify(at, acc, { program: PROGRAM_ID, ...extra });
  assert.equal(c(good).class, "final"); assert.match(c({ ...good, owner: "11111111111111111111111111111111" }).reason, /not by the Conclave program/);
  assert.match(c(good, {}, (await record()).seasons.find(s => s.address !== address).address).reason, /not at the receipt address/);
  const held = { ...good, owner: DELEGATION_PROGRAM_ID }; const rec = owner => ({ owner: DELEGATION_PROGRAM_ID, data: Buffer.concat([Buffer.alloc(8), Buffer.alloc(32, 1), unkey58(owner), Buffer.alloc(24)]) });
  assert.match(c(held).reason, /no readable delegation record/); assert.match(c(held, { delegation: rec("11111111111111111111111111111111") }).reason, /for another program/); assert.equal(c(held, { delegation: rec(PROGRAM_ID) }).class, "provisional", "even a closed receipt is provisional while delegated");
  assert.match(c(held, { delegation: { ...rec(PROGRAM_ID), owner: PROGRAM_ID } }).reason, /no readable delegation record/);
  const bad = f => { const d = Buffer.from(good.data); f(d); return c({ ...good, data: d }); };
  assert.equal(bad(d => d[146] = 0).class, "rejected"); assert.equal(bad(d => d[6] = 1).class, "rejected"); assert.equal(bad(d => d[144] = 1).class, "rejected"); assert.equal(bad(d => d.fill(0, 1824, 1856)).class, "rejected"); assert.equal(c({ ...good, data: good.data.subarray(0, 2000) }).class, "rejected");
});

test("history that cannot be read leaves the validator unknown, and such a season is not counted", async () => {
  const tape = clone(STAGE.final); tape.signatures[tape.address] = []; const r = await build(tape); assert.equal(r.seasons[0].validator.status, "unknown"); assert.equal(r.seasons[0].validator.key, null);
  assert.deepEqual(evaluate(r, example).excluded[0].reasons, ["validator unknown"]);
});

test("a wrong cluster is refused", async () => { await assert.rejects(() => buildRecord(replay({ ...ALL, genesis: "11111111111111111111111111111111" }), { archiveDir: tmp() }), /expected/); });

const deepFreeze = o => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
test("policy: counts only trusted creators on trusted validators, leaves the record untouched, and can be re-run with other rules", async () => {
  const r = deepFreeze(clone(await record())); const out = evaluate(r, example); const creator = example.trustedCreators[0].key;
  assert.ok(out.counted.length > 0); for (const id of out.counted) { const s = r.seasons.find(s => s.season === id); assert.equal(s.facts.creator, creator); assert.equal(s.kind, "settled"); assert.ok(s.facts.fieldSize >= 2); }
  assert.equal(out.counted.length + out.excluded.length, r.seasons.length);
  assert.equal(evaluate(r, { trustedCreators: [], trustedValidators: example.trustedValidators.map(v => v.key) }).counted.length, 0); assert.equal(evaluate(r, { trustedCreators: [creator], trustedValidators: [] }).counted.length, 0);
  const others = [...new Set(r.seasons.map(s => s.facts.creator))].filter(c => c !== creator); assert.ok(others.length > 0, "a second creator exists on devnet"); assert.ok(r.seasons.filter(s => s.facts.creator !== creator).every(s => out.excluded.find(x => x.season === s.season).reasons.includes("creator is not on the trusted list")));
  const noVoid = evaluate(r, { ...example, countVoidedFinals: false }); assert.ok(noVoid.counted.length <= out.counted.length);
});

test("policy: sets no wallet or fee minimum and says that counts do not prove a field is real; a misspelt rule is refused", async () => {
  const r = await record(); const out = evaluate(r, example); assert.ok(out.disclaimers.some(d => /None of them proves a field is not one person/.test(d))); assert.ok(out.disclaimers.some(d => /farm/.test(d)));
  assert.throws(() => evaluate(r, { ...example, minWallets: 3 }), /unknown rule/); assert.throws(() => evaluate(r, { ...example, trustedCreator: [] }), /unknown rule/); assert.throws(() => evaluate(r, { trustedCreators: ["*"], trustedValidators: [] }), /not a public key/);
});

test("level 1 on a real devnet receipt, and level 2 refuses a wallet that did not enter", async () => {
  const s = (await record()).seasons.find(s => s.kind === "settled" && s.finals === "played"); const f = await lookupSeason(replay(ALL), s.season, { program: PROGRAM_ID, genesis: DEVNET_GENESIS }); const e = f.season.entries[0];
  assert.ok(judge(P.verifyRecorded(f.season, { id: e.strategyId, codeCommitment: e.codeCommitment }), f.receipt).verified); assert.ok(!P.verifyRecorded(f.season, { id: e.strategyId, codeCommitment: "00".repeat(32) }).verified);
  const ch = P.makeChallenge({ genesis: DEVNET_GENESIS, program: PROGRAM_ID, season: s.season, id: e.strategyId, askedBy: "offline test" }); assert.ok(!P.verifyWallet(f.season, ch, P.signChallenge(ch, nacl.sign.keyPair().secretKey), { genesis: DEVNET_GENESIS, program: PROGRAM_ID }).verified);
});

test("every level states what it does not establish, and level 4 says one reveal does not verify the ranking", () => {
  for (const level of ["recorded", "wallet", "totals", "code"]) assert.ok(P.CLAIMS[level].doesNot.length >= 3, level);
  assert.ok(P.CLAIMS.code.doesNot.some(t => /not the ranking/.test(t) && /every competitor/.test(t))); assert.ok(P.CLAIMS.recorded.doesNot.some(t => /validator/.test(t)));
});

test("a reveal cannot be written inside the repository", () => { assert.throws(() => assertOutsideRepo(path.join(here, "reveal.json")), /inside the repository/); assert.throws(() => assertOutsideRepo(path.join(here, "../../x/y.json")), /inside the repository/); assert.ok(assertOutsideRepo(path.join(os.tmpdir(), "reveal.json"))); });

test("verifying needs no key: no verification module imports a client module that loads one, and nothing in the tool can send a transaction", () => {
  const files = ["cli.mjs", "policy/official.mjs", ...fs.readdirSync(path.join(here, "../lib")).map(f => "lib/" + f)];
  for (const f of files) { const src = fs.readFileSync(path.join(here, "..", f), "utf8"); const imports = [...src.matchAll(/(?:from\s+|import\()\s*"([^"]+client\/[^"]+)"/g)].map(m => path.basename(m[1])); for (const i of imports) assert.ok(["layouts.mjs", "author.mjs", "custody.mjs"].includes(i), `${f} imports client/${i}`); if (imports.includes("custody.mjs")) assert.ok(["cli.mjs", "lib/prover.mjs"].includes(f), "only the owner's reveal commands load bundles"); assert.ok(!/sendTransaction|requestAirdrop/.test(src), f); }
});

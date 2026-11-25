// The season checks (client/campaign_lib.mjs) offline: each check passes on a correct season and fails on a corrupted one. Real hashing, no chain.
import test from "node:test"; import assert from "node:assert/strict"; import crypto from "node:crypto"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), ".."); const C = await import(path.join(root, "client/campaign_lib.mjs")); const { coarseReceipt } = await import(path.join(root, "server/src/receipt.mjs"));
const sha = b => crypto.createHash("sha256").update(b).digest(); const bad = (checks, needle) => assert.ok(checks.some(c => !c.ok && c.name.includes(needle)), `expected a failing check containing "${needle}", got ${JSON.stringify(checks.filter(c => !c.ok).map(c => c.name))}`);

test("ranking follows the program's rule: score descending, ties to the earlier entry", () => {
  assert.deepEqual(C.rankByScore([5n, 9n, -3n, 9n, 0n]), [3, 1, 5, 2, 4]); assert.deepEqual(C.rankByScore([1n]), [1]); assert.deepEqual(C.rankByScore([2n, 2n, 2n]), [1, 2, 3]); assert.deepEqual(C.rankByScore([-5n, -9n]), [1, 2]); });
test("prize split: 100 / 60-40 / 50-30-20 with the remainder on the last paid rank, exact for every pot", () => {
  assert.deepEqual(C.prizeSplit(60, 6), [30n, 18n, 12n]); assert.deepEqual(C.prizeSplit(61, 6), [30n, 18n, 13n]); assert.deepEqual(C.prizeSplit(7, 2), [4n, 3n]); assert.deepEqual(C.prizeSplit(9, 1), [9n]);
  for (let pot = 0; pot < 500; pot++) for (const ns of [1, 2, 3, 4, 6, 20]) assert.equal(C.prizeSplit(pot, ns).reduce((s, x) => s + x, 0n), BigInt(pot)); });
test("percentile places a realised value in a forecast, ties split", () => { assert.equal(C.percentileOf(5, [1, 2, 3, 4]), 100); assert.equal(C.percentileOf(0, [1, 2]), 0); assert.equal(C.percentileOf(2, [1, 2, 2, 3]), 50); assert.ok(Number.isNaN(C.percentileOf(1, []))); });

const field = () => { const ids = [101n, 102n, 103n, 104n, 105n, 106n]; const totals = [40n, -20n, 90n, 90n, 5n, -70n]; const ranks = C.rankByScore(totals);
  return { ids, totals, ranks, entries: ids.map((id, i) => ({ id, owner: ["a", "b", "a", "c", "b", "c"][i], name: "s" + i, onchainTotal: totals[i], localTotal: totals[i], ownerRank: ranks[i], receiptRank: ranks[i] })) }; };
test("score to rank: a correct field passes every check and each corruption is caught", () => {
  const f = field(); assert.ok(C.allOk(C.scoreRankChecks(f.entries)), JSON.stringify(C.scoreRankChecks(f.entries).filter(c => !c.ok)));
  const m = fn => { const e = field().entries.map(x => ({ ...x })); fn(e); return C.scoreRankChecks(e); };
  bad(m(e => { e[0].localTotal += 1n; }), "equals the local replay"); bad(m(e => { [e[0].receiptRank, e[1].receiptRank] = [e[1].receiptRank, e[0].receiptRank]; }), "published rank of every entrant"); bad(m(e => { e[2].ownerRank = 5; }), "owner's private record");
  bad(m(e => { e[0].receiptRank = e[1].receiptRank; }), "1..N, each used once"); bad(m(e => { e[3].receiptRank = 1; e[2].receiptRank = 2; }), "published rank of every entrant"); });
test("payouts: exact and solvent, and every kind of error is caught", () => {
  const f = field(); const fee = 10; const ownersBefore = { a: 100, b: 100, c: 100 }; const prizes = C.prizeSplit(60, 6); const count = { a: 2, b: 2, c: 2 }; const won = { a: 0n, b: 0n, c: 0n }; for (const e of f.entries) won[e.owner] += e.receiptRank <= 3 ? prizes[e.receiptRank - 1] : 0n;
  const ownersAfterEnter = Object.fromEntries(Object.keys(ownersBefore).map(k => [k, ownersBefore[k] - fee * count[k]])); const ownersAfter = Object.fromEntries(Object.keys(ownersBefore).map(k => [k, BigInt(ownersAfterEnter[k]) + won[k]]));
  const args = (over = {}) => ({ fee, entries: f.entries, ownersBefore, ownersAfterEnter, ownersAfter, ...over }); assert.ok(C.allOk(C.payoutChecks(args())), JSON.stringify(C.payoutChecks(args()).filter(c => !c.ok)));
  bad(C.payoutChecks(args({ ownersAfterEnter: { ...ownersAfterEnter, a: ownersAfterEnter.a + 1 } })), "debited exactly fee"); bad(C.payoutChecks(args({ ownersAfter: { ...ownersAfter, a: ownersAfter.a + 1n } })), "credited exactly the prizes"); bad(C.payoutChecks(args({ ownersAfter: { ...ownersAfter, a: ownersAfter.a + 1n } })), "prizes out equal entries in");
  bad(C.payoutChecks(args({ ownersAfter: { ...ownersAfter, a: ownersAfter.a - 1n, b: ownersAfter.b + 1n } })), "credited exactly the prizes"); bad(C.payoutChecks(args({ fee: 11 })), "debited exactly fee"); const swapped = f.entries.map(e => ({ ...e })); [swapped[0].receiptRank, swapped[3].receiptRank] = [swapped[3].receiptRank, swapped[0].receiptRank]; bad(C.payoutChecks(args({ entries: swapped })), "credited exactly the prizes"); });

const seasonFixture = () => { const f = field(); const season = 4242, neps = 12; const secrets = f.ids.map((id, i) => { const code = Buffer.from([2, 3, 0, 0, 2, 0, 4, 0, 21, 0, 0, 4, 31, 0, 0, 0].map((x, k) => (k > 7 ? x : x))); code[8 + 3] = i; const salt = crypto.randomBytes(32); return { id, salt, code, regCommit: C.codeCommit(salt, code), total: f.totals[i] }; });
  const raw = Buffer.alloc(192 + 20 * 80); raw.writeUInt32LE(0x54435052, 0); raw[4] = 0; raw[5] = 6; raw[6] = 6; raw.writeBigUInt64LE(BigInt(season), 8); raw.writeUInt32LE(neps, 32); raw[144] = 2;
  f.ids.forEach((id, i) => { const e = 192 + 80 * i; raw.writeBigUInt64LE(id, e); secrets[i].regCommit.copy(raw, e + 8); C.scoreCommit(secrets[i].salt, season, id, f.totals[i], 0, neps).copy(raw, e + 40); raw.writeUInt32LE(f.ranks[i], e + 72); });
  return { f, season, neps, secrets, raw }; };
test("receipt hygiene: a clean receipt passes, and leaks, mismatches and missing commitments are each caught", () => {
  const { season, neps, secrets, raw } = seasonFixture(); const run = (r, s = secrets) => C.receiptChecks(C.parseReceipt(r), r, s, { season, neps }); assert.ok(C.allOk(run(raw)), JSON.stringify(run(raw).filter(c => !c.ok)));
  const dirty = fn => { const r = Buffer.from(raw); fn(r); return run(r); };
  bad(dirty(r => r.fill(0, 192 + 40, 192 + 72)), "has a score commitment"); bad(dirty(r => { r[192 + 8] ^= 1; }), "equals the public registry's"); bad(dirty(r => secrets[1].code.copy(r, 192 + 80 * 6 + 8)), "no entrant's code");
  bad(dirty(r => secrets[2].salt.copy(r, 192 + 80 * 6 + 8)), "no entrant's code"); bad(dirty(r => sha(secrets[3].code).copy(r, 192 + 80 * 6 + 8)), "no entrant's code"); bad(dirty(r => { r[6] = 5; }), "every entry published");
  bad(dirty(r => C.scoreCommit(Buffer.alloc(32), season, secrets[0].id, secrets[0].total, 0, neps).copy(r, 192 + 40)), "salted hash"); const wrongTotal = secrets.map((s, i) => i === 0 ? { ...s, total: s.total + 1n } : s); bad(run(raw, wrongTotal), "salted hash"); });
test("the public coarse view carries ranks only", () => {
  const { season, secrets, raw } = seasonFixture(); const rc = C.parseReceipt(raw); const coarse = coarseReceipt(raw); assert.ok(C.allOk(C.coarseChecks(coarse, rc, secrets)), JSON.stringify(C.coarseChecks(coarse, rc, secrets).filter(c => !c.ok)));
  const leaky = { ...coarse, entries: coarse.entries.map((e, i) => i === 0 ? { ...e, commit: rc.entries[0].commit.toString("hex") } : e) }; bad(C.coarseChecks(leaky, rc, secrets), "exactly id, rank and wins"); bad(C.coarseChecks({ ...coarse, note: "salt=" + secrets[0].salt.toString("hex") }, rc, secrets), "no commitment");
  assert.equal(coarse.season, String(season)); assert.equal(coarse.state, "closed"); });
test("ranking stability: a field with real skill differences ranks consistently, one without does not", () => {
  const rng = (() => { let x = 12345; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; })();
  const make = skill => Array.from({ length: 400 }, () => C.rankByScore(skill.map(s => BigInt(Math.round((s + (rng() - 0.5) * 4) * 1000)))));
  const skilled = make([5, 3, 1, -1, -3, -5]); const s = C.stability(skilled, [1, 2, 3, 4, 5, 6]); assert.ok(s.spearman > 0.95 && s.pairsAgreeing === s.pairs, JSON.stringify([s.spearman, s.pairsAgreeing]));
  const flat = make([0, 0, 0, 0, 0, 0]); const r = C.stability(flat, [1, 2, 3, 4, 5, 6]); assert.ok(r.meanRank.every(m => Math.abs(m - 3.5) < 0.5), "with no skill every entrant averages the middle rank"); assert.ok(Math.abs(r.dominance[0][1] - 0.5) < 0.1); });
test("campaign_lib never prints and the campaign script never logs the secret fields", () => {
  const secret = /\b(salt|source_sha256|code_sha256|bytecode)\b|\.code\b(?!\.length)|\bcode\b(?!\.length)/; for (const f of ["client/campaign_lib.mjs", "client/campaign.mjs"]) { const p = path.join(root, f); if (!fs.existsSync(p)) continue; const src = fs.readFileSync(p, "utf8"); if (f.endsWith("lib.mjs")) assert.ok(!/console\.|process\.stdout/.test(src), "the library prints nothing");
    src.split("\n").forEach((l, i) => { if (!/\blog\(|\bcheck\(|console\./.test(l)) return; for (const m of l.matchAll(/\$\{([^}]*)\}/g)) assert.ok(!secret.test(m[1]), `${f}:${i + 1} interpolates a secret field: ${m[0]}`); }); } });

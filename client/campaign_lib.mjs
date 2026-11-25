// Checks for a finished season, as pure functions over plain data (no chain, no keys, no printing), so the same code verifies a real devnet season and is tested offline with corrupted inputs.
import crypto from "crypto";
const sha = b => crypto.createHash("sha256").update(b).digest(); const DOM_CODE = Buffer.from("CNCL-CODE-v1"), DOM_SCORE = Buffer.from("CNCL-SCORE-v1");
const named = (name, ok, detail) => ({ name, ok: !!ok, ...(detail ? { detail } : {}) });
export const allOk = checks => checks.every(c => c.ok);

/** the program's rule: total descending, ties to the lower entry slot. ranks are 1-based, in entry order */
export function rankByScore(totals) { const o = totals.map((t, i) => i).sort((a, b) => (totals[b] > totals[a] ? 1 : totals[b] < totals[a] ? -1 : a - b)); const r = Array(totals.length); o.forEach((slot, k) => { r[slot] = k + 1; }); return r; }
/** prize for rank 1, 2, 3 (index 0..2): 1 entrant 100%, 2 entrants 60/40, else 50/30/20; the last paid rank takes the remainder (the program's rule in Settle) */
export function prizeSplit(pot, ns) { const sh = ns === 1 ? [100] : ns === 2 ? [60, 40] : [50, 30, 20]; const np = Math.min(sh.length, ns); const out = []; let paid = 0n; for (let k = 0; k < np; k++) { const amt = k === np - 1 ? BigInt(pot) - paid : BigInt(pot) * BigInt(sh[k]) / 100n; out.push(amt); paid += amt; } return out; }
/** share of a distribution strictly below x plus half of the ties: where a realised value sits in a forecast */
export function percentileOf(x, dist) { if (!dist.length) return NaN; let below = 0, eq = 0; for (const d of dist) { if (d < x) below++; else if (d === x) eq++; } return 100 * (below + eq / 2) / dist.length; }

/** entrant -> deterministic VM score -> published rank. entries: [{ id, owner, name, onchainTotal (BigInt), localTotal (BigInt), ownerRank, receiptRank }] in entry order */
export function scoreRankChecks(entries) {
  const local = entries.map(e => e.localTotal), chain = entries.map(e => e.onchainTotal); const want = rankByScore(chain); const byRank = entries.map((e, i) => ({ ...e, i })).sort((a, b) => a.receiptRank - b.receiptRank);
  return [
    named("every entrant's on-chain season total equals the local replay by the same VM, bit for bit", entries.every((e, i) => chain[i] === local[i])),
    named("the published rank of every entrant equals the rank its score earns (total descending, ties to the earlier entry)", entries.every((e, i) => e.receiptRank === want[i])),
    named("the owner's private record carries the same rank as the public receipt", entries.every(e => e.ownerRank === e.receiptRank)),
    named("ranks are exactly 1..N, each used once", [...entries.map(e => e.receiptRank)].sort((a, b) => a - b).every((r, k) => r === k + 1)),
    named("in rank order the scores never increase (the ranks are the scores, not noise)", byRank.every((e, k) => k === 0 || byRank[k - 1].onchainTotal >= e.onchainTotal)),
    named("the local replay alone, with no chain data, produces the same ranking", rankByScore(local).every((r, i) => r === entries[i].receiptRank)),
  ];
}
/** payouts exact and solvent. The pool's own balance is readable by nobody but the program (no one can authenticate as the pool), so solvency is shown from what IS observable: every owner's token balance
 *  before entering, after entering and after settling, plus the program's own assertions at Settle (bookkeeping == fee x entrants, pool balance >= owed, payouts == pot), which a successful Settle proves.
 *  fee per entry; entries [{owner, receiptRank}] */
export function payoutChecks({ fee, entries, ownersBefore, ownersAfterEnter, ownersAfter }) {
  const ns = entries.length, pot = BigInt(fee) * BigInt(ns), prizes = prizeSplit(pot, ns); const prizeFor = rank => rank >= 1 && rank <= prizes.length ? prizes[rank - 1] : 0n; const keys = [...new Set(entries.map(e => String(e.owner)))];
  const count = {}, won = {}; for (const e of entries) { count[e.owner] = (count[e.owner] ?? 0) + 1; won[e.owner] = (won[e.owner] ?? 0n) + prizeFor(e.receiptRank); }
  const debit = k => BigInt(ownersBefore[k]) - BigInt(ownersAfterEnter[k]), credit = k => BigInt(ownersAfter[k]) - BigInt(ownersAfterEnter[k]); const paidIn = keys.reduce((x, k) => x + debit(k), 0n), paidOut = keys.reduce((x, k) => x + credit(k), 0n);
  return [
    named("entries in: every owner was debited exactly fee x its entries, so the pool took in the pot", keys.every(k => debit(k) === BigInt(fee) * BigInt(count[k])) && paidIn === pot, `paid in ${paidIn} vs pot ${pot}`),
    named("prizes out per the 50/30/20 rule (remainder on the last paid rank) sum to the pot to the unit", prizes.reduce((x, y) => x + y, 0n) === pot),
    named("every owner was credited exactly the prizes of its entries' ranks", keys.every(k => credit(k) === won[k]), JSON.stringify(Object.fromEntries(keys.map(k => [k, `${credit(k)} vs ${won[k]}`])))),
    named("prizes out equal entries in: the pool paid out what it took in, so nothing is over-paid and nothing is stranded", paidOut === paidIn && paidOut === pot, `out ${paidOut}, in ${paidIn}`),
    named("every owner's net change equals prizes won minus fees paid, exactly", keys.every(k => BigInt(ownersAfter[k]) - BigInt(ownersBefore[k]) === won[k] - BigInt(fee) * BigInt(count[k]))),
    named("the field is a closed system: net changes sum to zero", keys.reduce((x, k) => x + BigInt(ownersAfter[k]) - BigInt(ownersBefore[k]), 0n) === 0n),
    named("solvent: no prize is negative or larger than the pot", prizes.every(p => p >= 0n && p <= pot)),
  ];
}
/** full-receipt layout mirror (program/src/lib.rs): header 192 bytes, then 80 per entry (id 8 | code commitment 32 | score commitment 32 | rank u32 | wins u16) */
export function parseReceipt(d) { const n = d[5]; const out = { kind: d[4], ns: n, published: d[6], state: d[144], season: d.readBigUInt64LE(8), neps: d.readUInt32LE(32), seedA: d.readBigUInt64LE(40), seedB: d.readBigUInt64LE(48), entries: [] };
  for (let i = 0; i < n; i++) { const e = 192 + i * 80; out.entries.push({ id: d.readBigUInt64LE(e), commit: d.subarray(e + 8, e + 40), score: d.subarray(e + 40, e + 72), rank: d.readUInt32LE(e + 72), wins: d.readUInt16LE(e + 76) }); } return out; }
export const scoreCommit = (salt, season, id, total, wins, neps) => { const b = (n, f) => { const x = Buffer.alloc(n); f(x); return x; }; return sha(Buffer.concat([DOM_SCORE, Buffer.from(salt), b(8, x => x.writeBigUInt64LE(BigInt(season))), b(8, x => x.writeBigUInt64LE(BigInt(id))), b(8, x => x.writeBigInt64LE(BigInt(total))), b(2, x => x.writeUInt16LE(wins)), b(4, x => x.writeUInt32LE(neps))])); };
export const codeCommit = (salt, code) => sha(Buffer.concat([DOM_CODE, Buffer.from(salt), Buffer.from(code)]));
/** receipt hygiene. rc: parseReceipt output; raw: the receipt bytes; secrets: per entrant { id, salt, code, regCommit (Buffer from the public registry), total (BigInt) } in entry order */
export function receiptChecks(rc, raw, secrets, { season, neps }) {
  const found = n => n.length > 0 && raw.includes(Buffer.from(n)); const windows = (c, n) => { const o = []; for (let i = 0; i + n <= c.length; i++) { const w = c.subarray(i, i + n); if (new Set(w).size > 2) o.push(w); } return o; };
  const unsalted = c => [sha(c), sha(Buffer.concat([DOM_CODE, c])), sha(Buffer.concat([DOM_CODE, Buffer.alloc(32), c])), sha(Buffer.concat([c, DOM_CODE]))];
  return [
    named("the receipt is the season's, closed out with every entry published", rc.season === BigInt(season) && rc.ns === secrets.length && rc.published === secrets.length && rc.neps === neps),
    named("entries are in entry order with the right strategy ids", rc.entries.every((e, i) => e.id === BigInt(secrets[i].id))),
    named("every entry's code commitment equals the public registry's", rc.entries.every((e, i) => e.commit.equals(secrets[i].regCommit))),
    named("every code commitment opens to the sealed code under the owner's salt", rc.entries.every((e, i) => e.commit.equals(codeCommit(secrets[i].salt, secrets[i].code)))),
    named("every entry has a score commitment, and it is the salted hash of (season, id, total, wins, episodes)", rc.entries.every((e, i) => e.score.some(b => b !== 0) && e.score.equals(scoreCommit(secrets[i].salt, season, secrets[i].id, secrets[i].total, e.wins, neps)))),
    named("no score commitment is the unsalted hash of its own plain total, so a published total cannot be guessed by brute force", rc.entries.every((e, i) => !e.score.equals(scoreCommit(Buffer.alloc(32), season, secrets[i].id, secrets[i].total, e.wins, neps)))),
    named("no entrant's code, salt, 8-byte code window or unsalted code hash appears anywhere in the receipt", secrets.every(s => !found(s.code) && !found(s.salt) && !windows(s.code, 8).some(w => found(w)) && !unsalted(s.code).some(h => found(h)))),
  ];
}
/** the public coarse view (server/src/receipt.mjs coarseReceipt output) of the same receipt: ranks only */
export function coarseChecks(coarse, rc, secrets) { const json = JSON.stringify(coarse); const hexes = [...rc.entries.flatMap(e => [e.commit.toString("hex"), e.score.toString("hex")]), ...secrets.flatMap(s => [s.salt.toString("hex"), Buffer.from(s.code).toString("hex")])];
  return [named("the coarse view lists exactly id, rank and wins per entry", coarse.entries.every(e => Object.keys(e).sort().join() === "id,rank,wins") && coarse.entries.length === rc.ns),
    named("the coarse view's ranks are the receipt's ranks", coarse.entries.every((e, i) => BigInt(e.id) === rc.entries[i].id && e.rank === rc.entries[i].rank)),
    named("the coarse view carries no commitment, score hash, salt or code", hexes.every(h => !json.includes(h)) && !/commit|score|salt|code|hash/i.test(json))]; }
/** how stable is the ranking across many independent seasons? seasons: array of rank arrays (1-based, in entry order). Returns mean rank per entrant and the share of pairwise orderings the realised season agrees with */
export function stability(seasonRanks, realised) {
  const n = realised.length, S = seasonRanks.length; const mean = Array(n).fill(0); for (const r of seasonRanks) r.forEach((x, i) => { mean[i] += x / S; });
  const dominance = Array.from({ length: n }, () => Array(n).fill(0)); for (const r of seasonRanks) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j && r[i] < r[j]) dominance[i][j] += 1 / S;
  let agree = 0, pairs = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { pairs++; const moreOften = dominance[i][j] >= dominance[j][i] ? i : j; if ((realised[i] < realised[j] ? i : j) === moreOften) agree++; }
  const order = a => { const o = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0] || x[1] - y[1]); const r = Array(a.length); o.forEach(([, i], k) => { r[i] = k + 1; }); return r; }; const mr = order(mean); const d2 = realised.reduce((s, r, i) => s + (r - mr[i]) ** 2, 0); const spearman = 1 - 6 * d2 / (n * (n * n - 1));
  return { meanRank: mean, dominance, spearman, pairsAgreeing: agree, pairs };
}

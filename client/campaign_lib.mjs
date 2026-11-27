// Checks for a finished season, as pure functions over plain data (no chain, no keys, no printing), so the same code verifies a real devnet season and is tested offline with corrupted inputs.
import crypto from "crypto";
import { parseReceipt, FINALS_EPISODES } from "./layouts.mjs";
export { parseReceipt };
const sha = b => crypto.createHash("sha256").update(b).digest(); const DOM_CODE = Buffer.from("CNCL-CODE-v1"), DOM_SCORE = Buffer.from("CNCL-SCORE-v3"), DOM_SCORE_SALT = Buffer.from("CNCL-SSALT-v1");
const named = (name, ok, detail) => ({ name, ok: !!ok, ...(detail ? { detail } : {}) });
export const allOk = checks => checks.every(c => c.ok);

/** the program's rule: total descending, ties to the lower entry slot. ranks are 1-based, in entry order */
export function rankByScore(totals) { const o = totals.map((t, i) => i).sort((a, b) => (totals[b] > totals[a] ? 1 : totals[b] < totals[a] ? -1 : a - b)); const r = Array(totals.length); o.forEach((slot, k) => { r[slot] = k + 1; }); return r; }
/** prize for rank 1, 2, 3 (index 0..2): 1 entrant 100%, 2 entrants 60/40, else 50/30/20; the last paid rank takes the remainder (the program's rule in Settle) */
export function prizeSplit(pot, ns) { const sh = ns === 1 ? [100] : ns === 2 ? [60, 40] : [50, 30, 20]; const np = Math.min(sh.length, ns); const out = []; let paid = 0n; for (let k = 0; k < np; k++) { const amt = k === np - 1 ? BigInt(pot) - paid : BigInt(pot) * BigInt(sh[k]) / 100n; out.push(amt); paid += amt; } return out; }
/** share of a distribution strictly below x plus half of the ties: where a realised value sits in a forecast */
export function percentileOf(x, dist) { if (!dist.length) return NaN; let below = 0, eq = 0; for (const d of dist) { if (d < x) below++; else if (d === x) eq++; } return 100 * (below + eq / 2) / dist.length; }
/** which entry slots play the finals: the top three by season rank (both, with two entrants; nobody, with one) */
export function qualifiersOf(seasonTotals) { if (seasonTotals.length < 2) return []; const r = rankByScore(seasonTotals); return r.map((x, i) => i).filter(i => r[i] <= 3); }
/** THE PROGRAM'S OUTCOME RULE over replayed totals. season: totals in entry order (BigInt). finals: totals in entry order (0 for non-qualifiers), or null when no finals were played or they were voided.
 *  Final rank is the season rank, except that played finals reorder the qualifiers among themselves by season + finals total, ties to the better season rank. The whole pot is owed 50/30/20 by final rank. */
export function expectedOutcome({ season, finals = null, fee }) {
  const n = season.length, seasonRank = rankByScore(season), finalRank = [...seasonRank]; const finalist = Array(n).fill(false);
  if (finals && n >= 2) { const q = qualifiersOf(season); q.forEach(i => { finalist[i] = true; }); const sum = i => season[i] + finals[i]; [...q].sort((a, b) => (sum(b) > sum(a) ? 1 : sum(b) < sum(a) ? -1 : seasonRank[a] - seasonRank[b])).forEach((i, k) => { finalRank[i] = k + 1; }); }
  const prizes = prizeSplit(BigInt(fee) * BigInt(n), n); return { seasonRank, finalRank, finalist, owed: finalRank.map(r => prizes[r - 1] ?? 0n) }; }
/** owed versus claimed: the claims account against the rule and against the receipt. complete: every claim has been made */
export function claimsChecks(claims, rc, { fee, complete = true }) {
  const pot = BigInt(fee) * BigInt(rc.ns), prizes = prizeSplit(pot, rc.ns), paid = claims.entries.filter(e => e.done).reduce((x, e) => x + e.owed, 0n);
  return [named("the claims account is recorded for this season, one row per entry", claims.recorded && claims.season === rc.season && claims.entries.length === rc.ns),
    named("each entry is owed exactly the prize of its final rank on the receipt", claims.entries.every((e, i) => e.owed === (prizes[rc.entries[i].rank - 1] ?? 0n))),
    named("the amounts owed sum to the pot, and the receipt states the same total", claims.owed === pot && rc.owed === pot && claims.entries.reduce((x, e) => x + e.owed, 0n) === pot),
    named("the claimed total is exactly the sum of the paid entries and never exceeds what is owed", claims.claimed === paid && claims.claimed <= claims.owed),
    ...(complete ? [named("every claim is made: claimed equals owed, nothing outstanding", claims.claimed === claims.owed && claims.entries.every(e => e.done), `claimed ${claims.claimed} of ${claims.owed}`)] : [])]; }

/** entrant -> deterministic VM score -> published ranks. entries: [{ id, owner, name, onchainTotal (BigInt), localTotal (BigInt), ownerRank, receiptRank, receiptSeasonRank? }] in entry order.
 *  finals (when played): { onchain: BigInt[] | null, local: BigInt[] } in entry order, 0 for non-qualifiers; onchain null where the owners' records do not carry it */
export function scoreRankChecks(entries, finals = null) {
  const local = entries.map(e => e.localTotal), chain = entries.map(e => e.onchainTotal); const want = expectedOutcome({ season: chain, finals: finals ? finals.local : null, fee: 0 }); const seasonRankOf = e => e.receiptSeasonRank ?? e.receiptRank;
  const byRank = entries.map((e, i) => ({ ...e, i })).sort((a, b) => seasonRankOf(a) - seasonRankOf(b));
  return [
    named("every entrant's on-chain season total equals the local replay by the same VM, bit for bit", entries.every((e, i) => chain[i] === local[i])),
    ...(finals?.onchain ? [named("every entrant's on-chain finals total equals the local replay of the finals phase, bit for bit", finals.onchain.every((x, i) => x === finals.local[i]))] : []),
    named("the published season rank of every entrant equals the rank its season score earns (total descending, ties to the earlier entry)", entries.every((e, i) => seasonRankOf(e) === want.seasonRank[i])),
    named("the published final rank follows the rule (qualifiers by season + finals total, everyone else keeps the season rank)", entries.every((e, i) => e.receiptRank === want.finalRank[i])),
    named("the owner's private record carries the same final rank as the public receipt", entries.every(e => e.ownerRank === e.receiptRank)),
    named("ranks are exactly 1..N, each used once", [...entries.map(e => e.receiptRank)].sort((a, b) => a - b).every((r, k) => r === k + 1)),
    named("in season rank order the season scores never increase (the ranks are the scores, not noise)", byRank.every((e, k) => k === 0 || byRank[k - 1].onchainTotal >= e.onchainTotal)),
    named("the local replay alone, with no chain data, produces the same final ranking", expectedOutcome({ season: local, finals: finals ? finals.local : null, fee: 0 }).finalRank.every((r, i) => r === entries[i].receiptRank)),
  ];
}
/** payouts exact and solvent. The pool's own balance is readable by nobody but the program (no one can authenticate as the pool), so solvency is shown from what IS observable: every owner's token balance
 *  before entering, after entering and after every claim, plus the program's own assertions: at Settle (bookkeeping == fee x entrants, pool balance >= pot, amounts owed == pot) and at each Claim (pool >= everything unclaimed).
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
export const scoreSalt = (salt, season) => { const x = Buffer.alloc(8); x.writeBigUInt64LE(BigInt(season)); return sha(Buffer.concat([DOM_SCORE_SALT, Buffer.from(salt), x])); };
export const scoreCommit = (salt, season, id, total, finalsTotal, neps, finalsEps) => { const b = (n, f) => { const x = Buffer.alloc(n); f(x); return x; }; return sha(Buffer.concat([DOM_SCORE, scoreSalt(salt, season), b(8, x => x.writeBigUInt64LE(BigInt(season))), b(8, x => x.writeBigUInt64LE(BigInt(id))), b(8, x => x.writeBigInt64LE(BigInt(total))), b(8, x => x.writeBigInt64LE(BigInt(finalsTotal))), b(4, x => x.writeUInt32LE(neps)), b(4, x => x.writeUInt32LE(finalsEps))])); };
export const codeCommit = (salt, code) => sha(Buffer.concat([DOM_CODE, Buffer.from(salt), Buffer.from(code)]));
/** receipt hygiene. rc: parseReceipt output; raw: the receipt bytes; secrets: per entrant { id, salt, code, regCommit (Buffer from the public registry), total (BigInt), finalsTotal? (BigInt, finalists only) } in entry order */
export function receiptChecks(rc, raw, secrets, { season, neps }) {
  const found = n => n.length > 0 && raw.includes(Buffer.from(n)); const windows = (c, n) => { const o = []; for (let i = 0; i + n <= c.length; i++) { const w = c.subarray(i, i + n); if (new Set(w).size > 2) o.push(w); } return o; };
  const unsalted = c => [sha(c), sha(Buffer.concat([DOM_CODE, c])), sha(Buffer.concat([DOM_CODE, Buffer.alloc(32), c])), sha(Buffer.concat([c, DOM_CODE]))];
  const commitOf = (salt, e, i) => scoreCommit(salt, season, secrets[i].id, secrets[i].total, e.finalist ? secrets[i].finalsTotal ?? 0n : 0n, neps, e.finalist ? FINALS_EPISODES : 0);
  return [
    named("the receipt is the season's, closed out with every entry published", rc.season === BigInt(season) && rc.ns === secrets.length && rc.published === secrets.length && rc.neps === neps),
    named("entries are in entry order with the right strategy ids", rc.entries.every((e, i) => e.id === BigInt(secrets[i].id))),
    named("every entry's code commitment equals the public registry's", rc.entries.every((e, i) => e.commit.equals(secrets[i].regCommit))),
    named("every code commitment opens to the sealed code under the owner's salt", rc.entries.every((e, i) => e.commit.equals(codeCommit(secrets[i].salt, secrets[i].code)))),
    named("every entry has a score commitment, and it is the salted hash of (season, id, season total, finals total, episodes, finals episodes)", rc.entries.every((e, i) => e.score.some(b => b !== 0) && e.score.equals(commitOf(secrets[i].salt, e, i)))),
    named("no score commitment is the unsalted hash of its own plain totals, so a published total cannot be guessed by brute force", rc.entries.every((e, i) => !e.score.equals(commitOf(Buffer.alloc(32), e, i)))),
    named("the receipt is format 3 and names, for every entry, the wallet that entered it", rc.format === 3 && rc.entries.every((e, i) => !!e.owner && !!secrets[i].owner && Buffer.from(e.owner).equals(Buffer.from(secrets[i].owner)))),
    named("neither a sealed salt nor a season score salt appears anywhere in the receipt", secrets.every(s => !found(s.salt) && !found(scoreSalt(s.salt, season)))),
    named("no entrant's code, salt, 8-byte code window or unsalted code hash appears anywhere in the receipt", secrets.every(s => !found(s.code) && !found(s.salt) && !windows(s.code, 8).some(w => found(w)) && !unsalted(s.code).some(h => found(h)))),
  ];
}
/** the public coarse view (server/src/receipt.mjs coarseReceipt output) of the same receipt: ranks only */
export function coarseChecks(coarse, rc, secrets) { const json = JSON.stringify(coarse); const hexes = [...rc.entries.flatMap(e => [e.commit.toString("hex"), e.score.toString("hex")]), ...secrets.flatMap(s => [s.salt.toString("hex"), Buffer.from(s.code).toString("hex")])];
  return [named("the coarse view lists exactly id, rank and seasonRank per entry", coarse.entries.every(e => Object.keys(e).sort().join() === "id,rank,seasonRank") && coarse.entries.length === rc.ns),
    named("the coarse view's ranks are the receipt's ranks", coarse.entries.every((e, i) => BigInt(e.id) === rc.entries[i].id && e.rank === rc.entries[i].rank && e.seasonRank === rc.entries[i].seasonRank)),
    named("the coarse view carries no commitment, score hash, salt or code", hexes.every(h => !json.includes(h)) && !/commit|score|salt|code|hash/i.test(json))]; }
/** how stable is the ranking across many independent seasons? seasons: array of rank arrays (1-based, in entry order). Returns mean rank per entrant and the share of pairwise orderings the realised season agrees with */
export function stability(seasonRanks, realised) {
  const n = realised.length, S = seasonRanks.length; const mean = Array(n).fill(0); for (const r of seasonRanks) r.forEach((x, i) => { mean[i] += x / S; });
  const dominance = Array.from({ length: n }, () => Array(n).fill(0)); for (const r of seasonRanks) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j && r[i] < r[j]) dominance[i][j] += 1 / S;
  let agree = 0, pairs = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { pairs++; const moreOften = dominance[i][j] >= dominance[j][i] ? i : j; if ((realised[i] < realised[j] ? i : j) === moreOften) agree++; }
  const order = a => { const o = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0] || x[1] - y[1]); const r = Array(a.length); o.forEach(([, i], k) => { r[i] = k + 1; }); return r; }; const mr = order(mean); const d2 = realised.reduce((s, r, i) => s + (r - mr[i]) ** 2, 0); const spearman = 1 - 6 * d2 / (n * (n * n - 1));
  return { meanRank: mean, dominance, spearman, pairsAgreeing: agree, pairs };
}

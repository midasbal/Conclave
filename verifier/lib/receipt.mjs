// What an account at an address is, as far as the career record is concerned. Strict: anything that is not exactly what the program writes is rejected with the reason, never guessed at.
//
//   final        format 3, written by Settle or Cancel, CLOSED, owned by the Conclave program on base, at the season's own address
//   provisional  the same, but still held by the delegation program (so a validator can still change it). Accepted only with the delegation program's record naming Conclave as the owner
//   empty        a format 3 receipt with no result on it (not yet settled or cancelled)
//   legacy       an earlier layout: it names no owner. Never part of the verified record
//   rejected     everything else
import { parseReceipt, RC_SIZE, RC_FORMAT_AT, RECEIPT_FORMAT, REASONS, FINALS_STATUS, FINALS_EPISODES } from "../../client/layouts.mjs";
import { DELEGATION_PROGRAM_ID, RECEIPT_MAGIC, receiptAddress, key58, sha256 } from "./chain.mjs";

export const RELEASE_FIELD = [184, 192]; // the only bytes the program ever changes on a closed receipt: ReleaseBond sets the releasable lamports to zero
export const LEGACY_SIZES = [1728, 1792, 1824];
const zero = b => b.every(x => x === 0);
const reject = reason => ({ class: "rejected", reason });

/** delegation: the account at the delegation record address ({owner, data}) or null. Layout: 8 bytes of type tag | validator[32] | original owner[32] | ... */
export function readDelegationRecord(rec) { if (!rec || rec.owner !== DELEGATION_PROGRAM_ID || rec.data.length < 72) return null; return { validator: key58(rec.data.subarray(8, 40)), originalOwner: key58(rec.data.subarray(40, 72)) }; }

export function classify(address, account, { program, delegation = null }) {
  if (!account) return reject("no account at this address");
  const delegated = account.owner === DELEGATION_PROGRAM_ID;
  if (account.owner !== program && !delegated) return reject(`owned by ${account.owner}, not by the Conclave program`);
  let held = null;
  if (delegated) { held = readDelegationRecord(delegation); if (!held) return reject("held by the delegation program with no readable delegation record"); if (held.originalOwner !== program) return reject("held by the delegation program for another program"); }
  const d = account.data;
  if (d.length < 128 || !d.subarray(0, 4).equals(RECEIPT_MAGIC)) return reject("not a season receipt");
  const base = { address, delegated, delegatedTo: held?.validator ?? null, sha256: sha256(d).toString("hex"), size: d.length };
  if (LEGACY_SIZES.includes(d.length)) return legacy(base, d, program);
  if (d.length !== RC_SIZE) return reject(`unknown receipt size ${d.length}`);
  if (d[RC_FORMAT_AT] !== RECEIPT_FORMAT) return reject(`a ${RC_SIZE}-byte receipt without format byte ${RECEIPT_FORMAT}`);
  const n = d[5], kind = d[4], state = d[144];
  if (n === 0 && kind !== 2) return { class: "empty", ...base, state };
  if (n > 20 || (kind !== 0 && kind !== 2) || (state !== 1 && state !== 2)) return reject(`impossible header (entries ${n}, kind ${kind}, state ${state})`);
  const R = parseReceipt(d);
  if (receiptAddress(R.season, program) !== address) return reject("not at the receipt address of the season it names");
  if (!delegated && state !== 2) return reject("on base and owned by the program but not closed, which the program does not allow");
  if (zero(R.creator)) return reject("no creator recorded");
  if (R.entries.filter(e => e.published).length !== R.published) return reject("published count does not match the entries");
  if (kind === 2 && (R.published !== 0 || R.entries.some(e => e.rank !== 0))) return reject("a cancelled season with ranks or published results");
  if (kind === 0 && n === 0) return reject("a settled season with no entries");
  for (const [i, e] of R.entries.entries()) {
    if (zero(e.owner) || zero(e.commit)) return reject(`entry ${i} lacks an owner or a code commitment`);
    if (kind === 0 && (e.rank < 1 || e.rank > n)) return reject(`entry ${i} has rank ${e.rank} in a field of ${n}`);
    if (e.published === zero(e.score)) return reject(`entry ${i}: score commitment and published flag disagree`);
    if (e.finalist && (R.finals.status !== 1 || R.finals.neps !== FINALS_EPISODES)) return reject(`entry ${i} is a finalist of finals that were not played`);
  }
  if (n > 0 && R.owed % BigInt(n) !== 0n) return reject("the amount owed is not a whole fee per entry");
  return { class: !delegated && state === 2 ? "final" : "provisional", ...base, receipt: R };
}

function legacy(base, d, program) {
  const R = parseReceipt(d), season = d.readBigUInt64LE(8);
  // a legacy layout is listed only if it sits at the address of a season it names itself
  if (receiptAddress(season, program) !== base.address) return reject("an earlier-layout receipt whose address cannot be verified from its contents");
  return { class: "legacy", ...base, format: R.format, season: season.toString(), entries: R.entries.map(e => ({ id: e.id.toString(), commitment: zero(e.commit) ? null : Buffer.from(e.commit).toString("hex") })) };
}

const hex = b => Buffer.from(b).toString("hex");
/** the public record of one season as JSON-safe plain data. Everything here is read from the receipt's own bytes */
export function seasonFromReceipt(R) {
  const n = R.ns, owners = R.entries.map(e => key58(e.owner));
  const creator = key58(R.creator);
  return {
    season: R.season.toString(), kind: R.kind === 2 ? "cancelled" : "settled", finals: R.kind === 2 ? null : FINALS_STATUS[R.finals.status] ?? "unknown", reason: R.reason ? REASONS[R.reason] ?? "unknown" : null,
    facts: {
      fieldSize: n, distinctEntrantWallets: new Set(owners).size, distinctCodeCommitments: new Set(R.entries.map(e => hex(e.commit))).size, publishedEntries: R.published,
      creator, creatorIsAlsoAnEntrant: owners.includes(creator),
      feePerEntry: n ? (R.owed / BigInt(n)).toString() : null, feeUnit: "base units of a stake token that the receipt does not name", totalOwed: R.owed.toString(), totalRefunded: R.refunded.toString(),
      episodes: R.kind === 2 ? null : R.neps, finalsEpisodes: R.finals.status === 1 ? R.finals.neps : 0, division: R.division, bondLamports: R.bond.toString(), bondForfeitedLamports: R.forfeit.toString(), vmRules: hex(R.pins),
    },
    entries: R.entries.map((e, i) => ({ slot: i, strategyId: e.id.toString(), owner: owners[i], codeCommitment: hex(e.commit), rank: R.kind === 2 ? null : e.rank, seasonRank: R.kind === 2 ? null : e.seasonRank, finalist: e.finalist, published: e.published, scoreCommitment: e.published ? hex(e.score) : null })),
  };
}

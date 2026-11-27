// Coarse, public views of a season receipt and of its claims account (layout mirror of program/src/lib.rs): status, ranks, amounts owed and claimed. No commitments, no per-entry hashes, no wallet addresses.
export const RC_SIZE = 224 + 20 * 80 + 20 * 32;
/** receipts of the previous format: no format byte (146 reads 0) and no owners */
export const RC_SIZE_V2 = 224 + 20 * 80;
/** receipts written by the previous build are shorter and have one rank per entry */
export const RC_SIZE_V1 = 192 + 20 * 80;
const REASONS = ["", "under_minimum", "seed_timeout", "creator", "finals_seed_timeout", "finals_deadline", "finals_too_few_qualifiers", "season_deadline"];
const stateOf = d => ["fresh", "open", "closed"][d[144]] ?? "unknown";
export function coarseReceipt(d) { if (!d || d.length < RC_SIZE_V1 || d.readUInt32LE(0) !== 0x54435052) return null; const n = d[5]; if (n > 20) return null;
  if (d.length < RC_SIZE_V2) { const entries = []; for (let i = 0; i < n; i++) { const e = 192 + i * 80; entries.push({ id: d.readBigUInt64LE(e).toString(), rank: d.readUInt32LE(e + 72), wins: d.readUInt16LE(e + 76) }); }
    return { season: d.readBigUInt64LE(8).toString(), layout: 1, kind: ["ensemble", "finals", "cancelled"][d[4]] ?? "unknown", state: stateOf(d), reason: d[145] ? ["", "under_minimum", "seed_timeout", "creator", "finals_void"][d[145]] ?? "unknown" : null, entrants: n, published: d[6], entries }; }
  const entries = []; for (let i = 0; i < n; i++) { const e = 224 + i * 80; entries.push({ id: d.readBigUInt64LE(e).toString(), rank: d.readUInt32LE(e + 72), seasonRank: d.readUInt16LE(e + 76) }); }
  const cancelled = d[4] === 2;
  const layout = d.length >= RC_SIZE && d[146] === 3 ? 3 : 2; // owners and commitments are on a format 3 receipt, and stay out of this coarse view
  return { season: d.readBigUInt64LE(8).toString(), layout, kind: cancelled ? "cancelled" : "season", state: stateOf(d), reason: d[145] ? REASONS[d[145]] ?? "unknown" : null, finals: cancelled ? null : ["none", "played", "voided"][d[210]] ?? "unknown", owedTotal: d.readBigUInt64LE(216).toString(), entrants: n, published: d[6], entries }; }
/** what each entry slot (receipt order) is owed and whether it has been paid */
export function coarseClaims(d) { if (!d || d.length < 72 || d.readUInt32LE(0) !== 0x534d4c43) return null; const n = d[5]; if (n > 20 || d.length < 72 + n * 48) return null;
  const owed = d.readBigUInt64LE(48), claimed = d.readBigUInt64LE(56); const entries = []; for (let i = 0; i < n; i++) { const e = 72 + i * 48; const amt = d.readBigUInt64LE(e + 32); entries.push({ slot: i, owed: amt.toString(), status: amt === 0n ? "nothing_owed" : d[e + 40] === 1 ? "claimed" : "outstanding" }); }
  return { season: d.readBigUInt64LE(8).toString(), state: d[4] === 1 ? "recorded" : "nothing_recorded", kind: ["none", "payout", "refund"][d[7]] ?? "unknown", owed: owed.toString(), claimed: claimed.toString(), outstanding: (owed - claimed).toString(), entries }; }

// Coarse, public view of a season receipt (layout mirror of program/src/lib.rs): kind, status, ranks. No commitments, no per-entry hashes.
export const RC_SIZE = 192 + 20 * 80;
export function coarseReceipt(d) { if (!d || d.length < RC_SIZE || d.readUInt32LE(0) !== 0x54435052) return null; const n = d[5];
  const kind = ["ensemble", "finals", "cancelled"][d[4]] ?? "unknown"; const state = ["fresh", "open", "closed"][d[144]] ?? "unknown"; const reason = d[145] ? ["", "under_minimum", "seed_timeout", "creator", "finals_void"][d[145]] ?? "unknown" : null;
  const entries = []; for (let i = 0; i < n; i++) { const e = 192 + i * 80; entries.push({ id: d.readBigUInt64LE(e).toString(), rank: d.readUInt32LE(e + 72), wins: d.readUInt16LE(e + 76) }); }
  return { season: d.readBigUInt64LE(8).toString(), kind, state, reason, entrants: n, published: d[6], entries }; }

// Public account layouts (mirror of program/src/lib.rs), pure functions over bytes: shared by the client flows, the season checks and the server.
export const FINALS_EPISODES = 15;
export const FINALS_STATUS = ["none", "played", "voided"];
export const REASONS = ["", "under_minimum", "seed_timeout", "creator", "finals_seed_timeout", "finals_deadline", "finals_too_few_qualifiers", "season_deadline"];
/** receipt sizes by format. 3 (this build): a format byte at 146 and each entry's owner after the entry table. 2: the same without either. 1: the two earlier layouts */
export const RC_SIZE = 224 + 20 * 80 + 20 * 32, RC_V2_SIZE = 224 + 20 * 80, RC_OWNERS = 224 + 20 * 80, RC_FORMAT_AT = 146, RECEIPT_FORMAT = 3;
export const receiptFormat = d => d.length >= RC_SIZE && d[RC_FORMAT_AT] === RECEIPT_FORMAT ? 3 : d.length >= RC_V2_SIZE ? 2 : 1;
/** season receipt of any format. kind 0 settled, 2 cancelled. Each entry carries its frozen season rank and its final rank.
 *  Format 3 also carries, for EVERY entry once Settle or Cancel has run, the owner at entry and the code commitment. Format 2 has no owner (null) and a commitment only for published entries.
 *  Format 1 (1728 or 1792 bytes) has ids, ranks and, for published entries, commitments; nothing else is read from it here. */
export function parseReceipt(d) {
  const format = receiptFormat(d); const n = Math.min(d[5], 20);
  if (format === 1) { const at = d.length >= 192 + 20 * 80 ? 192 : 128; const out = { format, kind: d[4], ns: n, published: d[6], season: d.readBigUInt64LE(8), entries: [] }; for (let i = 0; i < n; i++) { const e = at + i * 80; out.entries.push({ id: d.readBigUInt64LE(e), commit: d.subarray(e + 8, e + 40), score: d.subarray(e + 40, e + 72), rank: d.readUInt32LE(e + 72), owner: null }); } return out; }
  const out = { format, kind: d[4], ns: n, published: d[6], division: d[7], season: d.readBigUInt64LE(8), ruleset: d.readUInt16LE(24), vmVersion: d[26], genVersion: d[27], packs: [d[28], d[29]], neps: d.readUInt32LE(32), seedA: d.readBigUInt64LE(40), seedB: d.readBigUInt64LE(48), pins: d.subarray(56, 104),
    creator: d.subarray(104, 136), bond: d.readBigUInt64LE(136), state: d[144], reason: d[145], refunded: d.readBigUInt64LE(152), rentDrawn: d.readBigUInt64LE(160), rentReclaimed: d.readBigUInt64LE(168), forfeit: d.readBigUInt64LE(176), release: d.readBigUInt64LE(184),
    finals: { seedA: d.readBigUInt64LE(192), seedB: d.readBigUInt64LE(200), packs: [d[208], d[209]], status: d[210], qualifiers: d[211], neps: d.readUInt32LE(212) }, owed: d.readBigUInt64LE(216), entries: [] };
  for (let i = 0; i < n; i++) { const e = 224 + i * 80; out.entries.push({ id: d.readBigUInt64LE(e), commit: d.subarray(e + 8, e + 40), score: d.subarray(e + 40, e + 72), rank: d.readUInt32LE(e + 72), seasonRank: d.readUInt16LE(e + 76), published: d[e + 78] === 1, finalist: d[e + 79] === 1, owner: format === 3 ? d.subarray(RC_OWNERS + i * 32, RC_OWNERS + i * 32 + 32) : null }); }
  return out; }
/** the money fields (104..192) sit at the same offsets in receipts written by the previous build, which are shorter */
export function parseReceiptMoney(d) { return { creator: d.subarray(104, 136), bond: d.readBigUInt64LE(136), state: d[144], reason: d[145], rentDrawn: d.readBigUInt64LE(160), rentReclaimed: d.readBigUInt64LE(168), forfeit: d.readBigUInt64LE(176), release: d.readBigUInt64LE(184) }; }
export const M_CLAIMS = 0x534d4c43;
/** claims account: what each entry is owed and whether it has been paid (an entry owed nothing is born done) */
export function parseClaims(d) { if (!d || d.length < 72 || d.readUInt32LE(0) !== M_CLAIMS) return null; const n = Math.min(d[5], Math.floor((d.length - 72) / 48));
  const out = { recorded: d[4] === 1, n, kind: d[7] === 2 ? "refund" : d[7] === 1 ? "payout" : "none", season: d.readBigUInt64LE(8), mint: d.subarray(16, 48), owed: d.readBigUInt64LE(48), claimed: d.readBigUInt64LE(56), entries: [] };
  for (let i = 0; i < n; i++) { const e = 72 + i * 48; out.entries.push({ slot: i, owner: d.subarray(e, e + 32), owed: d.readBigUInt64LE(e + 32), done: d[e + 40] === 1 }); } return out; }
// ---- the season's public terms record (ephemeral, no permission, PDA ["terms", season]): what CreateSeason fixed, readable by anyone BEFORE they pay ----
// 0 magic | 4 version u8 (1) | 8 season u64 | 16 creator[32] | 48 mint[32] | 80 fee u64 | 88 episodes u32 | 92 slots per tick u32 | 96 entry window u64 | 104 seed timeout u64 | 112 publish grace u64
// | 120 seats u8 | 121 minimum entrants u8 | 122 flags u8 (2 = finals) | 123 division u8 | 128 ruleset pins[48] | 176 hub rent drawn u64 (not part of the hash). 184 bytes.
import { createHash } from "node:crypto";
export const M_TERMS = 0x4d524554, TERMS_SIZE = 184, TERMS_VERSION = 1, TERMS_HASH_FROM = 4, TERMS_HASH_TO = 176, TERMS_DOMAIN = "CNCL-TERMS-v1";
/** the 32-byte hash an entrant sends to Enter: sha256("CNCL-TERMS-v1" || bytes 4..176 of the record). The program recomputes it from the record and refuses any other (9151). Null when the bytes are not a terms record */
export function termsHash(d) { if (!d || d.length < TERMS_SIZE || d.readUInt32LE(0) !== M_TERMS || d[4] !== TERMS_VERSION) return null; return createHash("sha256").update(TERMS_DOMAIN).update(d.subarray(TERMS_HASH_FROM, TERMS_HASH_TO)).digest(); }
export function parseTerms(d) { const hash = termsHash(d); if (!hash) return null; return { season: d.readBigUInt64LE(8), creator: d.subarray(16, 48), mint: d.subarray(48, 80), fee: d.readBigUInt64LE(80), episodes: d.readUInt32LE(88), slotsPerTick: d.readUInt32LE(92), entryWindowSlots: d.readBigUInt64LE(96), seedTimeoutSlots: d.readBigUInt64LE(104), publishGraceSlots: d.readBigUInt64LE(112),
  seats: d[120], minEntrants: d[121], finals: (d[122] & 2) !== 0, division: d[123], pins: Buffer.from(d.subarray(128, 176)), hubRent: d.readBigUInt64LE(176), hash }; }

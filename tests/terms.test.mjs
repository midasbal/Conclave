// The season terms record's layout and hash, offline: built here byte by byte from the documented layout (program/LIFECYCLE.md, "Account layouts"), never from the program's own code.
// That the hash equals the program's is shown against the real bytecode in tests/svm/tests/client_flows.rs (the client's termsHash against the record CreateSeason wrote).
import test from "node:test"; import assert from "node:assert/strict"; import crypto from "node:crypto"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), ".."); const { parseTerms, termsHash, TERMS_SIZE, M_TERMS } = await import(path.join(root, "client/layouts.mjs"));
const u64 = v => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; }; const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const creator = Buffer.alloc(32, 0xc1), mint = Buffer.alloc(32, 0xa7), pins = Buffer.from(Array.from({ length: 48 }, (_, i) => i * 3 + 1));
function record({ season = 9001n, fee = 1234n, neps = 17, spt = 3, window = 600n, seedto = 700n, grace = 180_000n, maxs = 9, mins = 2, flags = 2, division = 1, rent = 7808n } = {}) {
  return Buffer.concat([u32(M_TERMS), Buffer.from([1, 0, 0, 0]), u64(season), creator, mint, u64(fee), u32(neps), u32(spt), u64(window), u64(seedto), u64(grace), Buffer.from([maxs, mins, flags, division, 0, 0, 0, 0]), pins, u64(rent)]); }
const hashOf = d => crypto.createHash("sha256").update("CNCL-TERMS-v1").update(d.subarray(4, 176)).digest();

test("a record parses into exactly the terms it states", () => { const d = record(); assert.equal(d.length, TERMS_SIZE); const t = parseTerms(d);
  assert.deepEqual([t.season, t.fee, t.episodes, t.slotsPerTick, t.entryWindowSlots, t.seedTimeoutSlots, t.publishGraceSlots, t.seats, t.minEntrants, t.finals, t.division, t.hubRent], [9001n, 1234n, 17, 3, 600n, 700n, 180000n, 9, 2, true, 1, 7808n]);
  assert.ok(t.creator.equals(creator) && t.mint.equals(mint) && t.pins.equals(pins)); assert.ok(t.hash.equals(hashOf(d)), "the hash is sha256 of the domain and bytes 4..176"); assert.equal(parseTerms(record({ flags: 0 })).finals, false); });
test("the hash covers every term and nothing else", () => { const d = record(); const h = termsHash(d);
  assert.ok(termsHash(record({ rent: 1n })).equals(h), "the hub rent field is outside the hash");
  for (const [what, alt] of [["season", { season: 9002n }], ["fee", { fee: 1235n }], ["episodes", { neps: 18 }], ["pace", { spt: 4 }], ["window", { window: 601n }], ["seed timeout", { seedto: 701n }], ["grace", { grace: 180_001n }], ["seats", { maxs: 10 }], ["minimum", { mins: 3 }], ["finals", { flags: 0 }], ["division", { division: 2 }]]) assert.ok(!termsHash(record(alt)).equals(h), what);
  for (const off of [16, 40, 48, 79, 128, 150, 175]) { const x = Buffer.from(d); x[off] ^= 1; assert.ok(!termsHash(x).equals(h), "byte " + off); } const y = Buffer.from(d); y[176] ^= 1; assert.ok(termsHash(y).equals(h)); });
test("bytes that are not a terms record are refused, not read", () => { assert.equal(parseTerms(null), null); assert.equal(parseTerms(Buffer.alloc(0)), null); assert.equal(parseTerms(record().subarray(0, 183)), null, "short"); const m = Buffer.from(record()); m[0] ^= 1; assert.equal(parseTerms(m), null, "magic"); const v = Buffer.from(record()); v[4] = 2; assert.equal(parseTerms(v), null, "version");
  assert.equal(termsHash(Buffer.alloc(184)), null); });

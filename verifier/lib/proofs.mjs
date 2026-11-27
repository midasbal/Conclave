// The four proof levels, as pure checks. The verifier ALWAYS takes the receipt from base (or from its own archive), never from the person proving something.
//   1 recorded   this receipt lists this strategy with this code commitment, and these ranks          needs: the receipt only
//   2 wallet     whoever answers can sign with the wallet the receipt records as owner at entry       needs: a signature over a fresh challenge from the verifier
//   3 totals     the entry's published score commitment binds these totals                           needs: that season's score salt and the totals
//   4 code       this bytecode opens the code commitment, and replaying it gives these totals         needs: the sealed salt and the bytecode
import nacl from "tweetnacl"; import crypto from "crypto";
import { sha256, u64le, unkey58 } from "./chain.mjs";

export const FINALS_EPISODES = 15;
export const codeCommit = (salt, code) => sha256("CNCL-CODE-v1", salt, code);
/** derived from the sealed salt, one per season. It does not reveal the sealed salt or open the code commitment */
export const scoreSaltOf = (salt, season) => sha256("CNCL-SSALT-v1", salt, u64le(season));
const i64le = n => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const u32le = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
export const scoreCommit = (scoreSalt, season, id, total, finalsTotal, episodes, finalsEpisodes) => sha256("CNCL-SCORE-v3", scoreSalt, u64le(season), u64le(id), i64le(total), i64le(finalsTotal), u32le(episodes), u32le(finalsEpisodes));

export const CLAIMS = {
  recorded: {
    establishes: ["The receipt at this season's address lists this strategy id, in this slot, with this code commitment, owner, and (for a settled season) these ranks."],
    doesNot: ["It trusts the system: the program, its upgrade authority, the validator the creator chose, and the RPC that served the account. Nothing is re-executed.", "It says nothing about who is showing it to you: receipts are public.", "A commitment does not show what code it commits to, or that the code is original."],
  },
  wallet: {
    establishes: ["At the time of the challenge, whoever answered could obtain a signature from the wallet this receipt records as the owner at entry, over this verifier's fresh challenge."],
    doesNot: ["Not that they wrote the strategy, or know its code.", "Not that the wallet still owns the strategy today.", "Not who they are, or that they hold the key themselves: they could have asked the key holder to sign. Name yourself in the challenge so that the signer sees who is asking.", "It carries no more weight than level 1 about the result itself."],
  },
  totals: {
    establishes: ["The score commitment the receipt holds for this entry binds exactly these season and finals totals, for this season and strategy id."],
    doesNot: ["Not which code produced the totals. The sealed salt and the code commitment stay closed.", "Not that the presenter is the owner: after disclosure, anyone holding the score salt and totals can present them. Add level 2 for the wallet.", "Not that the totals were computed correctly: that rests on the system, as in level 1.", "It says nothing about other seasons: the score salt differs for each.", "Only published entries carry a score commitment."],
  },
  code: {
    establishes: ["This salt and bytecode open the code commitment on the receipt.", "Replaying this bytecode on the receipt's seeds, under this machine's VM, gives totals that the entry's score commitment binds (published entries)."],
    doesNot: ["It verifies THIS entry's result only, not the ranking: ranks and who reached the finals depend on every competitor's totals, which would need every competitor's salt and code.", "Not that the presenter wrote the code or is the owner. The reveal gives the verifier everything: they can seal a copy under a new strategy id and compete with it, and present this same reveal.", "Not that the code is original.", "For an unpublished entry the receipt holds no score commitment, so the replayed totals are bound to nothing on chain."],
  },
};

const HEX32 = /^[0-9a-f]{64}$/;
const int64 = (v, what) => { if (typeof v !== "string" || !/^-?\d{1,19}$/.test(v)) throw new Error(`${what} must be a decimal string`); const n = BigInt(v); if (n < -(1n << 63n) || n >= 1n << 63n) throw new Error(`${what} is out of range`); return n; };
/** the entry a proof is about: by strategy id (the permanent name), and by slot too if given */
export function entryOf(season, { id, slot }) { const found = season.entries.filter(e => e.strategyId === String(id) && (slot === undefined || e.slot === slot)); if (found.length > 1) throw new Error("this id appears more than once on the receipt: name the slot"); return found[0] ?? null; }
const result = (level, checks, extra = {}) => ({ level, verified: checks.every(c => c.ok), checks, ...extra, ...CLAIMS[level] });
const named = (name, ok, detail) => ({ name, ok: !!ok, ...(detail ? { detail } : {}) });

export function verifyRecorded(season, { id, slot, codeCommitment }) {
  const e = entryOf(season, { id, slot }); const checks = [named("the receipt lists this strategy id", e)];
  if (e && codeCommitment !== undefined) checks.push(named("with this code commitment", e.codeCommitment === codeCommitment));
  return result("recorded", checks, { entry: e });
}

// ---- level 2 ----
const FIELDS = ["genesis", "program", "season", "strategyId", "askedBy", "nonce", "issuedAt", "expiresAt"];
export function makeChallenge({ genesis, program, season, id, askedBy, now = Date.now(), minutes = 10 }) {
  if (!askedBy || !/^[ -~]{3,120}$/.test(askedBy)) throw new Error("say who is asking: 3 to 120 printable characters");
  return { type: "conclave-wallet-challenge", genesis, program, season: String(season), strategyId: String(id), askedBy, nonce: crypto.randomBytes(32).toString("hex"), issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + minutes * 60_000).toISOString() };
}
/** the exact bytes signed. The leading 0xff keeps them from ever being a valid Solana transaction message, so signing one cannot move anything */
export function challengeMessage(c) {
  if (c.type !== "conclave-wallet-challenge") throw new Error("not a wallet challenge");
  for (const f of FIELDS) if (typeof c[f] !== "string" || !/^[ -~]{1,120}$/.test(c[f])) throw new Error(`challenge field ${f} is missing or not plain text`);
  return Buffer.concat([Buffer.from([0xff]), Buffer.from(["CONCLAVE wallet proof v1", "Signing this shows you control the entering wallet. It is not a transaction.", ...FIELDS.map(f => `${f}: ${c[f]}`)].join("\n"))]);
}
export const signChallenge = (c, secretKey) => ({ type: "conclave-wallet-response", nonce: c.nonce, signature: Buffer.from(nacl.sign.detached(challengeMessage(c), secretKey)).toString("hex") });
/** `issued` is the VERIFIER'S OWN copy of the challenge: nothing the prover sends back is trusted except the signature. Single use is the caller's job (see cli.mjs) */
export function verifyWallet(season, issued, response, { now = Date.now(), genesis, program } = {}) {
  const e = entryOf(season, { id: issued.strategyId });
  const sig = typeof response?.signature === "string" && /^[0-9a-f]{128}$/.test(response.signature) ? Buffer.from(response.signature, "hex") : null;
  const checks = [
    named("the challenge is for this cluster, program and season", issued.genesis === genesis && issued.program === program && issued.season === season.season),
    named("the challenge has not expired", now >= Date.parse(issued.issuedAt) - 60_000 && now <= Date.parse(issued.expiresAt)),
    named("the response answers this challenge", response?.nonce === issued.nonce),
    named("the receipt lists this strategy id", e),
    named("the signature is by the wallet the receipt records as owner at entry", e && sig && nacl.sign.detached.verify(challengeMessage(issued), sig, unkey58(e.owner))),
  ];
  return result("wallet", checks, { entry: e });
}

// ---- level 3 ----
export function verifyTotals(season, { id, slot, total, finalsTotal, scoreSalt }) {
  const e = entryOf(season, { id, slot }); const checks = [named("the receipt lists this strategy id", e), named("the season was played, not cancelled", season.kind === "settled")];
  checks.push(named("the entry was published, so the receipt holds a score commitment", e?.published));
  if (checks.every(c => c.ok)) {
    if (!HEX32.test(scoreSalt ?? "")) throw new Error("scoreSalt must be 32 bytes of hex");
    const t = int64(total, "total"), f = int64(finalsTotal, "finalsTotal");
    checks.push(named("the finals total is zero unless this entry played the finals", e.finalist || f === 0n));
    checks.push(named("the score commitment binds these totals", scoreCommit(Buffer.from(scoreSalt, "hex"), season.season, e.strategyId, t, f, season.facts.episodes, e.finalist ? FINALS_EPISODES : 0).toString("hex") === e.scoreCommitment));
  }
  return result("totals", checks, { entry: e, claimed: { total, finalsTotal } });
}

// ---- level 4 ----
/** seeds: the receipt's own seed words. author: the conclave-vm compiled to WASM (client/author.mjs). localVmRules: this build's VM fingerprint if the native tool is present, else null */
export function verifyCode(season, seeds, { id, slot, salt, code }, { author, localVmRules = null }) {
  const e = entryOf(season, { id, slot }); const checks = [named("the receipt lists this strategy id", e)];
  if (!HEX32.test(salt ?? "") || !/^([0-9a-f]{2}){1,1024}$/.test(code ?? "")) throw new Error("salt must be 32 bytes of hex and code must be hex");
  const s = Buffer.from(salt, "hex"), bytes = Buffer.from(code, "hex");
  checks.push(named("this salt and bytecode open the receipt's code commitment", e && codeCommit(s, bytes).toString("hex") === e.codeCommitment));
  let replay = null, totalsBound = false; const notes = [];
  if (checks.every(c => c.ok)) {
    if (season.kind !== "settled") notes.push("the season was cancelled: there are no seeds and no result to replay");
    else if (!author) checks.push(named("the VM is available to replay with (build the author module: docs/AUTHORING.md)", false));
    else {
      if (localVmRules) checks.push(named("the receipt's VM rules are the ones this machine replays with", localVmRules === season.facts.vmRules)); else notes.push("the VM rules fingerprint was not compared (the native conclave-lab tool is not built)");
      // an entry's run depends only on its own bytecode and the season's worlds, so one strategy replays alone
      const total = author.season([bytes], seeds.seedA, seeds.seedB, season.facts.episodes).totals[0];
      const finalsTotal = e.finalist ? author.season([bytes], seeds.finalsSeedA, seeds.finalsSeedB, FINALS_EPISODES).totals[0] : 0n;
      replay = { total: total.toString(), finalsTotal: finalsTotal.toString() };
      if (e.published) { totalsBound = scoreCommit(scoreSaltOf(s, season.season), season.season, e.strategyId, total, finalsTotal, season.facts.episodes, e.finalist ? FINALS_EPISODES : 0).toString("hex") === e.scoreCommitment; checks.push(named("replaying the bytecode on the receipt's seeds reproduces the score commitment", totalsBound)); }
      else notes.push("never published: the code opens the commitment, but the receipt holds nothing to compare the replayed totals with");
    }
  }
  return result("code", checks, { entry: e, replay, totalsBoundToReceipt: totalsBound, notes });
}
